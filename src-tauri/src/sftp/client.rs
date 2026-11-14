use async_trait::async_trait;
use chrono::{DateTime, Utc};
use russh::client::{self, Handle, Handler};
use russh::keys::PublicKeyOrCertificate;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::load_secret_key;
use russh_sftp::client::SftpSession;
use std::collections::HashMap;
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

#[derive(Debug, Clone, Default)]
pub struct UserGroupMaps {
    pub users: HashMap<u32, String>,
    pub groups: HashMap<u32, String>,
    pub current_uid: Option<u32>,
    pub current_gid: Option<u32>,
    pub is_complete: bool,
}

pub struct SftpProvider {
    session: SftpSession,
    _handle: Handle<SshHandler>,
    username: String,
    identities: tokio::sync::RwLock<Option<UserGroupMaps>>,
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

        logs.push(format!(
            "[{}] Démarrage de la séquence de connexion SFTP...",
            now()
        ));
        logs.push(format!(
            "[{}] Cible : {}:{}",
            now(),
            config.host,
            config.port
        ));
        logs.push(format!(
            "[{}] Utilisateur SSH : '{}'",
            now(),
            config.username
        ));

        let ssh_config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(30)),
            ..Default::default()
        });

        let addr = format!("{}:{}", config.host, config.port);
        logs.push(format!(
            "[{}] 1/4 Connexion TCP socket vers {}...",
            now(),
            addr
        ));

        let mut handle = match client::connect(ssh_config, &addr, SshHandler).await {
            Ok(h) => {
                logs.push(format!(
                    "[{}] Connexion TCP socket établie avec succès.",
                    now()
                ));
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

        logs.push(format!(
            "[{}] 2/4 Négociation KEX et algorithmes SSH validés.",
            now()
        ));
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

            logs.push(format!(
                "[{}] Méthode : Clé privée SSH ({})",
                now(),
                expanded_path.display()
            ));

            let p_clone = expanded_path.clone();
            let pass_clone = config.passphrase.clone();
            let secret_key_res = tokio::task::spawn_blocking(move || {
                load_secret_key(&p_clone, pass_clone.as_deref())
            })
            .await
            .map_err(|e| {
                (
                    AppError::Io(format!("Thread execution error while loading key: {e}")),
                    logs.clone(),
                )
            })?;

            let secret_key = match secret_key_res {
                Ok(k) => {
                    logs.push(format!(
                        "[{}] Clé privée chargée et déchiffrée avec succès (type: {:?}).",
                        now(),
                        k.algorithm()
                    ));
                    k
                }
                Err(e) => {
                    let err_msg = format!(
                        "Impossible de charger la clé {}: {e}",
                        expanded_path.display()
                    );
                    logs.push(format!("[{}] ❌ {}", now(), err_msg));
                    logs.push(format!(
                        "[{}] ℹ️ Conseil: Vérifiez le chemin ou saisissez la passphrase si la clé est chiffrée.",
                        now()
                    ));
                    return Err((AppError::Auth(err_msg), logs));
                }
            };

            let key_arc = Arc::new(secret_key);
            let mut authenticated = false;

            // Modern OpenSSH servers (Oracle Linux, Ubuntu 22+, Debian 12+, RHEL 9) reject legacy ssh-rsa (SHA-1).
            // They require rsa-sha2-512 or rsa-sha2-256. For ed25519/ecdsa, hash_alg is ignored.
            let hash_candidates: Vec<(Option<russh::keys::HashAlg>, &str)> =
                if key_arc.algorithm().is_rsa() {
                    vec![
                        (Some(russh::keys::HashAlg::Sha512), "rsa-sha2-512"),
                        (Some(russh::keys::HashAlg::Sha256), "rsa-sha2-256"),
                        (None, "ssh-rsa (legacy)"),
                    ]
                } else {
                    vec![(None, "standard")]
                };

            for (hash_alg, alg_name) in hash_candidates {
                logs.push(format!(
                    "[{}] Négociation de signature avec l'algorithme : {}...",
                    now(),
                    alg_name
                ));
                let key_with_alg = PrivateKeyWithHashAlg::new(key_arc.clone(), hash_alg);

                match handle
                    .authenticate_publickey(&config.username, key_with_alg)
                    .await
                {
                    Ok(res) if res.success() => {
                        logs.push(format!(
                            "[{}] Authentification par clé SSH acceptée ({}) !",
                            now(),
                            alg_name
                        ));
                        authenticated = true;
                        break;
                    }
                    Ok(_) => {
                        logs.push(format!(
                            "[{}] Algorithme {} refusé par le serveur, essai du suivant...",
                            now(),
                            alg_name
                        ));
                    }
                    Err(e) => {
                        logs.push(format!(
                            "[{}] Erreur technique avec algorithme {}: {}",
                            now(),
                            alg_name,
                            e
                        ));
                    }
                }
            }

            if !authenticated {
                let err_msg = "Le serveur SSH a rejeté la clé publique pour tous les algorithmes (SSH_MSG_USERAUTH_FAILURE)".to_string();
                logs.push(format!("[{}] ❌ {}", now(), err_msg));
                logs.push(format!(
                    "[{}] ℹ️ Conseil: Vérifiez que votre clé publique (.pub) est ajoutée dans ~/.ssh/authorized_keys sur le serveur pour l'utilisateur '{}'.",
                    now(),
                    config.username
                ));
                return Err((AppError::Auth(err_msg), logs));
            }
        } else if let Some(password) = config.password {
            logs.push(format!("[{}] Méthode : Mot de passe", now()));
            match handle
                .authenticate_password(&config.username, password)
                .await
            {
                Ok(res) if res.success() => {
                    logs.push(format!(
                        "[{}] Authentification par mot de passe acceptée !",
                        now()
                    ));
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
            logs.push(format!(
                "[{}] Recherche des clés SSH standard (~/.ssh/id_ed25519, ~/.ssh/id_rsa)...",
                now()
            ));
            let mut authenticated = false;
            if let Some(home) = dirs::home_dir() {
                let default_keys = [home.join(".ssh/id_ed25519"), home.join(".ssh/id_rsa")];
                for key_p in default_keys {
                    let p_check = key_p.clone();
                    let exists = tokio::task::spawn_blocking(move || p_check.exists())
                        .await
                        .unwrap_or(false);
                    if exists {
                        logs.push(format!("[{}] Tentative avec {}", now(), key_p.display()));
                        let p = key_p.clone();
                        let pass = config.passphrase.clone();
                        let loaded = tokio::task::spawn_blocking(move || {
                            load_secret_key(&p, pass.as_deref())
                        })
                        .await
                        .ok()
                        .and_then(|res| res.ok());

                        if let Some(key) = loaded {
                            let key_arc = Arc::new(key);
                            let hash_candidates: Vec<Option<russh::keys::HashAlg>> =
                                if key_arc.algorithm().is_rsa() {
                                    vec![
                                        Some(russh::keys::HashAlg::Sha512),
                                        Some(russh::keys::HashAlg::Sha256),
                                        None,
                                    ]
                                } else {
                                    vec![None]
                                };

                            for hash_alg in hash_candidates {
                                let key_with_alg =
                                    PrivateKeyWithHashAlg::new(key_arc.clone(), hash_alg);
                                if let Ok(res) = handle
                                    .authenticate_publickey(&config.username, key_with_alg)
                                    .await
                                {
                                    if res.success() {
                                        logs.push(format!(
                                            "[{}] Authentification réussie avec {}",
                                            now(),
                                            key_p.display()
                                        ));
                                        authenticated = true;
                                        break;
                                    }
                                }
                            }
                            if authenticated {
                                break;
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

        logs.push(format!(
            "[{}] 4/4 Ouverture du canal SSH et du sous-système SFTP...",
            now()
        ));
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
                logs.push(format!(
                    "[{}] Sous-système SFTP accepté par le serveur.",
                    now()
                ));
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
                username: config.username,
                identities: tokio::sync::RwLock::new(None),
            },
            logs,
        ))
    }

    pub async fn get_or_load_identities(&self) -> UserGroupMaps {
        // Fast path: if already cached and complete, return immediately
        {
            let reader = self.identities.read().await;
            if let Some(ref maps) = *reader {
                if maps.is_complete {
                    return maps.clone();
                }
            }
        }

        // Slow path: acquire write lock and reload/retry
        let mut writer = self.identities.write().await;
        if let Some(ref maps) = *writer {
            if maps.is_complete {
                return maps.clone();
            }
        }

        let maps = Self::load_system_identities(&self.session, &self.username).await;
        *writer = Some(maps.clone());
        maps
    }

    async fn load_system_identities(
        session: &SftpSession,
        current_username: &str,
    ) -> UserGroupMaps {
        let mut users = HashMap::new();
        let mut groups = HashMap::new();

        // 0 is root on Unix/Linux systems
        users.insert(0, "root".to_string());
        groups.insert(0, "root".to_string());

        // 1. Try to read /etc/passwd (up to 4MB, 1500ms timeout)
        let passwd_res = tokio::time::timeout(
            Duration::from_millis(1500),
            read_remote_text_file(session, "/etc/passwd", 4 * 1024 * 1024),
        )
        .await;

        let (passwd_opt, passwd_ok) = match passwd_res {
            Ok(Some(res)) if !res.truncated => (Some(res.content), true),
            Ok(Some(res)) => (Some(res.content), false), // truncated
            _ => (None, false),                          // timed out or error
        };

        let mut current_uid = None;
        let mut current_gid = None;

        if let Some(ref content) = passwd_opt {
            let parsed = parse_passwd(content, current_username);
            current_uid = parsed.current_uid;
            current_gid = parsed.current_gid;
            users.extend(parsed.users);
        }

        // 2. Try to read /etc/group (up to 4MB, 1500ms timeout)
        let group_res = tokio::time::timeout(
            Duration::from_millis(1500),
            read_remote_text_file(session, "/etc/group", 4 * 1024 * 1024),
        )
        .await;

        let (group_opt, group_ok) = match group_res {
            Ok(Some(res)) if !res.truncated => (Some(res.content), true),
            Ok(Some(res)) => (Some(res.content), false), // truncated
            _ => (None, false),                          // timed out or error
        };

        if let Some(ref content) = group_opt {
            groups.extend(parse_group(content));
        }

        // Complete if both files were successfully read without truncation
        let is_complete = passwd_ok && group_ok;

        UserGroupMaps {
            users,
            groups,
            current_uid,
            current_gid,
            is_complete,
        }
    }
}

struct RemoteTextResult {
    content: String,
    truncated: bool,
}

async fn read_remote_text_file(
    session: &SftpSession,
    path: &str,
    max_bytes: usize,
) -> Option<RemoteTextResult> {
    let mut file = session.open(path).await.ok()?;
    let mut content = Vec::new();
    let mut buf = [0u8; 8192];
    let mut truncated = false;

    loop {
        match file.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                if content.len() + n > max_bytes {
                    let remaining = max_bytes.saturating_sub(content.len());
                    content.extend_from_slice(&buf[..remaining]);
                    truncated = true;
                    break;
                } else {
                    content.extend_from_slice(&buf[..n]);
                }
            }
            Err(_) => return None,
        }
    }

    let text = String::from_utf8_lossy(&content).into_owned();
    Some(RemoteTextResult {
        content: text,
        truncated,
    })
}

#[derive(Debug, Clone, Default)]
pub struct PasswdInfo {
    pub users: HashMap<u32, String>,
    pub current_uid: Option<u32>,
    pub current_gid: Option<u32>,
}

pub fn parse_passwd(content: &str, current_username: &str) -> PasswdInfo {
    let mut users = HashMap::new();
    let mut current_uid = None;
    let mut current_gid = None;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() >= 3 {
            let name = parts[0].trim();
            if let Ok(uid) = parts[2].trim().parse::<u32>() {
                if name == current_username {
                    current_uid = Some(uid);
                    if parts.len() >= 4 {
                        if let Ok(gid) = parts[3].trim().parse::<u32>() {
                            current_gid = Some(gid);
                        }
                    }
                }
                users.insert(uid, name.to_string());
            }
        }
    }

    PasswdInfo {
        users,
        current_uid,
        current_gid,
    }
}

pub fn parse_group(content: &str) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() >= 3 {
            let name = parts[0].trim();
            if let Ok(gid) = parts[2].trim().parse::<u32>() {
                map.insert(gid, name.to_string());
            }
        }
    }
    map
}

pub fn resolve_identity(
    id: Option<u32>,
    cache: &HashMap<u32, String>,
    current_id: Option<u32>,
    current_name: &str,
) -> Option<String> {
    id.map(|val| {
        if let Some(name) = cache.get(&val) {
            name.clone()
        } else if Some(val) == current_id {
            current_name.to_string()
        } else {
            val.to_string()
        }
    })
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
        format!(
            "{}{}{}{}{}{}{}{}{}",
            r_usr, w_usr, x_usr, r_grp, w_grp, x_grp, r_oth, w_oth, x_oth
        )
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

        let identities = self.get_or_load_identities().await;

        let mut entries = Vec::new();
        for entry in read_dir {
            let is_dir = entry.file_type().is_dir();
            let meta = entry.metadata();
            let size = meta.size.unwrap_or(0);
            let permissions = format_permissions(meta.permissions, is_dir);
            let modified_at = format_mtime(meta.mtime);

            let owner = resolve_identity(
                meta.uid,
                &identities.users,
                identities.current_uid,
                &self.username,
            );
            let group = resolve_identity(
                meta.gid,
                &identities.groups,
                identities.current_gid,
                &self.username,
            );

            entries.push(FileEntry {
                name: entry.file_name(),
                path: entry.path(),
                is_dir,
                size,
                modified_at,
                permissions: Some(permissions),
                owner,
                group,
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
        self.session.rename(old_path, new_path).await.map_err(|e| {
            AppError::Sftp(format!("Failed to rename {old_path} to {new_path}: {e}"))
        })?;
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
        let mut local_file = tokio::fs::File::open(&local_path).await.map_err(|e| {
            AppError::Io(format!(
                "Cannot open local file {}: {e}",
                local_path.display()
            ))
        })?;

        let total_bytes = local_file
            .metadata()
            .await
            .map_err(|e| AppError::Io(format!("Cannot get local file size: {e}")))?
            .len();

        let mut remote_file =
            self.session.create(&remote_path).await.map_err(|e| {
                AppError::Sftp(format!("Cannot create remote file {remote_path}: {e}"))
            })?;

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
        let mut remote_file =
            self.session.open(&remote_path).await.map_err(|e| {
                AppError::Sftp(format!("Cannot open remote file {remote_path}: {e}"))
            })?;

        let meta = remote_file
            .metadata()
            .await
            .map_err(|e| AppError::Sftp(format!("Cannot get remote file metadata: {e}")))?;
        let total_bytes = meta.size.unwrap_or(0);

        let mut local_file = tokio::fs::File::create(&local_path).await.map_err(|e| {
            AppError::Io(format!(
                "Cannot create local file {}: {e}",
                local_path.display()
            ))
        })?;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_passwd() {
        let passwd = r#"
# Standard Linux passwd file
root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin
ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash
mathieu:x:1001:1001:Mathieu Cuvelier:/home/mathieu:/bin/zsh
alice:x:1002:1002:Alice:/home/alice:/bin/bash
"#;
        let parsed = parse_passwd(passwd, "mathieu");
        assert_eq!(parsed.users.get(&0).unwrap(), "root");
        assert_eq!(parsed.users.get(&1).unwrap(), "daemon");
        assert_eq!(parsed.users.get(&33).unwrap(), "www-data");
        assert_eq!(parsed.users.get(&1000).unwrap(), "ubuntu");
        assert_eq!(parsed.users.get(&1001).unwrap(), "mathieu");
        assert_eq!(parsed.users.get(&1002).unwrap(), "alice");
        assert_eq!(parsed.users.get(&9999), None);
        assert_eq!(parsed.current_uid, Some(1001));
        assert_eq!(parsed.current_gid, Some(1001));
    }

    #[test]
    fn test_parse_passwd_lossy_utf8() {
        // Simulates Latin-1 accented bytes in GECOS comment
        let raw_bytes: &[u8] = b"mathieu:x:1001:1001:Mathieu \xe9l\xe8ve:/home/mathieu:/bin/bash\n";
        let text = String::from_utf8_lossy(raw_bytes).into_owned();
        let parsed = parse_passwd(&text, "mathieu");
        assert_eq!(parsed.users.get(&1001).unwrap(), "mathieu");
        assert_eq!(parsed.current_uid, Some(1001));
        assert_eq!(parsed.current_gid, Some(1001));
    }

    #[test]
    fn test_parse_group() {
        let group = r#"
root:x:0:
daemon:x:1:
www-data:x:33:
ubuntu:x:1000:
mathieu:x:1001:
docker:x:999:ubuntu,mathieu
"#;
        let map = parse_group(group);
        assert_eq!(map.get(&0).unwrap(), "root");
        assert_eq!(map.get(&1).unwrap(), "daemon");
        assert_eq!(map.get(&33).unwrap(), "www-data");
        assert_eq!(map.get(&1000).unwrap(), "ubuntu");
        assert_eq!(map.get(&1001).unwrap(), "mathieu");
        assert_eq!(map.get(&999).unwrap(), "docker");
    }

    #[test]
    fn test_resolve_identity() {
        let mut users = HashMap::new();
        users.insert(0, "root".to_string());
        users.insert(1000, "ubuntu".to_string());
        users.insert(1001, "mathieu".to_string());

        let current_username = "mathieu";
        let current_uid = Some(1001);

        // 1. Root
        assert_eq!(
            resolve_identity(Some(0), &users, current_uid, current_username),
            Some("root".to_string())
        );
        // 2. User 1000 is ubuntu (not mathieu!)
        assert_eq!(
            resolve_identity(Some(1000), &users, current_uid, current_username),
            Some("ubuntu".to_string())
        );
        // 3. User 1001 is mathieu
        assert_eq!(
            resolve_identity(Some(1001), &users, current_uid, current_username),
            Some("mathieu".to_string())
        );
        // 4. Unknown UID displays as string
        assert_eq!(
            resolve_identity(Some(1050), &users, current_uid, current_username),
            Some("1050".to_string())
        );
        // 5. None returns None
        assert_eq!(
            resolve_identity(None, &users, current_uid, current_username),
            None
        );

        // 6. Chroot fallback test where cache only has root, but current_uid is known
        let mut fallback_users = HashMap::new();
        fallback_users.insert(0, "root".to_string());
        assert_eq!(
            resolve_identity(Some(1001), &fallback_users, Some(1001), current_username),
            Some("mathieu".to_string())
        );
        assert_eq!(
            resolve_identity(Some(1000), &fallback_users, Some(1001), current_username),
            Some("1000".to_string())
        );
    }
}
