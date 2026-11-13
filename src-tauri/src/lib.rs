#![allow(clippy::collapsible_if)]

pub mod commands;
pub mod config_service;
pub mod error;
pub mod keyring_service;
pub mod models;
pub mod provider;
pub mod session;
pub mod sftp;

use session::SessionManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionManager::new())
        .setup(|_app| {
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
            commands::disconnect,
            commands::storage_list_dir,
            commands::storage_create_dir,
            commands::storage_delete,
            commands::storage_rename,
            commands::storage_read_preview,
            commands::storage_upload_file,
            commands::storage_download_file,
            commands::save_secret,
            commands::get_secret,
            commands::delete_secret,
            commands::load_profiles,
            commands::save_profile,
            commands::delete_profile,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
