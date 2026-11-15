use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tauri::ipc::Channel;

use crate::config_service::ConfigService;
use crate::error::AppError;
use crate::keyring_service::KeyringService;
use crate::models::{
    ConnectionProfile, ConnectionTestResult, FileEntry, HostKeyDecision, SftpConnectConfig,
    TransferProgress,
};
use crate::session::SessionManager;
use crate::sftp::client::SftpProvider;
use crate::sftp::host_key::{HostKeyPromptManager, TauriHostKeyPromptHandler};

#[tauri::command]
pub async fn respond_host_key_prompt(
    request_id: String,
    decision: HostKeyDecision,
    host_key_mgr: State<'_, Arc<HostKeyPromptManager>>,
) -> Result<bool, AppError> {
    Ok(host_key_mgr.resolve_prompt(&request_id, decision).await)
}

#[tauri::command]
pub async fn get_pending_host_key_prompts(
    host_key_mgr: State<'_, Arc<HostKeyPromptManager>>,
) -> Result<Vec<crate::models::HostKeyPromptRequest>, AppError> {
    Ok(host_key_mgr.get_pending_requests().await)
}

#[tauri::command]
pub async fn test_sftp_connection(
    app: tauri::AppHandle,
    host_key_mgr: State<'_, Arc<HostKeyPromptManager>>,
    mut config: SftpConnectConfig,
) -> Result<ConnectionTestResult, AppError> {
    let prompt_handler: Arc<dyn crate::sftp::host_key::HostKeyPromptHandler + Send + Sync> =
        Arc::new(TauriHostKeyPromptHandler::new(
            app,
            Arc::clone(&host_key_mgr),
        ));

    let test_task = async move {
        // Run synchronous keyring lookup on a blocking thread inside the timeout
        if config.password.is_none() && config.passphrase.is_none() {
            let pid = config.profile_id.clone();
            if let Ok(Ok(Some(secret))) =
                tokio::task::spawn_blocking(move || KeyringService::get_secret(&pid)).await
            {
                if config.key_path.is_some() {
                    config.passphrase = Some(secret);
                } else {
                    config.password = Some(secret);
                }
            }
        }

        SftpProvider::connect_with_logs_and_prompt(config, Some(prompt_handler)).await
    };

    match tokio::time::timeout(std::time::Duration::from_secs(90), test_task).await {
        Ok(Ok((_provider, logs))) => Ok(ConnectionTestResult {
            success: true,
            message: "Connexion SFTP établie avec succès ! Authentification et sous-système SFTP validés.".into(),
            logs,
        }),
        Ok(Err((err, logs))) => Ok(ConnectionTestResult {
            success: false,
            message: err.to_string(),
            logs,
        }),
        Err(_) => Ok(ConnectionTestResult {
            success: false,
            message: "Délai d'attente dépassé (90s) : aucune réponse reçue du serveur SSH ou validation annulée.".into(),
            logs: vec![
                format!("[{}] ❌ Timeout : Aucune réponse après 90 secondes.", chrono::Utc::now().format("%H:%M:%S%.3f")),
                "ℹ️ Conseil: Vérifiez l'adresse IP / domaine et le port, ou assurez-vous que le serveur SSH est bien démarré.".into(),
            ],
        }),
    }
}

#[tauri::command]
pub async fn connect_sftp(
    app: tauri::AppHandle,
    host_key_mgr: State<'_, Arc<HostKeyPromptManager>>,
    mut config: SftpConnectConfig,
    state: State<'_, SessionManager>,
) -> Result<(), AppError> {
    let profile_id = config.profile_id.clone();
    // Démarre le suivi et le canal d'annulation AVANT toute opération (y compris le trousseau)
    let (generation, mut cancel_rx) = state.start_connecting(&profile_id).await;

    let connect_task = async move {
        let prompt_handler: Arc<dyn crate::sftp::host_key::HostKeyPromptHandler + Send + Sync> =
            Arc::new(TauriHostKeyPromptHandler::new(
                app,
                Arc::clone(&host_key_mgr),
            ));

        // If password or passphrase not provided directly, look in system keyring on a blocking thread
        if config.password.is_none() && config.passphrase.is_none() {
            let pid = config.profile_id.clone();
            if let Ok(Ok(Some(secret))) =
                tokio::task::spawn_blocking(move || KeyringService::get_secret(&pid)).await
            {
                if config.key_path.is_some() {
                    config.passphrase = Some(secret);
                } else {
                    config.password = Some(secret);
                }
            }
        }

        SftpProvider::connect_with_prompt(config, Some(prompt_handler)).await
    };

    tokio::select! {
        _ = cancel_rx.changed() => {
            Err(AppError::Cancelled(
                "Connexion annulée : le profil a été déconnecté pendant l'établissement.".into(),
            ))
        }
        res = connect_task => {
            let provider = res?;
            if !state
                .complete_connecting(&profile_id, generation, Arc::new(provider))
                .await
            {
                return Err(AppError::Cancelled(
                    "Connexion annulée : le profil a été déconnecté pendant l'établissement.".into(),
                ));
            }
            Ok(())
        }
    }
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
    provider
        .upload_file(path_buf, remote_path, progress_tx)
        .await
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
    provider
        .download_file(remote_path, path_buf, progress_tx)
        .await
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

#[tauri::command]
pub async fn load_profiles(app: tauri::AppHandle) -> Result<Vec<ConnectionProfile>, AppError> {
    ConfigService::load_profiles(&app)
}

#[tauri::command]
pub async fn save_profile(
    profile: ConnectionProfile,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    ConfigService::save_profile(&app, profile)
}

#[tauri::command]
pub async fn delete_profile(profile_id: String, app: tauri::AppHandle) -> Result<(), AppError> {
    let _ = KeyringService::delete_secret(&profile_id);
    ConfigService::delete_profile(&app, &profile_id)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LocalDirResult {
    pub current_path: String,
    pub entries: Vec<FileEntry>,
}

#[tauri::command]
pub async fn local_list_dir(path: Option<String>) -> Result<LocalDirResult, AppError> {
    tokio::task::spawn_blocking(move || {
        let (current_path, entries) = crate::local_fs::list_local_directory(path.as_deref())?;
        Ok(LocalDirResult {
            current_path,
            entries,
        })
    })
    .await
    .map_err(|e| AppError::Io(format!("Task execution failed: {e}")))?
}

#[tauri::command]
pub async fn local_read_preview(path: String, max_bytes: usize) -> Result<Vec<u8>, AppError> {
    tokio::task::spawn_blocking(move || crate::local_fs::read_local_preview(&path, max_bytes))
        .await
        .map_err(|e| AppError::Io(format!("Task execution failed: {e}")))?
}

#[tauri::command]
pub async fn local_create_dir(path: String) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || crate::local_fs::create_local_directory(&path))
        .await
        .map_err(|e| AppError::Io(format!("Task execution failed: {e}")))?
}

#[tauri::command]
pub async fn local_delete(path: String, is_dir: bool) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || crate::local_fs::delete_local_item(&path, is_dir))
        .await
        .map_err(|e| AppError::Io(format!("Task execution failed: {e}")))?
}

#[tauri::command]
pub async fn local_rename(old_path: String, new_path: String) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || crate::local_fs::rename_local_item(&old_path, &new_path))
        .await
        .map_err(|e| AppError::Io(format!("Task execution failed: {e}")))?
}
