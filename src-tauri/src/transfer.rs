//! Control of running transfers: pause, resume, cancellation and progress emission.
//!
//! Every transfer started by the frontend is registered in the [`TransferManager`] under an
//! id supplied by the frontend. The provider receives a [`TransferHandle`] that it polls
//! between chunks (`checkpoint`) and around each network operation (`guard`).

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tauri::ipc::Channel;
use tokio::sync::{Mutex, watch};

use crate::error::AppError;
use crate::models::TransferProgress;

const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferSignal {
    Running,
    Paused,
    Cancelled,
}

fn cancelled_error() -> AppError {
    AppError::Cancelled("Transfert annulé par l'utilisateur.".into())
}

/// Consumer side: receives the control signals of a transfer.
pub struct TransferControl {
    rx: watch::Receiver<TransferSignal>,
}

impl TransferControl {
    fn current(&self) -> TransferSignal {
        *self.rx.borrow()
    }

    /// Runs `fut`, aborting it immediately if the transfer is cancelled.
    /// A pause does not interrupt the in-flight operation (it takes effect at the next `checkpoint`).
    pub async fn guard<F, T>(&mut self, fut: F) -> Result<T, AppError>
    where
        F: Future<Output = Result<T, AppError>>,
    {
        if self.current() == TransferSignal::Cancelled {
            return Err(cancelled_error());
        }
        tokio::pin!(fut);
        loop {
            tokio::select! {
                res = &mut fut => return res,
                changed = self.rx.changed() => {
                    if changed.is_err() {
                        // The manager was dropped: just let the in-flight operation finish.
                        return fut.await;
                    }
                    if self.current() == TransferSignal::Cancelled {
                        return Err(cancelled_error());
                    }
                }
            }
        }
    }
}

/// Handle passed to providers: combines control and progress emission.
pub struct TransferHandle {
    id: String,
    control: TransferControl,
    progress_tx: Channel<TransferProgress>,
    total_bytes: u64,
    bytes_transferred: u64,
    last_emit: Instant,
    last_emit_bytes: u64,
}

impl TransferHandle {
    pub fn new(
        id: String,
        control: TransferControl,
        progress_tx: Channel<TransferProgress>,
    ) -> Self {
        Self {
            id,
            control,
            progress_tx,
            total_bytes: 0,
            bytes_transferred: 0,
            last_emit: Instant::now(),
            last_emit_bytes: 0,
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    fn emit(&self, status: &str, speed_bps: u64) {
        let _ = self.progress_tx.send(TransferProgress {
            transfer_id: self.id.clone(),
            bytes_transferred: self.bytes_transferred,
            total_bytes: self.total_bytes,
            speed_bps,
            status: status.to_string(),
        });
    }

    fn reset_speed_window(&mut self) {
        self.last_emit = Instant::now();
        self.last_emit_bytes = self.bytes_transferred;
    }

    /// Sets the total size and emits an initial progress event.
    pub fn start(&mut self, total_bytes: u64) {
        self.total_bytes = total_bytes;
        self.reset_speed_window();
        self.emit("transferring", 0);
    }

    /// Records `n` transferred bytes and emits progress at most every 150 ms.
    pub fn advance(&mut self, n: u64) {
        self.bytes_transferred += n;
        let elapsed = self.last_emit.elapsed();
        if elapsed >= PROGRESS_INTERVAL {
            let delta = self.bytes_transferred - self.last_emit_bytes;
            let speed_bps = (delta as f64 / elapsed.as_secs_f64()) as u64;
            self.emit("transferring", speed_bps);
            self.reset_speed_window();
        }
    }

    pub fn complete(&mut self) {
        self.bytes_transferred = self.total_bytes.max(self.bytes_transferred);
        self.emit("completed", 0);
    }

    /// Checkpoint between two chunks: waits while the transfer is paused
    /// and returns `AppError::Cancelled` if it was cancelled.
    pub async fn checkpoint(&mut self) -> Result<(), AppError> {
        match self.control.current() {
            TransferSignal::Running => Ok(()),
            TransferSignal::Cancelled => Err(cancelled_error()),
            TransferSignal::Paused => {
                self.emit("paused", 0);
                loop {
                    if self.control.rx.changed().await.is_err() {
                        return Err(cancelled_error());
                    }
                    match self.control.current() {
                        TransferSignal::Paused => continue,
                        TransferSignal::Cancelled => return Err(cancelled_error()),
                        TransferSignal::Running => break,
                    }
                }
                self.reset_speed_window();
                self.emit("transferring", 0);
                Ok(())
            }
        }
    }

    /// See [`TransferControl::guard`].
    pub async fn guard<F, T>(&mut self, fut: F) -> Result<T, AppError>
    where
        F: Future<Output = Result<T, AppError>>,
    {
        self.control.guard(fut).await
    }
}

/// Max length of the transfer id embedded in a temporary file name.
const PARTIAL_ID_MAX_LEN: usize = 64;

/// Per-transfer temporary path a download is written to before being renamed to its final
/// destination. An interrupted transfer therefore never touches an existing destination file,
/// nor the output of another transfer targeting the same path.
///
/// The name does not embed the destination file name, so its length stays bounded
/// (a long but valid destination name must not exceed the 255-byte file name limit).
pub fn partial_download_path(local_path: &Path, transfer_id: &str) -> PathBuf {
    // The id comes from the frontend: keep only characters that are safe in a file name.
    let safe_id: String = transfer_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(PARTIAL_ID_MAX_LEN)
        .collect();
    local_path.with_file_name(format!(".orbit-{safe_id}.part"))
}

/// Creates a temporary file for download with strict permissions (0600 on Unix)
/// to prevent local users from reading in-flight transferred data before finalization.
pub async fn create_partial_download_file(path: &Path) -> Result<tokio::fs::File, AppError> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options.open(path).await.map_err(|e| {
        AppError::Io(format!(
            "Cannot create partial file {}: {e}",
            path.display()
        ))
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) =
            tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await
        {
            let _ = tokio::fs::remove_file(path).await;
            return Err(AppError::Io(format!(
                "Cannot enforce 0600 permissions on partial file {}: {e}",
                path.display()
            )));
        }
    }

    Ok(file)
}

/// Replaces `local_path` with the temporary file once the download has finished.
///
/// If `local_path` already exists, its permissions are copied onto the temporary file first:
/// `rename` swaps the inode, so without this an existing private file (e.g. `0600`) would
/// silently become readable with the process default mode (e.g. `0644`).
pub async fn finalize_partial_download(partial: &Path, local_path: &Path) -> Result<(), AppError> {
    let result: Result<(), String> = async {
        if let Ok(existing) = tokio::fs::metadata(local_path).await {
            tokio::fs::set_permissions(partial, existing.permissions())
                .await
                .map_err(|e| format!("cannot preserve permissions: {e}"))?;
        }
        tokio::fs::rename(partial, local_path)
            .await
            .map_err(|e| e.to_string())
    }
    .await;

    if let Err(e) = result {
        let _ = tokio::fs::remove_file(partial).await;
        return Err(AppError::Io(format!(
            "Impossible de finaliser le téléchargement vers {} : {e}",
            local_path.display()
        )));
    }
    Ok(())
}

struct TransferEntry {
    profile_id: Option<String>,
    tx: watch::Sender<TransferSignal>,
}

/// Global registry of active transfers (Tauri state).
#[derive(Default)]
pub struct TransferManager {
    entries: Mutex<HashMap<String, TransferEntry>>,
}

impl TransferManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register(
        &self,
        transfer_id: &str,
        profile_id: Option<String>,
    ) -> Result<TransferControl, AppError> {
        let mut entries = self.entries.lock().await;
        if entries.contains_key(transfer_id) {
            return Err(AppError::Transfer(format!(
                "Un transfert avec l'identifiant {transfer_id} est déjà en cours."
            )));
        }
        let (tx, rx) = watch::channel(TransferSignal::Running);
        entries.insert(transfer_id.to_string(), TransferEntry { profile_id, tx });
        Ok(TransferControl { rx })
    }

    pub async fn unregister(&self, transfer_id: &str) {
        self.entries.lock().await.remove(transfer_id);
    }

    async fn signal(&self, transfer_id: &str, signal: TransferSignal) -> Result<(), AppError> {
        let entries = self.entries.lock().await;
        let entry = entries
            .get(transfer_id)
            .ok_or_else(|| AppError::NotFound(format!("Transfert introuvable : {transfer_id}")))?;
        // Cancellation is final: never move out of the cancelled state.
        entry.tx.send_if_modified(|current| {
            if *current == TransferSignal::Cancelled || *current == signal {
                false
            } else {
                *current = signal;
                true
            }
        });
        Ok(())
    }

    pub async fn pause(&self, transfer_id: &str) -> Result<(), AppError> {
        self.signal(transfer_id, TransferSignal::Paused).await
    }

    pub async fn resume(&self, transfer_id: &str) -> Result<(), AppError> {
        self.signal(transfer_id, TransferSignal::Running).await
    }

    pub async fn cancel(&self, transfer_id: &str) -> Result<(), AppError> {
        self.signal(transfer_id, TransferSignal::Cancelled).await
    }

    /// Cancels every transfer bound to a profile (used on disconnect).
    pub async fn cancel_for_profile(&self, profile_id: &str) {
        let entries = self.entries.lock().await;
        for entry in entries.values() {
            if entry.profile_id.as_deref() == Some(profile_id) {
                let _ = entry.tx.send(TransferSignal::Cancelled);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn guard_aborts_pending_future_on_cancel() {
        let manager = TransferManager::new();
        let mut control = manager.register("t1", None).await.unwrap();

        let cancel = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            manager.cancel("t1").await.unwrap();
        };
        let guarded = control.guard(std::future::pending::<Result<(), AppError>>());

        let (res, _) = tokio::join!(guarded, cancel);
        assert!(matches!(res, Err(AppError::Cancelled(_))));
    }

    #[tokio::test]
    async fn guard_ignores_pause_and_completes() {
        let manager = TransferManager::new();
        let mut control = manager.register("t1", None).await.unwrap();
        manager.pause("t1").await.unwrap();

        let res = control
            .guard(async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                Ok::<_, AppError>(42)
            })
            .await;
        assert_eq!(res.unwrap(), 42);
    }

    #[tokio::test]
    async fn cancel_is_final() {
        let manager = TransferManager::new();
        let control = manager.register("t1", None).await.unwrap();
        manager.cancel("t1").await.unwrap();
        manager.resume("t1").await.unwrap();
        assert_eq!(control.current(), TransferSignal::Cancelled);
    }

    #[tokio::test]
    async fn duplicate_id_is_rejected() {
        let manager = TransferManager::new();
        let _c = manager.register("t1", None).await.unwrap();
        assert!(manager.register("t1", None).await.is_err());
        manager.unregister("t1").await;
        assert!(manager.register("t1", None).await.is_ok());
    }

    #[tokio::test]
    async fn cancel_for_profile_only_targets_that_profile() {
        let manager = TransferManager::new();
        let a = manager.register("a", Some("p1".into())).await.unwrap();
        let b = manager.register("b", Some("p2".into())).await.unwrap();
        manager.cancel_for_profile("p1").await;
        assert_eq!(a.current(), TransferSignal::Cancelled);
        assert_eq!(b.current(), TransferSignal::Running);
    }

    fn test_handle(manager_control: TransferControl) -> TransferHandle {
        let channel: Channel<TransferProgress> = Channel::new(|_| Ok(()));
        TransferHandle::new("t1".into(), manager_control, channel)
    }

    #[tokio::test]
    async fn checkpoint_waits_while_paused_then_resumes() {
        let manager = TransferManager::new();
        let mut handle = test_handle(manager.register("t1", None).await.unwrap());
        manager.pause("t1").await.unwrap();

        // Still blocked while the transfer is paused.
        let blocked = tokio::time::timeout(Duration::from_millis(30), handle.checkpoint()).await;
        assert!(blocked.is_err());

        let resume = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            manager.resume("t1").await.unwrap();
        };
        let (res, _) = tokio::join!(handle.checkpoint(), resume);
        assert!(res.is_ok());
    }

    #[tokio::test]
    async fn checkpoint_returns_cancelled_when_cancelled_during_pause() {
        let manager = TransferManager::new();
        let mut handle = test_handle(manager.register("t1", None).await.unwrap());
        manager.pause("t1").await.unwrap();

        let cancel = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            manager.cancel("t1").await.unwrap();
        };
        let (res, _) = tokio::join!(handle.checkpoint(), cancel);
        assert!(matches!(res, Err(AppError::Cancelled(_))));
    }

    #[test]
    fn partial_download_path_stays_in_destination_dir_and_is_unique() {
        let dest = Path::new("/tmp/dir/report.pdf");
        let a = partial_download_path(dest, "tx-1");
        let b = partial_download_path(dest, "tx-2");
        assert_eq!(a.parent(), dest.parent());
        assert_ne!(a, b);
        assert_ne!(a, dest);
    }

    #[test]
    fn partial_download_path_sanitizes_transfer_id() {
        let dest = Path::new("/tmp/dir/report.pdf");
        let p = partial_download_path(dest, "../../etc/passwd");
        assert_eq!(p.parent(), dest.parent());
        assert_eq!(p.file_name().unwrap(), ".orbit-etcpasswd.part");
    }

    #[test]
    fn partial_download_path_length_is_bounded() {
        let long_name = "a".repeat(250);
        let dest = PathBuf::from("/tmp/dir").join(&long_name);
        let p = partial_download_path(&dest, &"x".repeat(500));
        assert!(p.file_name().unwrap().len() <= 255);
    }

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("orbit-transfer-test-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn finalize_replaces_destination_content() {
        let dir = scratch_dir("replace");
        let dest = dir.join("file.txt");
        let partial = partial_download_path(&dest, "t1");
        std::fs::write(&dest, b"old").unwrap();
        std::fs::write(&partial, b"new").unwrap();

        finalize_partial_download(&partial, &dest).await.unwrap();

        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        assert!(!partial.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn finalize_preserves_existing_destination_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch_dir("perms");
        let dest = dir.join("secret.env");
        let partial = partial_download_path(&dest, "t1");
        std::fs::write(&dest, b"old").unwrap();
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::write(&partial, b"new").unwrap();
        std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o644)).unwrap();

        finalize_partial_download(&partial, &dest).await.unwrap();

        let mode = std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn create_partial_download_file_sets_strict_0600_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch_dir("strict-perms");
        let dest = dir.join("file.txt");
        let partial = partial_download_path(&dest, "t1");

        let file = create_partial_download_file(&partial).await.unwrap();
        drop(file);

        let mode = std::fs::metadata(&partial).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(
            mode & 0o077,
            0,
            "Group and others must not have any permissions"
        );
        assert_eq!(
            mode & 0o600,
            0o600,
            "Owner must have read and write permissions"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn create_partial_download_file_truncates_and_hardens_preexisting_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch_dir("preexisting-hardening");
        let dest = dir.join("file.txt");
        let partial = partial_download_path(&dest, "t1");

        // Simulate a pre-existing insecure partial file (e.g. 0666 with stale content)
        std::fs::write(&partial, b"stale sensitive data").unwrap();
        std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o666)).unwrap();

        let file = create_partial_download_file(&partial).await.unwrap();
        drop(file);

        let meta = std::fs::metadata(&partial).unwrap();
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(mode & 0o077, 0, "Group and others must have no access");
        assert_eq!(meta.len(), 0, "File must be truncated on open");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn unknown_transfer_returns_not_found() {
        let manager = TransferManager::new();
        assert!(matches!(
            manager.cancel("nope").await,
            Err(AppError::NotFound(_))
        ));
    }
}
