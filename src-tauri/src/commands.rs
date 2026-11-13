use std::path::PathBuf;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

use crate::error::AppError;
use crate::keyring_service::KeyringService;
use crate::models::{FileEntry, SftpConnectConfig, TransferProgress};
use crate::session::SessionManager;
use crate::sftp::client::SftpProvider;

#[tauri::command]
pub async fn connect_sftp(
    mut config: SftpConnectConfig,
    state: State<'_, SessionManager>,
) -> Result<(), AppError> {
    // If password or passphrase not provided directly, look in system keyring
    if config.password.is_none() && config.passphrase.is_none() {
        if let Ok(Some(secret)) = KeyringService::get_secret(&config.profile_id) {
            if config.key_path.is_some() {
                config.passphrase = Some(secret);
            } else {
                config.password = Some(secret);
            }
        }
    }

    let profile_id = config.profile_id.clone();
    let provider = SftpProvider::connect(config).await?;
    state.set_provider(profile_id, Arc::new(provider)).await;
    Ok(())
}

#[tauri::command]
pub async fn disconnect(
    profile_id: String,
    state: State<'_, SessionManager>,
) -> Result<(), AppError> {
    state.remove_provider(&profile_id).await;
    Ok(())
}

#[tauri::command]
pub async fn storage_list_dir(
    profile_id: Option<String>,
    path: String,
    state: State<'_, SessionManager>,
) -> Result<Vec<FileEntry>, AppError> {
    let provider = state.get_provider(profile_id.as_deref()).await?;
    provider.list_dir(&path).await
}

#[tauri::command]
pub async fn storage_create_dir(
    profile_id: Option<String>,
    path: String,
    state: State<'_, SessionManager>,
) -> Result<(), AppError> {
    let provider = state.get_provider(profile_id.as_deref()).await?;
    provider.create_dir(&path).await
}

#[tauri::command]
pub async fn storage_delete(
    profile_id: Option<String>,
    path: String,
    is_dir: bool,
    state: State<'_, SessionManager>,
) -> Result<(), AppError> {
    let provider = state.get_provider(profile_id.as_deref()).await?;
    provider.delete(&path, is_dir).await
}

#[tauri::command]
pub async fn storage_rename(
    profile_id: Option<String>,
    old_path: String,
    new_path: String,
    state: State<'_, SessionManager>,
) -> Result<(), AppError> {
    let provider = state.get_provider(profile_id.as_deref()).await?;
    provider.rename(&old_path, &new_path).await
}

#[tauri::command]
pub async fn storage_read_preview(
    profile_id: Option<String>,
    path: String,
    max_bytes: usize,
    state: State<'_, SessionManager>,
) -> Result<Vec<u8>, AppError> {
    let provider = state.get_provider(profile_id.as_deref()).await?;
    provider.read_preview(&path, max_bytes).await
}

#[tauri::command]
pub async fn storage_upload_file(
    profile_id: Option<String>,
    local_path: String,
    remote_path: String,
    progress_tx: Channel<TransferProgress>,
    state: State<'_, SessionManager>,
) -> Result<(), AppError> {
    let provider = state.get_provider(profile_id.as_deref()).await?;
    let path_buf = PathBuf::from(local_path);
    provider.upload_file(path_buf, remote_path, progress_tx).await
}

#[tauri::command]
pub async fn storage_download_file(
    profile_id: Option<String>,
    remote_path: String,
    local_path: String,
    progress_tx: Channel<TransferProgress>,
    state: State<'_, SessionManager>,
) -> Result<(), AppError> {
    let provider = state.get_provider(profile_id.as_deref()).await?;
    let path_buf = PathBuf::from(local_path);
    provider.download_file(remote_path, path_buf, progress_tx).await
}

#[tauri::command]
pub async fn save_secret(profile_id: String, secret: String) -> Result<(), AppError> {
    KeyringService::save_secret(&profile_id, &secret)
}

#[tauri::command]
pub async fn get_secret(profile_id: String) -> Result<Option<String>, AppError> {
    KeyringService::get_secret(&profile_id)
}

#[tauri::command]
pub async fn delete_secret(profile_id: String) -> Result<(), AppError> {
    KeyringService::delete_secret(&profile_id)
}
