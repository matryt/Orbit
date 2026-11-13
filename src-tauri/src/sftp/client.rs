use async_trait::async_trait;
use chrono::{DateTime, Utc};
use russh::keys::PublicKeyOrCertificate;
use russh::client::{self, Handle, Handler};
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::load_secret_key;
use russh_sftp::client::SftpSession;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::AppError;
use crate::models::{FileEntry, SftpConnectConfig, TransferProgress};
use crate::provider::StorageProvider;

pub struct SshHandler;

impl Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Accept host keys for the connection
        Ok(true)
    }
}

pub struct SftpProvider {
    session: SftpSession,
    _handle: Handle<SshHandler>,
}

impl SftpProvider {
    pub async fn connect(config: SftpConnectConfig) -> Result<Self, AppError> {
        let ssh_config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(30)),
            ..Default::default()
        });

        let addr = format!("{}:{}", config.host, config.port);
        let mut handle = client::connect(ssh_config, addr, SshHandler)
            .await
            .map_err(|e| AppError::Ssh(format!("Failed to connect to host: {e}")))?;

        // Authentication: Password or SSH Key
        if let Some(key_path) = config.key_path {
            let expanded_path = if key_path.starts_with('~') {
                if let Some(home) = dirs::home_dir() {
                    home.join(key_path.trim_start_matches("~/"))
                } else {
                    PathBuf::from(key_path)
                }
            } else {
                PathBuf::from(key_path)
            };

            let secret_key = load_secret_key(&expanded_path, config.passphrase.as_deref())
                .map_err(|e| AppError::Auth(format!("Could not load SSH key {}: {e}", expanded_path.display())))?;
            let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(secret_key), None);

            let auth_res = handle
                .authenticate_publickey(&config.username, key_with_alg)
                .await
                .map_err(|e| AppError::Auth(format!("SSH key auth failed: {e}")))?;

            if !auth_res.success() {
                return Err(AppError::Auth("SSH key authentication rejected by server".into()));
            }
        } else if let Some(password) = config.password {
            let auth_res = handle
                .authenticate_password(&config.username, password)
                .await
                .map_err(|e| AppError::Auth(format!("Password auth failed: {e}")))?;

            if !auth_res.success() {
                return Err(AppError::Auth("Invalid username or password".into()));
            }
        } else {
            // Try default SSH keys (~/.ssh/id_ed25519, ~/.ssh/id_rsa)
            let mut authenticated = false;
            if let Some(home) = dirs::home_dir() {
                let default_keys = [
                    home.join(".ssh/id_ed25519"),
                    home.join(".ssh/id_rsa"),
                ];

                for key_p in default_keys {
                    if key_p.exists() {
                        if let Ok(key) = load_secret_key(&key_p, config.passphrase.as_deref()) {
                            let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), None);
                            if let Ok(res) = handle.authenticate_publickey(&config.username, key_with_alg).await {
                                if res.success() {
                                    authenticated = true;
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            if !authenticated {
                return Err(AppError::Auth("No password or valid SSH key provided".into()));
            }
        }

        // Open SFTP channel subsystem
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Sftp(format!("Failed to open SSH channel: {e}")))?;

        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| AppError::Sftp(format!("Failed to request SFTP subsystem: {e}")))?;

        let sftp_session = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| AppError::Sftp(format!("Failed to initialize SFTP session: {e}")))?;

        Ok(Self {
            session: sftp_session,
            _handle: handle,
        })
    }
}

fn format_permissions(mode: Option<u32>, is_dir: bool) -> String {
    if let Some(m) = mode {
        let r_usr = if m & 0o400 != 0 { 'r' } else { '-' };
        let w_usr = if m & 0o200 != 0 { 'w' } else { '-' };
        let x_usr = if m & 0o100 != 0 { 'x' } else { '-' };
        let r_grp = if m & 0o040 != 0 { 'r' } else { '-' };
        let w_grp = if m & 0o020 != 0 { 'w' } else { '-' };
        let x_grp = if m & 0o010 != 0 { 'x' } else { '-' };
        let r_oth = if m & 0o004 != 0 { 'r' } else { '-' };
        let w_oth = if m & 0o002 != 0 { 'w' } else { '-' };
        let x_oth = if m & 0o001 != 0 { 'x' } else { '-' };
        format!("{}{}{}{}{}{}{}{}{}", r_usr, w_usr, x_usr, r_grp, w_grp, x_grp, r_oth, w_oth, x_oth)
    } else if is_dir {
        "rwxr-xr-x".to_string()
    } else {
        "rw-r--r--".to_string()
    }
}

fn format_mtime(mtime: Option<u32>) -> String {
    if let Some(t) = mtime {
        if let Some(dt) = DateTime::from_timestamp(t as i64, 0) {
            return dt.to_rfc3339();
        }
    }
    Utc::now().to_rfc3339()
}

#[async_trait]
impl StorageProvider for SftpProvider {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, AppError> {
        let dir_path = if path.is_empty() { "/" } else { path };
        let read_dir = self
            .session
            .read_dir(dir_path)
            .await
            .map_err(|e| AppError::Sftp(format!("Failed to list directory {dir_path}: {e}")))?;

        let mut entries = Vec::new();
        for entry in read_dir {
            let is_dir = entry.file_type().is_dir();
            let meta = entry.metadata();
            let size = meta.size.unwrap_or(0);
            let permissions = format_permissions(meta.permissions, is_dir);
            let modified_at = format_mtime(meta.mtime);

            entries.push(FileEntry {
                name: entry.file_name(),
                path: entry.path(),
                is_dir,
                size,
                modified_at,
                permissions: Some(permissions),
                etag: None,
            });
        }

        // Sort: directories first, then alphabetical
        entries.sort_by(|a, b| {
            if a.is_dir == b.is_dir {
                a.name.to_lowercase().cmp(&b.name.to_lowercase())
            } else if a.is_dir {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        });

        Ok(entries)
    }

    async fn create_dir(&self, path: &str) -> Result<(), AppError> {
        self.session
            .create_dir(path)
            .await
            .map_err(|e| AppError::Sftp(format!("Failed to create directory {path}: {e}")))?;
        Ok(())
    }

    async fn delete(&self, path: &str, is_dir: bool) -> Result<(), AppError> {
        if is_dir {
            self.session
                .remove_dir(path)
                .await
                .map_err(|e| AppError::Sftp(format!("Failed to remove directory {path}: {e}")))?;
        } else {
            self.session
                .remove_file(path)
                .await
                .map_err(|e| AppError::Sftp(format!("Failed to remove file {path}: {e}")))?;
        }
        Ok(())
    }

    async fn rename(&self, old_path: &str, new_path: &str) -> Result<(), AppError> {
        self.session
            .rename(old_path, new_path)
            .await
            .map_err(|e| AppError::Sftp(format!("Failed to rename {old_path} to {new_path}: {e}")))?;
        Ok(())
    }

    async fn read_preview(&self, path: &str, max_bytes: usize) -> Result<Vec<u8>, AppError> {
        let mut file = self
            .session
            .open(path)
            .await
            .map_err(|e| AppError::Sftp(format!("Failed to open file {path}: {e}")))?;

        let mut buffer = vec![0u8; max_bytes];
        let bytes_read = file
            .read(&mut buffer)
            .await
            .map_err(|e| AppError::Io(format!("Failed to read preview: {e}")))?;

        buffer.truncate(bytes_read);
        Ok(buffer)
    }

    async fn upload_file(
        &self,
        local_path: PathBuf,
        remote_path: String,
        progress_tx: Channel<TransferProgress>,
    ) -> Result<(), AppError> {
        let mut local_file = tokio::fs::File::open(&local_path)
            .await
            .map_err(|e| AppError::Io(format!("Cannot open local file {}: {e}", local_path.display())))?;

        let total_bytes = local_file
            .metadata()
            .await
            .map_err(|e| AppError::Io(format!("Cannot get local file size: {e}")))?
            .len();

        let mut remote_file = self
            .session
            .create(&remote_path)
            .await
            .map_err(|e| AppError::Sftp(format!("Cannot create remote file {remote_path}: {e}")))?;

        let mut buffer = [0u8; 64 * 1024]; // 64 KiB chunks
        let mut bytes_transferred = 0u64;
        let mut last_emit = Instant::now();
        let mut last_bytes = 0u64;
        let transfer_id = format!("tx-{}", Utc::now().timestamp_millis());

        loop {
            let n = local_file
                .read(&mut buffer)
                .await
                .map_err(|e| AppError::Io(format!("Error reading local file: {e}")))?;

            if n == 0 {
                break;
            }

            remote_file
                .write_all(&buffer[..n])
                .await
                .map_err(|e| AppError::Sftp(format!("Error writing to SFTP: {e}")))?;

            bytes_transferred += n as u64;

            // Emit progress every ~150ms
            let elapsed = last_emit.elapsed();
            if elapsed >= Duration::from_millis(150) {
                let delta_bytes = bytes_transferred - last_bytes;
                let speed_bps = if elapsed.as_secs_f64() > 0.0 {
                    (delta_bytes as f64 / elapsed.as_secs_f64()) as u64
                } else {
                    0
                };

                let _ = progress_tx.send(TransferProgress {
                    transfer_id: transfer_id.clone(),
                    bytes_transferred,
                    total_bytes,
                    speed_bps,
                    status: "transferring".into(),
                });

                last_emit = Instant::now();
                last_bytes = bytes_transferred;
            }
        }

        remote_file
            .close()
            .await
            .map_err(|e| AppError::Sftp(format!("Error closing remote file: {e}")))?;

        // Final 100% notification
        let _ = progress_tx.send(TransferProgress {
            transfer_id,
            bytes_transferred: total_bytes,
            total_bytes,
            speed_bps: 0,
            status: "completed".into(),
        });

        Ok(())
    }

    async fn download_file(
        &self,
        remote_path: String,
        local_path: PathBuf,
        progress_tx: Channel<TransferProgress>,
    ) -> Result<(), AppError> {
        let mut remote_file = self
            .session
            .open(&remote_path)
            .await
            .map_err(|e| AppError::Sftp(format!("Cannot open remote file {remote_path}: {e}")))?;

        let meta = remote_file
            .metadata()
            .await
            .map_err(|e| AppError::Sftp(format!("Cannot get remote file metadata: {e}")))?;
        let total_bytes = meta.size.unwrap_or(0);

        let mut local_file = tokio::fs::File::create(&local_path)
            .await
            .map_err(|e| AppError::Io(format!("Cannot create local file {}: {e}", local_path.display())))?;

        let mut buffer = [0u8; 64 * 1024]; // 64 KiB chunks
        let mut bytes_transferred = 0u64;
        let mut last_emit = Instant::now();
        let mut last_bytes = 0u64;
        let transfer_id = format!("tx-{}", Utc::now().timestamp_millis());

        loop {
            let n = remote_file
                .read(&mut buffer)
                .await
                .map_err(|e| AppError::Sftp(format!("Error reading from SFTP: {e}")))?;

            if n == 0 {
                break;
            }

            local_file
                .write_all(&buffer[..n])
                .await
                .map_err(|e| AppError::Io(format!("Error writing to local file: {e}")))?;

            bytes_transferred += n as u64;

            // Emit progress every ~150ms
            let elapsed = last_emit.elapsed();
            if elapsed >= Duration::from_millis(150) {
                let delta_bytes = bytes_transferred - last_bytes;
                let speed_bps = if elapsed.as_secs_f64() > 0.0 {
                    (delta_bytes as f64 / elapsed.as_secs_f64()) as u64
                } else {
                    0
                };

                let _ = progress_tx.send(TransferProgress {
                    transfer_id: transfer_id.clone(),
                    bytes_transferred,
                    total_bytes,
                    speed_bps,
                    status: "transferring".into(),
                });

                last_emit = Instant::now();
                last_bytes = bytes_transferred;
            }
        }

        local_file
            .flush()
            .await
            .map_err(|e| AppError::Io(format!("Error flushing local file: {e}")))?;

        // Final 100% notification
        let _ = progress_tx.send(TransferProgress {
            transfer_id,
            bytes_transferred: total_bytes,
            total_bytes,
            speed_bps: 0,
            status: "completed".into(),
        });

        Ok(())
    }
}
