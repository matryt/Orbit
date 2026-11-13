use async_trait::async_trait;
use chrono::{DateTime, Utc};
use russh::client::{self, Handle, Handler};
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::load_secret_key;
use russh::keys::PublicKeyOrCertificate;
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
        let (provider, _logs) = Self::connect_with_logs(config).await.map_err(|(e, _)| e)?;
        Ok(provider)
    }

    pub async fn connect_with_logs(
        config: SftpConnectConfig,
    ) -> Result<(Self, Vec<String>), (AppError, Vec<String>)> {
        let mut logs = Vec::new();
        let now = || Utc::now().format("%H:%M:%S%.3f").to_string();

        logs.push(format!("[{}] Démarrage de la séquence de connexion SFTP...", now()));
        logs.push(format!("[{}] Cible : {}:{}", now(), config.host, config.port));
        logs.push(format!("[{}] Utilisateur SSH : '{}'", now(), config.username));

        let ssh_config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(30)),
            ..Default::default()
        });

        let addr = format!("{}:{}", config.host, config.port);
        logs.push(format!("[{}] 1/4 Connexion TCP socket vers {}...", now(), addr));

        let mut handle = match client::connect(ssh_config, &addr, SshHandler).await {
            Ok(h) => {
                logs.push(format!("[{}] Connexion TCP socket établie avec succès.", now()));
                h
            }
            Err(e) => {
                let err_msg = format!("Échec de connexion réseau vers {addr}: {e}");
                logs.push(format!("[{}] ❌ {}", now(), err_msg));
                logs.push(format!(
                    "[{}] ℹ️ Conseil: Vérifiez l'adresse IP, le port {} et assurez-vous que le serveur SSH est en écoute.",
                    now(),
                    config.port
                ));
                return Err((AppError::Ssh(err_msg), logs));
            }
        };

        logs.push(format!("[{}] 2/4 Négociation KEX et algorithmes SSH validés.", now()));
        logs.push(format!("[{}] 3/4 Début de l'authentification...", now()));

        // Authentication: Password or SSH Key
        if let Some(key_path) = config.key_path {
            let expanded_path = if key_path.starts_with('~') {
                if let Some(home) = dirs::home_dir() {
                    home.join(key_path.trim_start_matches("~/"))
                } else {
                    PathBuf::from(&key_path)
                }
            } else {
                PathBuf::from(&key_path)
            };

            logs.push(format!("[{}] Méthode : Clé privée SSH ({})", now(), expanded_path.display()));

            let secret_key = match load_secret_key(&expanded_path, config.passphrase.as_deref()) {
                Ok(k) => {
                    logs.push(format!("[{}] Clé privée chargée et déchiffrée avec succès.", now()));
                    k
                }
                Err(e) => {
                    let err_msg = format!("Impossible de charger la clé {}: {e}", expanded_path.display());
                    logs.push(format!("[{}] ❌ {}", now(), err_msg));
                    logs.push(format!(
                        "[{}] ℹ️ Conseil: Vérifiez le chemin ou saisissez la passphrase si la clé est chiffrée.",
                        now()
                    ));
                    return Err((AppError::Auth(err_msg), logs));
                }
            };

            let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(secret_key), None);

            match handle.authenticate_publickey(&config.username, key_with_alg).await {
                Ok(res) if res.success() => {
                    logs.push(format!("[{}] Authentification par clé SSH acceptée par le serveur !", now()));
                }
                Ok(_) => {
                    let err_msg = "Le serveur SSH a rejeté la clé publique (SSH_MSG_USERAUTH_FAILURE)".to_string();
                    logs.push(format!("[{}] ❌ {}", now(), err_msg));
                    logs.push(format!(
                        "[{}] ℹ️ Conseil: Vérifiez que votre clé publique (.pub) est ajoutée dans ~/.ssh/authorized_keys sur le serveur pour l'utilisateur '{}'.",
                        now(),
                        config.username
                    ));
                    return Err((AppError::Auth(err_msg), logs));
                }
                Err(e) => {
                    let err_msg = format!("Erreur lors de l'authentification par clé: {e}");
                    logs.push(format!("[{}] ❌ {}", now(), err_msg));
                    return Err((AppError::Auth(err_msg), logs));
                }
            }
        } else if let Some(password) = config.password {
            logs.push(format!("[{}] Méthode : Mot de passe", now()));
            match handle.authenticate_password(&config.username, password).await {
                Ok(res) if res.success() => {
                    logs.push(format!("[{}] Authentification par mot de passe acceptée !", now()));
                }
                Ok(_) => {
                    let err_msg = "Nom d'utilisateur ou mot de passe incorrect".to_string();
                    logs.push(format!("[{}] ❌ {}", now(), err_msg));
                    return Err((AppError::Auth(err_msg), logs));
                }
                Err(e) => {
                    let err_msg = format!("Erreur lors de l'authentification: {e}");
                    logs.push(format!("[{}] ❌ {}", now(), err_msg));
                    return Err((AppError::Auth(err_msg), logs));
                }
            }
        } else {
            logs.push(format!("[{}] Recherche des clés SSH standard (~/.ssh/id_ed25519, ~/.ssh/id_rsa)...", now()));
            let mut authenticated = false;
            if let Some(home) = dirs::home_dir() {
                let default_keys = [home.join(".ssh/id_ed25519"), home.join(".ssh/id_rsa")];
                for key_p in default_keys {
                    if key_p.exists() {
                        logs.push(format!("[{}] Tentative avec {}", now(), key_p.display()));
                        if let Ok(key) = load_secret_key(&key_p, config.passphrase.as_deref()) {
                            let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), None);
                            if let Ok(res) = handle.authenticate_publickey(&config.username, key_with_alg).await {
                                if res.success() {
                                    logs.push(format!("[{}] Authentification réussie avec {}", now(), key_p.display()));
                                    authenticated = true;
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            if !authenticated {
                let err_msg = "Aucun mot de passe ni clé SSH valide fournie".to_string();
                logs.push(format!("[{}] ❌ {}", now(), err_msg));
                return Err((AppError::Auth(err_msg), logs));
            }
        }

        logs.push(format!("[{}] 4/4 Ouverture du canal SSH et du sous-système SFTP...", now()));
        let channel = match handle.channel_open_session().await {
            Ok(c) => c,
            Err(e) => {
                let err_msg = format!("Impossible d'ouvrir le canal SSH: {e}");
                logs.push(format!("[{}] ❌ {}", now(), err_msg));
                return Err((AppError::Sftp(err_msg), logs));
            }
        };

        match channel.request_subsystem(true, "sftp").await {
            Ok(_) => {
                logs.push(format!("[{}] Sous-système SFTP accepté par le serveur.", now()));
            }
            Err(e) => {
                let err_msg = format!("Le serveur a refusé le sous-système SFTP: {e}");
                logs.push(format!("[{}] ❌ {}", now(), err_msg));
                logs.push(format!(
                    "[{}] ℹ️ Conseil: Assurez-vous que la ligne 'Subsystem sftp' est activée dans /etc/ssh/sshd_config sur le serveur distant.",
                    now()
                ));
                return Err((AppError::Sftp(err_msg), logs));
            }
        }

        let sftp_session = match SftpSession::new(channel.into_stream()).await {
            Ok(s) => {
                logs.push(format!("[{}] ✅ Session SFTP initialisée avec succès ! Prêt pour la navigation et les transferts.", now()));
                s
            }
            Err(e) => {
                let err_msg = format!("Échec d'initialisation du protocole SFTP: {e}");
                logs.push(format!("[{}] ❌ {}", now(), err_msg));
                return Err((AppError::Sftp(err_msg), logs));
            }
        };

        Ok((
            Self {
                session: sftp_session,
                _handle: handle,
            },
            logs,
        ))
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
