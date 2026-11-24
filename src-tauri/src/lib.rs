#![allow(clippy::collapsible_if)]

pub mod commands;
pub mod config_service;
pub mod error;
pub mod keyring_service;
pub mod local_fs;
pub mod models;
pub mod provider;
pub mod s3;
pub mod session;
pub mod sftp;
pub mod terminal;
pub mod transfer;
pub mod updater;
pub mod walk;

use std::sync::Arc;

use session::SessionManager;
use sftp::host_key::HostKeyPromptManager;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .manage(SessionManager::new())
        .manage(transfer::TransferManager::new())
        .manage(Arc::new(HostKeyPromptManager::new()))
        .setup(|_app| {
            #[cfg(desktop)]
            _app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            #[cfg(any(target_os = "macos", target_os = "windows"))]
            {
                let window = _app.get_webview_window("main").unwrap();

                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{NSVisualEffectMaterial, apply_vibrancy};
                    let _ = apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, None);
                }

                #[cfg(target_os = "windows")]
                {
                    use window_vibrancy::apply_mica;
                    let _ = apply_mica(&window, None);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::test_sftp_connection,
            commands::connect_sftp,
            commands::test_s3_connection,
            commands::connect_s3,
            commands::get_session_info,
            commands::respond_host_key_prompt,
            commands::get_pending_host_key_prompts,
            commands::disconnect,
            commands::storage_list_dir,
            commands::storage_create_dir,
            commands::storage_delete,
            commands::storage_rename,
            commands::storage_read_preview,
            commands::storage_upload_file,
            commands::storage_download_file,
            commands::transfer_pause,
            commands::storage_walk,
            commands::storage_ensure_dir,
            commands::local_walk,
            commands::local_is_dir,
            commands::transfer_resume,
            commands::transfer_cancel,
            commands::save_secret,
            commands::get_secret,
            commands::delete_secret,
            commands::load_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::local_list_dir,
            commands::local_read_preview,
            commands::local_create_dir,
            commands::local_delete,
            commands::local_rename,
            commands::check_app_update,
            commands::open_in_external_terminal,
            commands::storage_set_permissions,
            commands::local_set_permissions,
            commands::storage_list_identities,
            commands::local_list_identities,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
