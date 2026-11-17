use crate::error::AppError;
use crate::models::{FileEntry, SudoCapability};
use crate::transfer::TransferHandle;
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

    fn is_elevated(&self) -> bool {
        false
    }

    fn sudo_capability(&self) -> SudoCapability {
        SudoCapability::None
    }
}
