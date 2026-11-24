//! Edit a remote file with a local text editor and upload it back on every save.
//!
//! Flow: the remote file is downloaded into a private working directory, opened with the
//! system text editor, and the directory is watched. Each save produces a snapshot of the
//! file (read once, then uploaded from that copy, never from the live working file) which is
//! sent back to the server after checking that the remote file did not change in the meantime.
//!
//! Security notes:
//! - Every directory is created `0700` and every file `0600` on Unix, under the app cache dir.
//!   The whole tree is wiped at startup and on exit; a session's directory when it is closed.
//! - The file is always opened with a text editor (`open -t` on macOS, Notepad on Windows,
//!   or an explicit text editor on Linux), never with the default handler of its extension,
//!   so a remote `.sh`, `.command` or `.js` cannot be executed by opening it. Binary files are refused.
//! - The upload destination is the remote path recorded when the session was opened; it is
//!   never derived from the local file name.
//! - Disabled on elevated (sudo) sessions.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex, mpsc};

use crate::error::AppError;
use crate::models::{RemoteFingerprint, TransferProgress};
use crate::provider::StorageProvider;
use crate::session::SessionManager;
use crate::transfer::{TransferHandle, TransferManager};

/// Event carrying a [`LocalEditInfo`] each time a session changes state.
pub const EVENT_STATUS: &str = "local-edit://status";
/// Event carrying the id of a session that was closed.
pub const EVENT_CLOSED: &str = "local-edit://closed";

/// Files above this size are not opened for local editing.
pub const MAX_EDIT_SIZE: u64 = 20 * 1024 * 1024;
/// Quiet period after the last file system event before a save is processed: editors often
/// emit several events (temporary file, rename, metadata) for one save.
const DEBOUNCE: Duration = Duration::from_millis(400);
/// Number of leading bytes inspected to tell text from binary content.
const BINARY_SNIFF_LEN: usize = 8192;
/// Max length, in bytes, of the local file name.
const MAX_LOCAL_NAME_LEN: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalEditStatus {
    /// The local file matches what was last uploaded.
    Synced,
    Uploading,
    /// The remote file changed since it was downloaded: the user must choose.
    Conflict,
    /// The last upload failed (network, permissions, disconnected session...).
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalEditInfo {
    pub id: String,
    pub profile_id: String,
    pub remote_path: String,
    pub file_name: String,
    pub status: LocalEditStatus,
    pub message: Option<String>,
    /// RFC 3339 timestamp of the last successful upload.
    pub last_synced_at: Option<String>,
}

/// User decision for a session in conflict or in error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalEditAction {
    /// Upload the local version even though the remote file changed.
    Overwrite,
    /// Discard local changes and download the current remote version.
    Reload,
    /// Try the upload again (still checking for conflicts).
    Retry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Command {
    FsChanged,
    Action(LocalEditAction),
}

struct SessionHandle {
    info: Arc<StdMutex<LocalEditInfo>>,
    /// Set when the session is closed: the worker stops emitting status events.
    closed: Arc<AtomicBool>,
    tx: mpsc::UnboundedSender<Command>,
    dir: PathBuf,
    editor_path: PathBuf,
    // Kept alive for the duration of the session; dropping it stops the watch.
    _watcher: RecommendedWatcher,
}

/// Registry of local edit sessions (Tauri state).
#[derive(Default)]
pub struct LocalEditManager {
    sessions: Mutex<HashMap<String, SessionHandle>>,
    /// `(profile_id, remote_path)` pairs whose session is being prepared.
    opening: Mutex<HashSet<(String, String)>>,
}

impl LocalEditManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn list(&self) -> Vec<LocalEditInfo> {
        let sessions = self.sessions.lock().await;
        sessions.values().map(|s| snapshot_info(&s.info)).collect()
    }

    pub async fn send(&self, id: &str, action: LocalEditAction) -> Result<(), AppError> {
        let sessions = self.sessions.lock().await;
        let session = sessions
            .get(id)
            .ok_or_else(|| AppError::NotFound(format!("Session d'édition introuvable : {id}")))?;
        session
            .tx
            .send(Command::Action(action))
            .map_err(|_| AppError::NotFound(format!("Session d'édition terminée : {id}")))
    }

    /// Stops a session and deletes its local copy.
    pub async fn close(&self, app: &AppHandle, id: &str) {
        let removed = self.sessions.lock().await.remove(id);
        if let Some(session) = removed {
            finish_session(app, id, session);
        }
    }

    /// Stops every session bound to a profile (used on disconnect).
    pub async fn close_for_profile(&self, app: &AppHandle, profile_id: &str) {
        let removed: Vec<(String, SessionHandle)> = {
            let mut sessions = self.sessions.lock().await;
            let ids: Vec<String> = sessions
                .iter()
                .filter(|(_, s)| snapshot_info(&s.info).profile_id == profile_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| sessions.remove(&id).map(|s| (id, s)))
                .collect()
        };
        for (id, session) in removed {
            finish_session(app, &id, session);
        }
    }

    /// Downloads `remote_path` into a private directory, opens it in a text editor and starts
    /// syncing saves back. Re-opens the editor if the file is already being edited.
    pub async fn open(
        &self,
        app: &AppHandle,
        profile_id: &str,
        remote_path: &str,
    ) -> Result<LocalEditInfo, AppError> {
        let key = (profile_id.to_string(), remote_path.to_string());
        if !self.opening.lock().await.insert(key.clone()) {
            return Err(AppError::Transfer(
                "Ce fichier est déjà en cours d'ouverture.".into(),
            ));
        }
        let result = self.open_inner(app, profile_id, remote_path).await;
        self.opening.lock().await.remove(&key);
        result
    }

    async fn open_inner(
        &self,
        app: &AppHandle,
        profile_id: &str,
        remote_path: &str,
    ) -> Result<LocalEditInfo, AppError> {
        {
            let sessions = self.sessions.lock().await;
            if let Some(existing) = sessions.values().find(|s| {
                let info = snapshot_info(&s.info);
                info.profile_id == profile_id && info.remote_path == remote_path
            }) {
                open_in_text_editor(&existing.editor_path)?;
                return Ok(snapshot_info(&existing.info));
            }
        }

        let provider = app
            .state::<SessionManager>()
            .get_provider(Some(profile_id))
            .await?;
        ensure_not_elevated(provider.as_ref())?;

        let baseline = provider.fingerprint(remote_path).await?;
        if baseline.size > MAX_EDIT_SIZE {
            return Err(AppError::Transfer(format!(
                "Fichier trop volumineux pour l'édition locale (max {} Mo).",
                MAX_EDIT_SIZE / (1024 * 1024)
            )));
        }

        let id = new_session_id();
        let dir = root_dir(app)?.join(&id);
        let result = prepare_session(app, &provider, profile_id, remote_path, &dir, &id).await;
        let (editor_path, content) = match result {
            Ok(v) => v,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(e);
            }
        };

        // The download may have raced with a remote change: the content we hold must match
        // the fingerprint taken before, otherwise a later save would silently overwrite it.
        match provider.fingerprint(remote_path).await {
            Ok(after) if after == baseline => {}
            Ok(_) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(AppError::Transfer(
                    "Le fichier a été modifié sur le serveur pendant le téléchargement, réessayez."
                        .into(),
                ));
            }
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(e);
            }
        }

        let info = Arc::new(StdMutex::new(LocalEditInfo {
            id: id.clone(),
            profile_id: profile_id.to_string(),
            remote_path: remote_path.to_string(),
            file_name: remote_file_name(remote_path).to_string(),
            status: LocalEditStatus::Synced,
            message: None,
            last_synced_at: None,
        }));

        let (tx, rx) = mpsc::unbounded_channel();
        let watcher = match start_watcher(editor_path.parent().unwrap_or(&dir), tx.clone()) {
            Ok(w) => w,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(e);
            }
        };

        let closed = Arc::new(AtomicBool::new(false));
        let worker = Worker {
            app: app.clone(),
            info: info.clone(),
            closed: closed.clone(),
            editor_path: editor_path.clone(),
            snap_dir: dir.join("snap"),
            baseline: Some(baseline),
            last_uploaded: content,
            upload_counter: 0,
        };
        tauri::async_runtime::spawn(worker.run(rx));

        let snapshot = snapshot_info(&info);
        self.sessions.lock().await.insert(
            id.clone(),
            SessionHandle {
                info,
                closed,
                tx,
                dir: dir.clone(),
                editor_path: editor_path.clone(),
                _watcher: watcher,
            },
        );

        if let Err(e) = open_in_text_editor(&editor_path) {
            self.close(app, &id).await;
            return Err(e);
        }
        let _ = app.emit(EVENT_STATUS, &snapshot);
        Ok(snapshot)
    }
}

fn snapshot_info(info: &Arc<StdMutex<LocalEditInfo>>) -> LocalEditInfo {
    info.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Drops a removed session: stops the watcher, ends the worker and deletes the local copy.
fn finish_session(app: &AppHandle, id: &str, session: SessionHandle) {
    let SessionHandle {
        dir,
        tx,
        closed,
        _watcher,
        ..
    } = session;
    closed.store(true, Ordering::SeqCst);
    drop(_watcher);
    // Dropping the last sender ends the worker loop once its current operation completes.
    drop(tx);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = app.emit(EVENT_CLOSED, id);
}

/// Root directory of all local edit sessions.
pub fn root_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Io(format!("Dossier de cache introuvable : {e}")))?;
    Ok(cache.join("local-edit"))
}

/// Deletes every leftover session directory (crash, forced quit...).
pub fn purge_root(app: &AppHandle) {
    if let Ok(root) = root_dir(app) {
        let _ = std::fs::remove_dir_all(root);
    }
}

fn new_session_id() -> String {
    format!("{:016x}{:016x}", fastrand::u64(..), fastrand::u64(..))
}

/// Creates the session directories and downloads the file. Returns the local path and content.
async fn prepare_session(
    app: &AppHandle,
    provider: &Arc<dyn StorageProvider>,
    profile_id: &str,
    remote_path: &str,
    dir: &Path,
    id: &str,
) -> Result<(PathBuf, Vec<u8>), AppError> {
    let root = dir.parent().unwrap_or(dir);
    create_private_dir(root)?;
    create_private_dir(dir)?;
    let edit_dir = dir.join("edit");
    create_private_dir(&edit_dir)?;
    create_private_dir(&dir.join("snap"))?;

    let editor_path = edit_dir.join(sanitize_local_file_name(remote_file_name(remote_path)));
    let transfer_id = format!("local-edit-{id}-open");
    let mut handle = begin_transfer(app, profile_id, &transfer_id).await?;
    let download = provider
        .download_file(remote_path.to_string(), editor_path.clone(), &mut handle)
        .await;
    end_transfer(app, &transfer_id).await;
    download?;

    let content = read_regular_file(&editor_path)?
        .ok_or_else(|| AppError::Io("Le fichier téléchargé est introuvable.".into()))?;
    if looks_binary(&content) {
        return Err(AppError::InvalidPath(
            "Fichier binaire : seule l'édition de fichiers texte est prise en charge.".into(),
        ));
    }
    Ok((editor_path, content))
}

/// Registers a transfer in the [`TransferManager`] (so a disconnect cancels it) and returns
/// its handle. Must be paired with [`end_transfer`].
async fn begin_transfer(
    app: &AppHandle,
    profile_id: &str,
    transfer_id: &str,
) -> Result<TransferHandle, AppError> {
    let control = app
        .state::<TransferManager>()
        .register(transfer_id, Some(profile_id.to_string()))
        .await?;
    // Progress is not shown for local edit transfers.
    let channel: Channel<TransferProgress> = Channel::new(|_| Ok(()));
    Ok(TransferHandle::new(
        transfer_id.to_string(),
        control,
        channel,
    ))
}

async fn end_transfer(app: &AppHandle, transfer_id: &str) {
    app.state::<TransferManager>().unregister(transfer_id).await;
}

/// Background task owning the sync state of one session.
struct Worker {
    app: AppHandle,
    info: Arc<StdMutex<LocalEditInfo>>,
    closed: Arc<AtomicBool>,
    editor_path: PathBuf,
    snap_dir: PathBuf,
    /// Fingerprint of the remote revision the local copy is based on.
    baseline: Option<RemoteFingerprint>,
    /// Content of that remote revision (as downloaded or last uploaded).
    last_uploaded: Vec<u8>,
    upload_counter: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyncMode {
    /// A save was detected, or the user asked to retry.
    Normal,
    /// The user chose to overwrite the remote file despite a conflict.
    Overwrite,
}

impl Worker {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Command>) {
        let mut pending: VecDeque<Command> = VecDeque::new();
        loop {
            let cmd = match pending.pop_front() {
                Some(c) => c,
                None => match rx.recv().await {
                    Some(c) => c,
                    None => break,
                },
            };
            match cmd {
                Command::FsChanged => {
                    // Coalesce the burst of events produced by one save.
                    tokio::time::sleep(DEBOUNCE).await;
                    while let Ok(next) = rx.try_recv() {
                        if next != Command::FsChanged {
                            pending.push_back(next);
                        }
                    }
                    self.sync(SyncMode::Normal).await;
                }
                Command::Action(LocalEditAction::Retry) => self.sync(SyncMode::Normal).await,
                Command::Action(LocalEditAction::Overwrite) => self.sync(SyncMode::Overwrite).await,
                Command::Action(LocalEditAction::Reload) => self.reload().await,
            }
        }
    }

    fn profile_and_remote(&self) -> (String, String) {
        let info = snapshot_info(&self.info);
        (info.profile_id, info.remote_path)
    }

    fn status(&self) -> LocalEditStatus {
        snapshot_info(&self.info).status
    }

    fn set_status(&self, status: LocalEditStatus, message: Option<String>, synced: bool) {
        let snapshot = {
            let mut info = self.info.lock().unwrap_or_else(|p| p.into_inner());
            info.status = status;
            info.message = message;
            if synced {
                info.last_synced_at = Some(chrono::Utc::now().to_rfc3339());
            }
            info.clone()
        };
        if !self.closed.load(Ordering::SeqCst) {
            let _ = self.app.emit(EVENT_STATUS, &snapshot);
        }
    }

    async fn provider(&self, profile_id: &str) -> Option<Arc<dyn StorageProvider>> {
        match self
            .app
            .state::<SessionManager>()
            .get_provider(Some(profile_id))
            .await
        {
            // The session may have been elevated after the file was opened: never write
            // with root privileges a file the user opened without them.
            Ok(p) if p.is_elevated() => {
                self.set_status(
                    LocalEditStatus::Error,
                    Some("La session est passée en mode sudo : envoi bloqué.".into()),
                    false,
                );
                None
            }
            Ok(p) => Some(p),
            Err(_) => {
                self.set_status(
                    LocalEditStatus::Error,
                    Some("Session déconnectée : reconnectez-vous puis réessayez.".into()),
                    false,
                );
                None
            }
        }
    }

    async fn sync(&mut self, mode: SyncMode) {
        let content = match read_regular_file(&self.editor_path) {
            // Missing file: an editor is mid-way through an atomic save; the rename that
            // completes it triggers another event.
            Ok(None) => return,
            Ok(Some(c)) => c,
            Err(e) => {
                self.set_status(LocalEditStatus::Error, Some(e.to_string()), false);
                return;
            }
        };

        if mode == SyncMode::Normal && content == self.last_uploaded {
            if self.status() == LocalEditStatus::Error {
                self.set_status(LocalEditStatus::Synced, None, false);
            }
            return;
        }

        let (profile_id, remote_path) = self.profile_and_remote();
        let Some(provider) = self.provider(&profile_id).await else {
            return;
        };

        if mode == SyncMode::Normal {
            let current = provider.fingerprint(&remote_path).await;
            let conflict = match (&current, &self.baseline) {
                (Ok(cur), Some(base)) => cur != base,
                (Err(AppError::NotFound(_)), _) => true,
                (Ok(_), None) => false,
                (Err(e), _) => {
                    self.set_status(LocalEditStatus::Error, Some(e.to_string()), false);
                    return;
                }
            };
            if conflict {
                let message = if matches!(current, Err(AppError::NotFound(_))) {
                    "Le fichier a été supprimé sur le serveur."
                } else {
                    "Le fichier a été modifié sur le serveur depuis son ouverture."
                };
                self.set_status(LocalEditStatus::Conflict, Some(message.into()), false);
                return;
            }
        }

        self.set_status(LocalEditStatus::Uploading, None, false);

        // Upload from a private copy of what was read, never from the live working file.
        self.upload_counter += 1;
        let snap_path = self.snap_dir.join(format!("{}.snap", self.upload_counter));
        if let Err(e) = write_private_file(&snap_path, &content) {
            self.set_status(LocalEditStatus::Error, Some(e.to_string()), false);
            return;
        }
        let id = snapshot_info(&self.info).id;
        let transfer_id = format!("local-edit-{id}-{}", self.upload_counter);
        let upload = match begin_transfer(&self.app, &profile_id, &transfer_id).await {
            Ok(mut handle) => {
                let res = provider
                    .upload_file(snap_path.clone(), remote_path.clone(), &mut handle)
                    .await;
                end_transfer(&self.app, &transfer_id).await;
                res
            }
            Err(e) => Err(e),
        };
        let _ = std::fs::remove_file(&snap_path);

        match upload {
            Ok(()) => {
                self.last_uploaded = content;
                // The upload changed the remote mtime/etag: adopt it as the new baseline.
                self.baseline = provider.fingerprint(&remote_path).await.ok();
                self.set_status(LocalEditStatus::Synced, None, true);
            }
            Err(e) => self.set_status(LocalEditStatus::Error, Some(e.to_string()), false),
        }
    }

    async fn reload(&mut self) {
        let (profile_id, remote_path) = self.profile_and_remote();
        let Some(provider) = self.provider(&profile_id).await else {
            return;
        };
        self.set_status(LocalEditStatus::Uploading, None, false);

        let result: Result<(Vec<u8>, RemoteFingerprint), AppError> = async {
            let before = provider.fingerprint(&remote_path).await?;
            if before.size > MAX_EDIT_SIZE {
                return Err(AppError::Transfer(
                    "Le fichier distant est devenu trop volumineux pour l'édition locale.".into(),
                ));
            }
            self.upload_counter += 1;
            let snap_path = self
                .snap_dir
                .join(format!("{}.reload", self.upload_counter));
            let id = snapshot_info(&self.info).id;
            let transfer_id = format!("local-edit-{id}-reload-{}", self.upload_counter);
            let mut handle = begin_transfer(&self.app, &profile_id, &transfer_id).await?;
            let download = provider
                .download_file(remote_path.clone(), snap_path.clone(), &mut handle)
                .await;
            end_transfer(&self.app, &transfer_id).await;
            let content = download.and_then(|()| {
                read_regular_file(&snap_path)?
                    .ok_or_else(|| AppError::Io("Téléchargement introuvable.".into()))
            });
            let _ = std::fs::remove_file(&snap_path);
            let content = content?;
            if looks_binary(&content) {
                return Err(AppError::InvalidPath(
                    "Le fichier distant est désormais binaire.".into(),
                ));
            }
            let after = provider.fingerprint(&remote_path).await?;
            if after != before {
                return Err(AppError::Transfer(
                    "Le fichier a encore changé pendant le téléchargement, réessayez.".into(),
                ));
            }
            Ok((content, after))
        }
        .await;

        match result {
            Ok((content, fingerprint)) => {
                // Update the reference before touching the working file, so the watcher event
                // caused by the write below is recognised as "nothing to upload".
                self.last_uploaded = content.clone();
                self.baseline = Some(fingerprint);
                match write_private_file(&self.editor_path, &content) {
                    Ok(()) => self.set_status(
                        LocalEditStatus::Synced,
                        Some(
                            "Version du serveur rechargée : rouvrez le fichier dans l'éditeur."
                                .into(),
                        ),
                        true,
                    ),
                    Err(e) => self.set_status(LocalEditStatus::Error, Some(e.to_string()), false),
                }
            }
            Err(e) => self.set_status(LocalEditStatus::Conflict, Some(e.to_string()), false),
        }
    }
}

fn start_watcher(
    dir: &Path,
    tx: mpsc::UnboundedSender<Command>,
) -> Result<RecommendedWatcher, AppError> {
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            // Access events (including our own reads on Linux) never mean a save.
            if matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) | EventKind::Any
            ) {
                let _ = tx.send(Command::FsChanged);
            }
        }
    })
    .map_err(|e| AppError::Io(format!("Impossible de surveiller le fichier : {e}")))?;
    // Watch the directory, not the file: many editors save by writing a temporary file
    // and renaming it over the original, which would end a watch placed on the file itself.
    watcher
        .watch(dir, RecursiveMode::NonRecursive)
        .map_err(|e| AppError::Io(format!("Impossible de surveiller le fichier : {e}")))?;
    Ok(watcher)
}

/// Candidates for graphical text editors on Linux desktop environments.
pub const LINUX_GUI_EDITORS: &[&str] = &[
    "gnome-text-editor",
    "gedit",
    "kate",
    "kwrite",
    "xed",
    "mousepad",
    "pluma",
    "leafpad",
];

/// Resolves the preferred text editor command on Linux.
///
/// Priority:
/// 1. `$VISUAL` if set and available in PATH (or absolute path)
/// 2. Common graphical text editors in desktop environments (GNOME, KDE, XFCE, MATE...)
/// 3. `$EDITOR` if set and available
/// 4. `None` (blocked: returns an explicit error rather than executing with default handler)
pub fn resolve_linux_editor_from<F>(
    visual: Option<&str>,
    editor: Option<&str>,
    exists: F,
) -> Option<String>
where
    F: Fn(&str) -> bool,
{
    if let Some(v) = visual {
        let trimmed = v.trim();
        let bin = trimmed.split_whitespace().next().unwrap_or(trimmed);
        if !bin.is_empty() && exists(bin) {
            return Some(trimmed.to_string());
        }
    }
    for &candidate in LINUX_GUI_EDITORS {
        if exists(candidate) {
            return Some(candidate.to_string());
        }
    }
    if let Some(e) = editor {
        let trimmed = e.trim();
        let bin = trimmed.split_whitespace().next().unwrap_or(trimmed);
        if !bin.is_empty() && exists(bin) {
            return Some(trimmed.to_string());
        }
    }
    None
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn command_exists(cmd: &str) -> bool {
    let path = Path::new(cmd);
    if path.is_absolute() || cmd.contains('/') {
        return path.is_file();
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(cmd);
            if candidate.is_file() {
                return true;
            }
        }
    }
    false
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn resolve_linux_editor() -> Option<String> {
    let visual = std::env::var("VISUAL").ok();
    let editor = std::env::var("EDITOR").ok();
    resolve_linux_editor_from(visual.as_deref(), editor.as_deref(), command_exists)
}

/// Verifies that the storage provider is not elevated (sudo).
pub fn ensure_not_elevated(provider: &dyn StorageProvider) -> Result<(), AppError> {
    if provider.is_elevated() {
        return Err(AppError::PermissionDenied(
            "L'édition locale est désactivée sur une session élevée (sudo).".into(),
        ));
    }
    Ok(())
}

/// Opens `path` with a text editor, whatever its extension.
fn open_in_text_editor(path: &Path) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        // `-t` opens with the default *text editor*, not the handler of the extension.
        let mut c = std::process::Command::new("open");
        c.arg("-t").arg(path);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        // An explicit editor: the default handler of `.js`, `.vbs`, `.bat`... executes them.
        let mut c = std::process::Command::new("notepad.exe");
        c.arg(path);
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = {
        let editor_str = resolve_linux_editor().ok_or_else(|| {
            AppError::Io(
                "Aucun éditeur de texte détecté. Veuillez installer un éditeur (ex. gedit, kate) ou définir la variable d'environnement $VISUAL.".into(),
            )
        })?;
        let mut parts = editor_str.split_whitespace();
        let bin = parts.next().unwrap_or(&editor_str);
        let mut c = std::process::Command::new(bin);
        for arg in parts {
            c.arg(arg);
        }
        c.arg(path);
        c
    };

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Io(format!("Impossible d'ouvrir l'éditeur : {e}")))?;
    // Reap the child so it does not linger as a zombie; its exit is not meaningful
    // (`open` returns immediately, editors may hand off to an existing instance).
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn remote_file_name(remote_path: &str) -> &str {
    remote_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(remote_path)
}

/// Turns a remote file name into a name that is valid and harmless on the local system.
pub fn sanitize_local_file_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();

    // Windows silently strips trailing dots and spaces.
    while out.ends_with('.') || out.ends_with(' ') {
        out.pop();
    }
    if out.is_empty() || out == "." || out == ".." {
        out = "fichier".into();
    }

    let stem = out
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        out.insert(0, '_');
    }

    if out.len() > MAX_LOCAL_NAME_LEN {
        // Keep the extension (it drives syntax highlighting) and cut the stem.
        let ext = out
            .rfind('.')
            .filter(|&i| i > 0 && out.len() - i <= 16)
            .map(|i| out[i..].to_string())
            .unwrap_or_default();
        let mut cut = MAX_LOCAL_NAME_LEN - ext.len();
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out = format!("{}{}", &out[..cut], ext);
    }
    out
}

/// Heuristic used by most tools (git, grep): text files contain no NUL byte.
pub fn looks_binary(content: &[u8]) -> bool {
    content[..content.len().min(BINARY_SNIFF_LEN)].contains(&0)
}

fn create_private_dir(path: &Path) -> Result<(), AppError> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Err(AppError::InvalidPath(format!(
                "Chemin inattendu dans le dossier d'édition : {}",
                path.display()
            )));
        }
        Ok(_) => {}
        Err(_) => std::fs::create_dir_all(path)?,
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Writes `content` to `path` through a temporary file renamed over it (mode `0600`).
fn write_private_file(path: &Path, content: &[u8]) -> Result<(), AppError> {
    use std::io::Write;
    let tmp = path.with_file_name(format!(".orbit-{}.tmp", new_session_id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let result = (|| {
        let mut file = options.open(&tmp)?;
        file.write_all(content)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Io(format!(
            "Impossible d'écrire {} : {e}",
            path.display()
        )));
    }
    Ok(())
}

/// Reads the whole file, refusing anything but a regular file (symlinks included).
/// Returns `Ok(None)` if the file does not exist.
pub fn read_regular_file(path: &Path) -> Result<Option<Vec<u8>>, AppError> {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(not(unix))]
    {
        if let Ok(meta) = std::fs::symlink_metadata(path) {
            if meta.file_type().is_symlink() {
                return Err(AppError::InvalidPath(format!(
                    "Lien symbolique refusé : {}",
                    path.display()
                )));
            }
        }
    }
    let file = match options.open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(AppError::Io(format!(
                "Impossible de lire {} : {e}",
                path.display()
            )));
        }
    };
    // Checked on the open handle, so it describes exactly what is being read.
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(AppError::InvalidPath(format!(
            "Ce n'est pas un fichier ordinaire : {}",
            path.display()
        )));
    }
    if meta.len() > MAX_EDIT_SIZE {
        return Err(AppError::Transfer(format!(
            "Fichier trop volumineux (max {} Mo).",
            MAX_EDIT_SIZE / (1024 * 1024)
        )));
    }
    let initial_cap = (meta.len() as usize).min(MAX_EDIT_SIZE as usize);
    let mut content = Vec::with_capacity(initial_cap);
    file.take(MAX_EDIT_SIZE + 1).read_to_end(&mut content)?;
    if content.len() as u64 > MAX_EDIT_SIZE {
        return Err(AppError::Transfer(format!(
            "Fichier trop volumineux (max {} Mo).",
            MAX_EDIT_SIZE / (1024 * 1024)
        )));
    }
    Ok(Some(content))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("orbit-local-edit-test-{}", new_session_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sanitize_keeps_regular_names() {
        assert_eq!(sanitize_local_file_name("nginx.conf"), "nginx.conf");
        assert_eq!(sanitize_local_file_name(".env"), ".env");
        assert_eq!(sanitize_local_file_name("café ☕.md"), "café ☕.md");
    }

    #[test]
    fn sanitize_replaces_invalid_characters() {
        assert_eq!(sanitize_local_file_name("a:b*c?.txt"), "a_b_c_.txt");
        assert_eq!(sanitize_local_file_name("..\\evil"), ".._evil");
        assert_eq!(sanitize_local_file_name("tab\there"), "tab_here");
    }

    #[test]
    fn sanitize_handles_degenerate_names() {
        assert_eq!(sanitize_local_file_name(""), "fichier");
        assert_eq!(sanitize_local_file_name(".."), "fichier");
        assert_eq!(sanitize_local_file_name("trailing. . "), "trailing");
    }

    #[test]
    fn sanitize_prefixes_windows_reserved_names() {
        assert_eq!(sanitize_local_file_name("CON"), "_CON");
        assert_eq!(sanitize_local_file_name("nul.txt"), "_nul.txt");
        assert_eq!(sanitize_local_file_name("com1.log"), "_com1.log");
        assert_eq!(sanitize_local_file_name("console.log"), "console.log");
        assert_eq!(sanitize_local_file_name("COM10"), "COM10");
    }

    #[test]
    fn sanitize_truncates_long_names_keeping_extension() {
        let name = format!("{}.yaml", "é".repeat(300));
        let out = sanitize_local_file_name(&name);
        assert!(out.len() <= MAX_LOCAL_NAME_LEN);
        assert!(out.ends_with(".yaml"));
    }

    #[test]
    fn remote_file_name_takes_last_segment() {
        assert_eq!(remote_file_name("/etc/nginx/nginx.conf"), "nginx.conf");
        assert_eq!(remote_file_name("file.txt"), "file.txt");
    }

    #[test]
    fn binary_detection() {
        assert!(!looks_binary(b"hello\nworld"));
        assert!(!looks_binary("é€".as_bytes()));
        assert!(looks_binary(b"\x7fELF\x00\x01"));
        let mut late_nul = vec![b'a'; BINARY_SNIFF_LEN];
        late_nul.push(0);
        assert!(!looks_binary(&late_nul));
    }

    #[test]
    fn read_regular_file_missing_is_none() {
        let dir = temp_dir();
        assert!(read_regular_file(&dir.join("missing")).unwrap().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn read_regular_file_rejects_directories() {
        let dir = temp_dir();
        assert!(read_regular_file(&dir).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn read_regular_file_rejects_symlinks() {
        let dir = temp_dir();
        let target = dir.join("secret");
        std::fs::write(&target, b"secret").unwrap();
        let link = dir.join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(read_regular_file(&link).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn write_private_file_replaces_content() {
        let dir = temp_dir();
        let path = dir.join("file.txt");
        write_private_file(&path, b"one").unwrap();
        write_private_file(&path, b"two").unwrap();
        assert_eq!(read_regular_file(&path).unwrap().unwrap(), b"two");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn create_private_dir_sets_0700_and_rejects_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let sub = dir.join("sub");
        create_private_dir(&sub).unwrap();
        let mode = std::fs::metadata(&sub).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);

        let link = dir.join("link");
        std::os::unix::fs::symlink(&sub, &link).unwrap();
        assert!(create_private_dir(&link).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn read_regular_file_rejects_oversized_file() {
        let dir = temp_dir();
        let path = dir.join("oversized.txt");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_EDIT_SIZE + 1).unwrap();
        let err = read_regular_file(&path).unwrap_err();
        assert!(matches!(err, AppError::Transfer(_)));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn resolve_linux_editor_prefers_visual() {
        let editor = resolve_linux_editor_from(Some("code --wait"), Some("nano"), |cmd| {
            cmd == "code" || cmd == "gedit" || cmd == "nano"
        });
        assert_eq!(editor.as_deref(), Some("code --wait"));
    }

    #[test]
    fn resolve_linux_editor_finds_candidate() {
        let editor =
            resolve_linux_editor_from(None, Some("nano"), |cmd| cmd == "gedit" || cmd == "nano");
        assert_eq!(editor.as_deref(), Some("gedit"));
    }

    #[test]
    fn resolve_linux_editor_falls_back_to_editor_or_none() {
        let with_editor = resolve_linux_editor_from(None, Some("my-custom-editor"), |cmd| {
            cmd == "my-custom-editor"
        });
        assert_eq!(with_editor.as_deref(), Some("my-custom-editor"));

        let none = resolve_linux_editor_from(None, None, |_| false);
        assert_eq!(none, None);
    }

    struct MockTestProvider {
        elevated: bool,
        entries: Vec<crate::models::FileEntry>,
    }

    #[async_trait::async_trait]
    impl StorageProvider for MockTestProvider {
        async fn list_dir(&self, _path: &str) -> Result<Vec<crate::models::FileEntry>, AppError> {
            Ok(self.entries.clone())
        }
        async fn read_preview(&self, _path: &str, _max_bytes: usize) -> Result<Vec<u8>, AppError> {
            Ok(vec![])
        }
        async fn upload_file(
            &self,
            _local: PathBuf,
            _remote: String,
            _handle: &mut TransferHandle,
        ) -> Result<(), AppError> {
            Ok(())
        }
        async fn download_file(
            &self,
            _remote: String,
            _local: PathBuf,
            _handle: &mut TransferHandle,
        ) -> Result<(), AppError> {
            Ok(())
        }
        async fn delete(&self, _path: &str, _is_dir: bool) -> Result<(), AppError> {
            Ok(())
        }
        async fn create_dir(&self, _path: &str) -> Result<(), AppError> {
            Ok(())
        }
        async fn rename(&self, _from: &str, _to: &str) -> Result<(), AppError> {
            Ok(())
        }
        async fn set_permissions(
            &self,
            _path: &str,
            _mode: Option<u32>,
            _owner: Option<&str>,
            _group: Option<&str>,
            _recursive: bool,
        ) -> Result<(), AppError> {
            Ok(())
        }
        fn is_elevated(&self) -> bool {
            self.elevated
        }
    }

    #[test]
    fn test_ensure_not_elevated_rejects_sudo() {
        let elevated = MockTestProvider {
            elevated: true,
            entries: vec![],
        };
        let err = ensure_not_elevated(&elevated).unwrap_err();
        assert!(matches!(err, AppError::PermissionDenied(_)));

        let standard = MockTestProvider {
            elevated: false,
            entries: vec![],
        };
        assert!(ensure_not_elevated(&standard).is_ok());
    }

    #[tokio::test]
    async fn test_default_fingerprint_file_and_directory() {
        use crate::models::FileEntry;
        let file_entry = FileEntry {
            name: "app.log".into(),
            path: "/var/log/app.log".into(),
            is_dir: false,
            size: 4096,
            modified_at: "2026-11-24T22:00:00Z".into(),
            permissions: Some("0644".into()),
            owner: None,
            group: None,
            is_symlink: false,
            etag: Some("etag123".into()),
        };
        let dir_entry = FileEntry {
            name: "nginx".into(),
            path: "/var/log/nginx".into(),
            is_dir: true,
            size: 0,
            modified_at: "2026-11-24T22:00:00Z".into(),
            permissions: Some("0755".into()),
            owner: None,
            group: None,
            is_symlink: false,
            etag: None,
        };
        let provider = MockTestProvider {
            elevated: false,
            entries: vec![file_entry, dir_entry],
        };

        let fp = provider.fingerprint("/var/log/app.log").await.unwrap();
        assert_eq!(fp.size, 4096);
        assert_eq!(fp.etag.as_deref(), Some("etag123"));

        let dir_err = provider.fingerprint("/var/log/nginx").await.unwrap_err();
        assert!(matches!(dir_err, AppError::InvalidPath(_)));

        let not_found_err = provider
            .fingerprint("/var/log/missing.txt")
            .await
            .unwrap_err();
        assert!(matches!(not_found_err, AppError::NotFound(_)));
    }
}
