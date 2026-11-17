//! Contrôle des transferts en cours : pause, reprise, annulation et émission de progression.
//!
//! Chaque transfert lancé depuis le frontend est enregistré dans le [`TransferManager`] sous
//! un identifiant fourni par le frontend. Le provider reçoit un [`TransferHandle`] qu'il
//! interroge entre chaque bloc (`checkpoint`) et autour de chaque opération réseau (`guard`).

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

/// Côté consommateur : reçoit les signaux de contrôle d'un transfert.
pub struct TransferControl {
    rx: watch::Receiver<TransferSignal>,
}

impl TransferControl {
    fn current(&self) -> TransferSignal {
        *self.rx.borrow()
    }

    /// Exécute `fut` en l'interrompant immédiatement si le transfert est annulé.
    /// Une mise en pause n'interrompt pas l'opération en vol (elle prend effet au prochain `checkpoint`).
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
                        // Le manager a été détruit : on termine simplement l'opération en cours.
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

/// Handle passé aux providers : combine le contrôle et l'émission de progression.
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

    /// Déclare la taille totale et émet un premier événement de progression.
    pub fn start(&mut self, total_bytes: u64) {
        self.total_bytes = total_bytes;
        self.reset_speed_window();
        self.emit("transferring", 0);
    }

    /// Comptabilise `n` octets transférés et émet la progression au plus toutes les 150 ms.
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

    /// Point de contrôle entre deux blocs : attend tant que le transfert est en pause
    /// et retourne `AppError::Cancelled` s'il a été annulé.
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

    /// Voir [`TransferControl::guard`].
    pub async fn guard<F, T>(&mut self, fut: F) -> Result<T, AppError>
    where
        F: Future<Output = Result<T, AppError>>,
    {
        self.control.guard(fut).await
    }
}

/// Chemin temporaire, propre à un transfert, dans lequel un téléchargement est écrit avant
/// d'être renommé vers sa destination finale. Un transfert interrompu ne touche ainsi jamais
/// au fichier de destination existant, ni à celui d'un autre transfert visant le même chemin.
pub fn partial_download_path(local_path: &Path, transfer_id: &str) -> PathBuf {
    let file_name = local_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    // L'identifiant vient du frontend : on n'en garde que des caractères sûrs pour un nom de fichier.
    let safe_id: String = transfer_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    local_path.with_file_name(format!(".{file_name}.{safe_id}.orbit-part"))
}

/// Remplace `local_path` par le fichier temporaire une fois le téléchargement terminé.
pub async fn finalize_partial_download(partial: &Path, local_path: &Path) -> Result<(), AppError> {
    if let Err(e) = tokio::fs::rename(partial, local_path).await {
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

/// Registre global des transferts actifs (état Tauri).
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
        // Une annulation est définitive : on ne repasse jamais d'un état annulé à un autre.
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

    /// Annule tous les transferts liés à un profil (utilisé lors d'une déconnexion).
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

        // Toujours bloqué tant que le transfert est en pause.
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
        assert_eq!(p.file_name().unwrap(), ".report.pdf.etcpasswd.orbit-part");
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
