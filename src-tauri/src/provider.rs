use crate::error::AppError;
use crate::models::{FileEntry, RemoteFingerprint, SudoCapability};
use crate::transfer::TransferHandle;
use crate::walk::WalkEntry;
use async_trait::async_trait;
use std::path::PathBuf;

#[async_trait]
pub trait StorageProvider: Send + Sync {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, AppError>;
    async fn create_dir(&self, path: &str) -> Result<(), AppError>;
    async fn delete(&self, path: &str, is_dir: bool) -> Result<(), AppError>;
    async fn rename(&self, old_path: &str, new_path: &str) -> Result<(), AppError>;
    async fn read_preview(&self, path: &str, max_bytes: usize) -> Result<Vec<u8>, AppError>;
    async fn upload_file(
        &self,
        local_path: PathBuf,
        remote_path: String,
        transfer: &mut TransferHandle,
    ) -> Result<(), AppError>;
    async fn download_file(
        &self,
        remote_path: String,
        local_path: PathBuf,
        transfer: &mut TransferHandle,
    ) -> Result<(), AppError>;
    async fn set_permissions(
        &self,
        path: &str,
        mode: Option<u32>,
        owner: Option<&str>,
        group: Option<&str>,
        recursive: bool,
    ) -> Result<(), AppError>;

    async fn list_identities(&self) -> Result<(Vec<String>, Vec<String>), AppError> {
        Ok((Vec::new(), Vec::new()))
    }

    /// Recursively lists `root`. Paths are relative to `root` and `/`-separated.
    async fn walk(&self, root: &str) -> Result<Vec<WalkEntry>, AppError> {
        crate::walk::walk_remote(self, root).await
    }

    /// Creates `path` if needed; succeeds when it already exists as a directory.
    async fn ensure_dir(&self, path: &str) -> Result<(), AppError> {
        match self.create_dir(path).await {
            Ok(()) => Ok(()),
            Err(err) => match self.list_dir(path).await {
                Ok(_) => Ok(()),
                Err(_) => Err(err),
            },
        }
    }

    /// Returns the fingerprint of the regular file at `path`.
    ///
    /// The default implementation lists the parent directory; providers override it with a
    /// single metadata request.
    async fn fingerprint(&self, path: &str) -> Result<RemoteFingerprint, AppError> {
        let trimmed = path.trim_end_matches('/');
        let parent = match trimmed.rfind('/') {
            Some(0) | None => "/",
            Some(idx) => &trimmed[..idx],
        };
        let entry = self
            .list_dir(parent)
            .await?
            .into_iter()
            .find(|e| e.path == trimmed)
            .ok_or_else(|| AppError::NotFound(format!("Fichier distant introuvable : {path}")))?;
        if entry.is_dir {
            return Err(AppError::InvalidPath(format!("{path} est un dossier")));
        }
        Ok(RemoteFingerprint {
            size: entry.size,
            modified: Some(entry.modified_at),
            etag: entry.etag,
        })
    }

    fn is_elevated(&self) -> bool {
        false
    }

    fn sudo_capability(&self) -> SudoCapability {
        SudoCapability::None
    }
}
