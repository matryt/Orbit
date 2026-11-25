use async_trait::async_trait;
use chrono::{DateTime, Utc};
use russh::ChannelStream;
use russh::client::{self, Handle, Handler};
use russh::keys::PublicKeyOrCertificate;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::load_secret_key;
use russh_sftp::client::SftpSession;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::error::AppError;
use crate::models::{
    FileEntry, HostKeyDecision, HostKeyPromptRequest, RemoteFingerprint, SftpConnectConfig,
    SudoCapability,
};
use crate::provider::StorageProvider;
use crate::sftp::agent;
use crate::sftp::host_key::{
    HostKeyPromptHandler, HostKeyPromptManager, replace_known_hosts_entry_atomic, validate_ssh_host,
};
use crate::transfer::{
    TransferHandle, create_partial_download_file, finalize_partial_download, partial_download_path,
};

/// Verrou global pour sérialiser les opérations de vérification et d'enregistrement dans ~/.ssh/known_hosts
/// afin d'éviter les conditions de concurrence (race conditions) entre connexions concurrentes.
/// Chunk size used for SFTP reads/writes during transfers.
const TRANSFER_CHUNK_SIZE: usize = 64 * 1024;

/// Credentials and method selection for one SSH authentication (target or bastion).
pub(crate) struct AuthRequest<'a> {
    pub username: &'a str,
    /// "password" | "key" | "agent"; `None` infers the method from the other fields.
    pub auth_type: Option<&'a str>,
    pub key_path: Option<&'a str>,
    pub passphrase: Option<&'a str>,
    pub password: Option<&'a str>,
    pub agent_socket: Option<&'a str>,
}

/// Result of an authentication attempt through an SSH agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentAuthOutcome {
    Accepted,
    /// No identity could be offered: nothing was sent to the server.
    Unavailable(agent::AgentLookupFailure),
    /// The agent declined every signature (e.g. Touch ID / 1Password prompt dismissed).
    SigningFailed,
    /// The server refused every offered key.
    Rejected,
}

static KNOWN_HOSTS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Vérifie si un certificat OpenSSH est validé par une autorité @cert-authority déclarée dans ~/.ssh/known_hosts.
pub fn check_cert_authority(
    host: &str,
    port: u16,
    cert: &russh::keys::ssh_key::Certificate,
) -> Result<bool, russh::keys::Error> {
    let known_hosts_path = match dirs::home_dir() {
        Some(h) => h.join(".ssh").join("known_hosts"),
        None => return Ok(false),
    };

    let f = match std::fs::File::open(&known_hosts_path) {
        Ok(f) => f,
        Err(_) => return Ok(false),
    };

    use std::io::BufRead;
    let reader = std::io::BufReader::new(f);
    let ca_key_data = cert.signature_key();

    let host_port = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if !trimmed.starts_with("@cert-authority") {
            continue;
        }

        // Format OpenSSH : @cert-authority <patterns> <key-type> <base64-key> [comment]
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() < 4 {
            continue;
        }

        let patterns = parts[1];
        let ca_base64 = parts[3];

        let host_matches = patterns.split(',').any(|pattern| {
            if pattern == "*" || pattern == host || pattern == host_port {
                true
            } else if let Some(suffix) = pattern.strip_prefix("*.") {
                host.ends_with(suffix) && host.len() > suffix.len()
            } else {
                false
            }
        });

        if !host_matches {
            continue;
        }

        if let Ok(ca_pubkey) = russh::keys::parse_public_key_base64(ca_base64) {
            if ca_pubkey.key_data() == ca_key_data {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

struct PromptGuard<'a>(&'a AtomicBool);

impl<'a> PromptGuard<'a> {
    fn new(flag: &'a AtomicBool) -> Self {
        flag.store(true, Ordering::SeqCst);
        Self(flag)
    }
}

impl<'a> Drop for PromptGuard<'a> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub struct SshHandler {
    host: String,
    port: u16,
    key_status: Arc<tokio::sync::Mutex<Option<HostKeyStatus>>>,
    prompt_handler: Option<Arc<dyn HostKeyPromptHandler + Send + Sync>>,
    prompt_active: Arc<AtomicBool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyStatus {
    /// Clé d'hôte trouvée et validée dans ~/.ssh/known_hosts (ou autorité CA @cert-authority).
    Verified,
    /// Clé d'hôte en attente d'enregistrement (différé jusqu'au succès réel de la connexion).
    PendingEnrollment(russh::keys::ssh_key::PublicKey),
    /// Clé d'hôte modifiée en attente de remplacement (différé jusqu'au succès réel de la connexion).
    PendingReplacement {
        pubkey: russh::keys::ssh_key::PublicKey,
        line: usize,
    },
    /// Nouvel hôte : clé acceptée et enregistrée dans ~/.ssh/known_hosts (TOFU).
    Learned,
    /// Clé approuvée pour cette session uniquement (non enregistrée sur le disque).
    AcceptedOnce,
    /// Clé rejetée par l'utilisateur.
    Rejected(String),
    /// Clé d'hôte modifiée ! Potentielle attaque Man-in-the-Middle.
    Changed { line: usize },
    /// Erreur lors de la vérification (fail-closed par sécurité).
    CheckFailed(String),
}

impl SshHandler {
    pub fn new(
        host: String,
        port: u16,
        key_status: Arc<tokio::sync::Mutex<Option<HostKeyStatus>>>,
        prompt_handler: Option<Arc<dyn HostKeyPromptHandler + Send + Sync>>,
    ) -> Self {
        Self::with_prompt_tracker(
            host,
            port,
            key_status,
            prompt_handler,
            Arc::new(AtomicBool::new(false)),
        )
    }

    pub fn with_prompt_tracker(
        host: String,
        port: u16,
        key_status: Arc<tokio::sync::Mutex<Option<HostKeyStatus>>>,
        prompt_handler: Option<Arc<dyn HostKeyPromptHandler + Send + Sync>>,
        prompt_active: Arc<AtomicBool>,
    ) -> Self {
        Self {
            host,
            port,
            key_status,
            prompt_handler,
            prompt_active,
        }
    }
}

impl Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let host = self.host.clone();
        let port = self.port;
        let key_status = Arc::clone(&self.key_status);

        // Si le serveur présente un certificat OpenSSH, valider la signature, les dates et @cert-authority
        let pubkey = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => {
                if let Err(e) = cert.verify_signature() {
                    let mut status = key_status.lock().await;
                    *status = Some(HostKeyStatus::CheckFailed(format!(
                        "Signature du certificat d'hôte invalide : {e}"
                    )));
                    return Ok(false);
                }

                let now_ts = Utc::now().timestamp() as u64;
                if now_ts < cert.valid_after() || now_ts >= cert.valid_before() {
                    let mut status = key_status.lock().await;
                    *status = Some(HostKeyStatus::CheckFailed(format!(
                        "Certificat d'hôte SSH expiré ou pas encore valide (validité: {} - {})",
                        cert.valid_after(),
                        cert.valid_before()
                    )));
                    return Ok(false);
                }

                let principals = cert.valid_principals();
                if !principals.is_empty()
                    && !principals
                        .iter()
                        .any(|p| p == &host || (p.starts_with("*.") && host.ends_with(&p[1..])))
                {
                    let mut status = key_status.lock().await;
                    *status = Some(HostKeyStatus::CheckFailed(format!(
                        "Le certificat d'hôte n'est pas valide pour {host} (principaux autorisés: {principals:?})"
                    )));
                    return Ok(false);
                }

                // Vérifier si une autorité de certification @cert-authority valide ce certificat
                let cert_clone = cert.clone();
                let host_clone = host.clone();
                let ca_check = tokio::task::spawn_blocking(move || {
                    check_cert_authority(&host_clone, port, &cert_clone)
                })
                .await;

                if let Ok(Ok(true)) = ca_check {
                    let mut status = key_status.lock().await;
                    *status = Some(HostKeyStatus::Verified);
                    return Ok(true);
                }

                russh::keys::ssh_key::PublicKey::from(cert.public_key().clone())
            }
        };

        // Sérialisation des opérations known_hosts pour la vérification (verrou relâché immédiatement après)
        let check_res = {
            let _lock = KNOWN_HOSTS_LOCK.lock().await;
            tokio::task::spawn_blocking({
                let host = host.clone();
                let pubkey = pubkey.clone();
                move || russh::keys::check_known_hosts(&host, port, &pubkey)
            })
            .await
        };

        match check_res {
            Ok(Ok(true)) => {
                let mut status = key_status.lock().await;
                *status = Some(HostKeyStatus::Verified);
                Ok(true)
            }
            Ok(Ok(false)) => {
                // Clé inconnue (nouvel hôte).
                let key_type = pubkey.algorithm().to_string();
                let fingerprint = pubkey
                    .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
                    .to_string();

                if let Some(ref handler) = self.prompt_handler {
                    let req = HostKeyPromptRequest {
                        request_id: HostKeyPromptManager::generate_request_id(),
                        host: host.clone(),
                        port,
                        key_type,
                        fingerprint,
                        is_new: true,
                        changed_line: None,
                    };

                    let _guard = PromptGuard::new(&self.prompt_active);
                    let decision = handler.prompt(req).await;
                    drop(_guard);
                    match decision {
                        HostKeyDecision::AcceptAndRemember => {
                            let mut status = key_status.lock().await;
                            *status = Some(HostKeyStatus::PendingEnrollment(pubkey));
                            Ok(true)
                        }
                        HostKeyDecision::AcceptOnce => {
                            let mut status = key_status.lock().await;
                            *status = Some(HostKeyStatus::AcceptedOnce);
                            Ok(true)
                        }
                        HostKeyDecision::Reject => {
                            let mut status = key_status.lock().await;
                            *status = Some(HostKeyStatus::Rejected(
                                "Connexion annulée : l'empreinte de la clé d'hôte a été refusée."
                                    .into(),
                            ));
                            Ok(false)
                        }
                    }
                } else {
                    // Mode sans invite (ex: appel programmatique sans UI) : rejet strict par sécurité
                    let mut status = key_status.lock().await;
                    *status = Some(HostKeyStatus::Rejected(
                        "Clé d'hôte SSH inconnue et aucun gestionnaire d'approbation disponible."
                            .into(),
                    ));
                    Ok(false)
                }
            }
            Ok(Err(russh::keys::Error::KeyChanged { line })) => {
                // CRITICAL: Server host key has changed.
                let key_type = pubkey.algorithm().to_string();
                let fingerprint = pubkey
                    .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
                    .to_string();

                if let Some(ref handler) = self.prompt_handler {
                    let req = HostKeyPromptRequest {
                        request_id: HostKeyPromptManager::generate_request_id(),
                        host: host.clone(),
                        port,
                        key_type,
                        fingerprint,
                        is_new: false,
                        changed_line: Some(line),
                    };

                    let _guard = PromptGuard::new(&self.prompt_active);
                    let decision = handler.prompt(req).await;
                    drop(_guard);
                    match decision {
                        HostKeyDecision::AcceptAndRemember => {
                            let mut status = key_status.lock().await;
                            *status = Some(HostKeyStatus::PendingReplacement { pubkey, line });
                            Ok(true)
                        }
                        HostKeyDecision::AcceptOnce => {
                            let mut status = key_status.lock().await;
                            *status = Some(HostKeyStatus::AcceptedOnce);
                            Ok(true)
                        }
                        HostKeyDecision::Reject => {
                            let mut status = key_status.lock().await;
                            *status = Some(HostKeyStatus::Changed { line });
                            Ok(false)
                        }
                    }
                } else {
                    // Mode sans invite : fail-closed immédiat
                    let mut status = key_status.lock().await;
                    *status = Some(HostKeyStatus::Changed { line });
                    Ok(false)
                }
            }
            Ok(Err(e)) => {
                let mut status = key_status.lock().await;
                *status = Some(HostKeyStatus::CheckFailed(format!("{e}")));
                // Fail-closed : ne pas autoriser la connexion si la vérification échoue
                Ok(false)
            }
            Err(e) => {
                let mut status = key_status.lock().await;
                *status = Some(HostKeyStatus::CheckFailed(format!("Task join error: {e}")));
                // Fail-closed
                Ok(false)
            }
        }
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
    _bastion_handle: Option<Handle<SshHandler>>,
    username: String,
    identities: tokio::sync::RwLock<Option<UserGroupMaps>>,
    pub host_key_status: Option<HostKeyStatus>,
    pub is_elevated: bool,
    pub sudo_capability: SudoCapability,
}

/// Maximum number of bytes read from the sudo probe channel. The answer is a single short
/// line; anything beyond this comes from shell start-up noise or a hostile server and is dropped.
const SUDO_PROBE_MAX_OUTPUT: usize = 4096;

/// Returns the capability announced by the first line that is exactly a probe token.
///
/// Only whole lines count: a token embedded in other text (a banner, an `echo` in a shell
/// start-up file, ANSI escape sequences) is ignored.
fn find_sudo_probe_token(text: &str) -> Option<SudoCapability> {
    text.lines().find_map(|line| match line {
        "ORBIT_SUDO:NOPASSWD" => Some(SudoCapability::Passwordless),
        "ORBIT_SUDO:PASSWD" => Some(SudoCapability::PasswordRequired),
        "ORBIT_SUDO:NONE" => Some(SudoCapability::None),
        _ => None,
    })
}

pub fn parse_sudo_probe_output(text: &str) -> SudoCapability {
    find_sudo_probe_token(text).unwrap_or(SudoCapability::None)
}

/// Appends a chunk of probe output, keeping at most `SUDO_PROBE_MAX_OUTPUT` bytes.
/// Returns `true` once reading can stop: a complete token line was received or the cap is hit.
fn push_sudo_probe_output(output: &mut Vec<u8>, data: &[u8]) -> bool {
    let room = SUDO_PROBE_MAX_OUTPUT.saturating_sub(output.len());
    output.extend_from_slice(&data[..data.len().min(room)]);
    if output.len() >= SUDO_PROBE_MAX_OUTPUT {
        return true;
    }
    // Only complete lines are considered, so a token split across two chunks is not misread.
    match output.iter().rposition(|&b| b == b'\n') {
        Some(end) => find_sudo_probe_token(&String::from_utf8_lossy(&output[..=end])).is_some(),
        None => false,
    }
}

pub enum SshStream {
    Tcp(tokio::net::TcpStream),
    Channel(ChannelStream<russh::client::Msg>),
}

impl tokio::io::AsyncRead for SshStream {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match *self {
            SshStream::Tcp(ref mut s) => std::pin::Pin::new(s).poll_read(cx, buf),
            SshStream::Channel(ref mut s) => std::pin::Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl tokio::io::AsyncWrite for SshStream {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<Result<usize, std::io::Error>> {
        match *self {
            SshStream::Tcp(ref mut s) => std::pin::Pin::new(s).poll_write(cx, buf),
            SshStream::Channel(ref mut s) => std::pin::Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        match *self {
            SshStream::Tcp(ref mut s) => std::pin::Pin::new(s).poll_flush(cx),
            SshStream::Channel(ref mut s) => std::pin::Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), std::io::Error>> {
        match *self {
            SshStream::Tcp(ref mut s) => std::pin::Pin::new(s).poll_shutdown(cx),
            SshStream::Channel(ref mut s) => std::pin::Pin::new(s).poll_shutdown(cx),
        }
    }
}

impl SftpProvider {
    pub async fn connect(config: SftpConnectConfig) -> Result<Self, AppError> {
        Self::connect_with_prompt(config, None).await
    }

    pub async fn connect_with_prompt(
        config: SftpConnectConfig,
        prompt_handler: Option<Arc<dyn HostKeyPromptHandler + Send + Sync>>,
    ) -> Result<Self, AppError> {
        let (provider, logs) = Self::connect_with_logs_and_prompt(config, prompt_handler)
            .await
            .map_err(|(e, _)| e)?;
        for line in &logs {
            eprintln!("{line}");
        }
        Ok(provider)
    }

    async fn probe_sudo_capability(handle: &Handle<SshHandler>) -> SudoCapability {
        let channel_fut = handle.channel_open_session();
        let mut channel = match tokio::time::timeout(Duration::from_secs(3), channel_fut).await {
            Ok(Ok(c)) => c,
            _ => return SudoCapability::None,
        };

        let probe_cmd = "if sudo -n true 2>/dev/null; then echo ORBIT_SUDO:NOPASSWD; elif [ -x \"$(command -v sudo)\" ]; then if id -Gn 2>/dev/null | grep -Eq '\\b(sudo|wheel|admin)\\b'; then echo ORBIT_SUDO:PASSWD; else echo ORBIT_SUDO:NONE; fi; else echo ORBIT_SUDO:NONE; fi";

        if tokio::time::timeout(Duration::from_secs(3), channel.exec(true, probe_cmd))
            .await
            .map_or(true, |r| r.is_err())
        {
            return SudoCapability::None;
        }

        let mut output = Vec::new();
        let read_fut = async {
            while let Some(msg) = channel.wait().await {
                if let russh::ChannelMsg::Data { ref data } = msg {
                    if push_sudo_probe_output(&mut output, data) {
                        break;
                    }
                }
            }
        };

        let _ = tokio::time::timeout(Duration::from_secs(3), read_fut).await;

        let text = String::from_utf8_lossy(&output);
        parse_sudo_probe_output(&text)
    }

    pub async fn connect_with_logs(
        config: SftpConnectConfig,
    ) -> Result<(Self, Vec<String>), (AppError, Vec<String>)> {
        Self::connect_with_logs_and_prompt(config, None).await
    }

    async fn connect_ssh_over_stream(
        stream: SshStream,
        host: &str,
        port: u16,
        ssh_config: Arc<client::Config>,
        prompt_handler: Option<Arc<dyn HostKeyPromptHandler + Send + Sync>>,
        target_label: &str,
        logs: &mut Vec<String>,
    ) -> Result<
        (
            Handle<SshHandler>,
            Arc<tokio::sync::Mutex<Option<HostKeyStatus>>>,
        ),
        (AppError, Vec<String>),
    > {
        let now = || Utc::now().format("%H:%M:%S%.3f").to_string();
        let addr = format!("{host}:{port}");
        let key_status = Arc::new(tokio::sync::Mutex::new(None));
        let prompt_active = Arc::new(AtomicBool::new(false));
        let handler = SshHandler::with_prompt_tracker(
            host.to_string(),
            port,
            Arc::clone(&key_status),
            prompt_handler,
            Arc::clone(&prompt_active),
        );

        let connect_fut = client::connect_stream(ssh_config, stream, handler);
        tokio::pin!(connect_fut);

        let mut network_elapsed = Duration::ZERO;
        let step = Duration::from_millis(200);
        let timeout_limit = Duration::from_secs(15);

        let connect_res = loop {
            tokio::select! {
                res = &mut connect_fut => {
                    break Ok(res);
                }
                _ = tokio::time::sleep(step) => {
                    if !prompt_active.load(Ordering::SeqCst) {
                        network_elapsed += step;
                        if network_elapsed >= timeout_limit {
                            break Err(());
                        }
                    }
                }
            }
        };

        let handle = match connect_res {
            Ok(Ok(h)) => {
                logs.push(format!(
                    "[{}] [{target_label}] Connexion SSH établie avec succès vers {addr}.",
                    now()
                ));
                let recorded_status = key_status.lock().await.clone();
                match recorded_status {
                    Some(HostKeyStatus::Verified) => {
                        logs.push(format!(
                            "[{}] [{target_label}] 🛡️ Empreinte de clé d'hôte validée via ~/.ssh/known_hosts.",
                            now()
                        ));
                    }
                    Some(HostKeyStatus::PendingEnrollment(_)) => {
                        logs.push(format!(
                            "[{}] [{target_label}] 🔑 Empreinte approuvée par l'utilisateur (sera enregistrée sur disque après authentification).",
                            now()
                        ));
                    }
                    Some(HostKeyStatus::PendingReplacement { .. }) => {
                        logs.push(format!(
                            "[{}] [{target_label}] 🔄 Remplacement de l'empreinte approuvé par l'utilisateur.",
                            now()
                        ));
                    }
                    Some(HostKeyStatus::AcceptedOnce) => {
                        logs.push(format!(
                            "[{}] [{target_label}] ⚠️ Clé d'hôte approuvée pour cette session uniquement.",
                            now()
                        ));
                    }
                    Some(HostKeyStatus::Learned) => {
                        logs.push(format!(
                            "[{}] [{target_label}] 🔑 Nouvel hôte approuvé : clé enregistrée dans ~/.ssh/known_hosts.",
                            now()
                        ));
                    }
                    Some(HostKeyStatus::CheckFailed(reason)) => {
                        logs.push(format!(
                            "[{}] [{target_label}] ⚠️ Avertissement known_hosts : {reason}",
                            now()
                        ));
                    }
                    _ => {}
                }
                h
            }
            Ok(Err(e)) => {
                let recorded_status = key_status.lock().await.clone();
                if let Some(HostKeyStatus::Rejected(ref reason)) = recorded_status {
                    logs.push(format!(
                        "[{}] [{target_label}] ❌ Connexion annulée : {reason}",
                        now()
                    ));
                    return Err((
                        AppError::Ssh(format!("Connexion annulée : {reason}")),
                        logs.clone(),
                    ));
                }

                if let Some(HostKeyStatus::Changed { line }) = recorded_status {
                    let target_spec = if port == 22 {
                        host.to_string()
                    } else {
                        format!("[{host}]:{port}")
                    };
                    let err_msg = format!(
                        "ALERTE DE SÉCURITÉ MITM : La clé d'hôte SSH pour {target_label} ({addr}) a CHANGÉ (ligne {line} dans ~/.ssh/known_hosts) ! Connexion bloquée."
                    );
                    logs.push(format!("[{}] [{target_label}] 🚨 {err_msg}", now()));
                    logs.push(format!(
                        "[{}] [{target_label}] ℹ️ Si le serveur a été réinstallé, supprimez l'ancienne clé avec : ssh-keygen -R {target_spec}",
                        now()
                    ));
                    return Err((AppError::Ssh(err_msg), logs.clone()));
                }

                if let Some(HostKeyStatus::CheckFailed(reason)) = recorded_status {
                    let err_msg = format!(
                        "Échec de vérification de la clé d'hôte SSH ({target_label}) : {reason}"
                    );
                    logs.push(format!("[{}] [{target_label}] ❌ {err_msg}", now()));
                    return Err((AppError::Ssh(err_msg), logs.clone()));
                }

                let err_msg = format!("Échec de connexion SSH vers {target_label} ({addr}): {e}");
                logs.push(format!("[{}] [{target_label}] ❌ {err_msg}", now()));
                return Err((AppError::Ssh(err_msg), logs.clone()));
            }
            Err(_) => {
                let err_msg = format!(
                    "Délai d'attente dépassé (timeout 15s) lors de la négociation SSH avec {target_label} ({addr})"
                );
                logs.push(format!("[{}] [{target_label}] ❌ {err_msg}", now()));
                return Err((AppError::Ssh(err_msg), logs.clone()));
            }
        };

        Ok((handle, key_status))
    }

    /// Tries every usable identity of the first suitable SSH agent.
    ///
    /// Every step is logged; failures are not fatal so the caller can fall back to another
    /// method. The outcome tells apart client-side failures (nothing sent to the server) from a
    /// genuine rejection by the server.
    async fn try_agent_auth(
        handle: &mut Handle<SshHandler>,
        username: &str,
        agent_socket: Option<&str>,
        wanted: Option<&russh::keys::PublicKey>,
        target_label: &str,
        logs: &mut Vec<String>,
    ) -> AgentAuthOutcome {
        let now = || Utc::now().format("%H:%M:%S%.3f").to_string();
        logs.push(format!(
            "[{}] [{target_label}] Méthode : Agent SSH{}",
            now(),
            if wanted.is_some() {
                " (identité ciblée par la clé publique)"
            } else {
                ""
            }
        ));

        let candidates = agent::default_candidates(agent_socket);
        let mut probe_logs = Vec::new();
        let connected = agent::connect_agent(&candidates, wanted, &mut probe_logs).await;
        for line in probe_logs {
            logs.push(format!("[{}] [{target_label}] {line}", now()));
        }
        let mut connected = match connected {
            Ok(c) => c,
            Err(failure) => {
                logs.push(format!(
                    "[{}] [{target_label}] {} (aucune clé envoyée au serveur).",
                    now(),
                    failure.message()
                ));
                logs.push(format!(
                    "[{}] [{target_label}] ℹ️ Conseil : {}",
                    now(),
                    failure.hint()
                ));
                return AgentAuthOutcome::Unavailable(failure);
            }
        };

        // Resolved lazily: waiting for the server's EXT_INFO costs up to a second.
        let mut rsa_hashes: Option<Vec<Option<russh::keys::HashAlg>>> = None;
        let key_count = connected.keys.len();
        let mut server_rejected = false;

        for key in connected.keys.clone() {
            let fingerprint = key.fingerprint(russh::keys::HashAlg::Sha256);
            let label = if key.comment().is_empty() {
                fingerprint.to_string()
            } else {
                format!("{} ({fingerprint})", key.comment())
            };

            let hashes = if key.algorithm().is_rsa() {
                if rsa_hashes.is_none() {
                    rsa_hashes = Some(match handle.best_supported_rsa_hash().await {
                        Ok(Some(h)) => vec![h],
                        _ => vec![
                            Some(russh::keys::HashAlg::Sha512),
                            Some(russh::keys::HashAlg::Sha256),
                            None,
                        ],
                    });
                }
                rsa_hashes.clone().unwrap_or_default()
            } else {
                vec![None]
            };

            logs.push(format!(
                "[{}] [{target_label}] Essai de la clé de l'agent {label}...",
                now()
            ));
            for hash_alg in hashes {
                match handle
                    .authenticate_publickey_with(
                        username,
                        key.clone(),
                        hash_alg,
                        &mut connected.client,
                    )
                    .await
                {
                    Ok(res) if res.success() => {
                        logs.push(format!(
                            "[{}] [{target_label}] Authentification par agent acceptée ({label}) !",
                            now()
                        ));
                        return AgentAuthOutcome::Accepted;
                    }
                    Ok(_) => server_rejected = true,
                    Err(e) => {
                        // Typically the user dismissed the 1Password / Touch ID prompt.
                        logs.push(format!(
                            "[{}] [{target_label}] L'agent n'a pas signé avec {label} : {e}",
                            now()
                        ));
                        break;
                    }
                }
            }
        }

        if !server_rejected {
            logs.push(format!(
                "[{}] [{target_label}] L'agent {} n'a signé avec aucune clé (autorisation refusée ou annulée ?).",
                now(),
                connected.candidate.describe()
            ));
            return AgentAuthOutcome::SigningFailed;
        }

        logs.push(format!(
            "[{}] [{target_label}] Le serveur a refusé les {key_count} clé(s) de l'agent {}.",
            now(),
            connected.candidate.describe()
        ));
        logs.push(format!(
            "[{}] [{target_label}] ℹ️ Conseil : {}",
            now(),
            if wanted.is_none() && key_count > 3 {
                "indiquez la clé à utiliser dans le profil pour éviter « Too many authentication failures »."
            } else {
                "vérifiez que la clé publique figure dans ~/.ssh/authorized_keys de cet utilisateur sur le serveur."
            }
        ));
        AgentAuthOutcome::Rejected
    }

    async fn authenticate_session(
        handle: &mut Handle<SshHandler>,
        req: &AuthRequest<'_>,
        target_label: &str,
        logs: &mut Vec<String>,
    ) -> Result<(), (AppError, Vec<String>)> {
        let now = || Utc::now().format("%H:%M:%S%.3f").to_string();
        let username = req.username;
        let passphrase = req.passphrase;
        logs.push(format!(
            "[{}] [{target_label}] Début de l'authentification pour l'utilisateur '{username}'...",
            now()
        ));

        let key_path = req
            .key_path
            .filter(|p| !p.trim().is_empty())
            .map(|kp| agent::expand_home(kp.trim(), dirs::home_dir().as_deref()));
        let wants_agent = req.auth_type == Some("agent")
            || key_path.as_deref().is_some_and(agent::is_public_key_path);

        if wants_agent {
            let wanted = match key_path.clone() {
                Some(p) => tokio::task::spawn_blocking(move || agent::load_wanted_public_key(&p))
                    .await
                    .ok()
                    .flatten(),
                None => None,
            };
            if let (Some(p), None) = (key_path.as_ref(), wanted.as_ref()) {
                let err_msg = format!(
                    "Impossible de lire la clé publique {} pour cibler l'identité de l'agent",
                    p.display()
                );
                logs.push(format!("[{}] [{target_label}] ❌ {err_msg}", now()));
                return Err((AppError::Auth(err_msg), logs.clone()));
            }
            let outcome = Self::try_agent_auth(
                handle,
                username,
                req.agent_socket,
                wanted.as_ref(),
                target_label,
                logs,
            )
            .await;
            let err_msg = match outcome {
                AgentAuthOutcome::Accepted => return Ok(()),
                AgentAuthOutcome::Unavailable(failure) => {
                    format!("{} ({target_label})", failure.message())
                }
                AgentAuthOutcome::SigningFailed => {
                    format!("L'agent SSH n'a pas signé la demande ({target_label})")
                }
                AgentAuthOutcome::Rejected => {
                    format!("Le serveur ({target_label}) a refusé les clés de l'agent SSH")
                }
            };
            logs.push(format!("[{}] [{target_label}] ❌ {err_msg}", now()));
            return Err((AppError::Auth(err_msg), logs.clone()));
        }

        if let Some(expanded_path) = key_path {
            logs.push(format!(
                "[{}] [{target_label}] Méthode : Clé privée SSH ({})",
                now(),
                expanded_path.display()
            ));

            let p_clone = expanded_path.clone();
            let pass_clone = passphrase.map(String::from);
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
                        "[{}] [{target_label}] Clé privée chargée et déchiffrée avec succès (type: {:?}).",
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
                    logs.push(format!("[{}] [{target_label}] ❌ {err_msg}", now()));

                    // An encrypted key without passphrase is often loaded in an agent already:
                    // retry through the agent, restricted to this exact key.
                    let p = expanded_path.clone();
                    let wanted =
                        tokio::task::spawn_blocking(move || agent::load_wanted_public_key(&p))
                            .await
                            .ok()
                            .flatten();
                    if let Some(wanted) = wanted {
                        logs.push(format!(
                            "[{}] [{target_label}] Nouvel essai via l'agent SSH avec la même clé...",
                            now()
                        ));
                        if Self::try_agent_auth(
                            handle,
                            username,
                            req.agent_socket,
                            Some(&wanted),
                            target_label,
                            logs,
                        )
                        .await
                            == AgentAuthOutcome::Accepted
                        {
                            return Ok(());
                        }
                    }

                    logs.push(format!(
                        "[{}] [{target_label}] ℹ️ Conseil: Vérifiez le chemin ou saisissez la passphrase si la clé est chiffrée.",
                        now()
                    ));
                    return Err((AppError::Auth(err_msg), logs.clone()));
                }
            };

            let key_arc = Arc::new(secret_key);
            let mut authenticated = false;

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
                    "[{}] [{target_label}] Négociation de signature avec l'algorithme : {alg_name}...",
                    now()
                ));
                let key_with_alg = PrivateKeyWithHashAlg::new(key_arc.clone(), hash_alg);

                match handle.authenticate_publickey(username, key_with_alg).await {
                    Ok(res) if res.success() => {
                        logs.push(format!(
                            "[{}] [{target_label}] Authentification par clé SSH acceptée ({alg_name}) !",
                            now()
                        ));
                        authenticated = true;
                        break;
                    }
                    Ok(_) => {
                        logs.push(format!(
                            "[{}] [{target_label}] Algorithme {alg_name} refusé par le serveur, essai du suivant...",
                            now()
                        ));
                    }
                    Err(e) => {
                        logs.push(format!(
                            "[{}] [{target_label}] Erreur technique avec algorithme {alg_name}: {e}",
                            now()
                        ));
                    }
                }
            }

            if !authenticated {
                let err_msg = format!(
                    "Le serveur SSH ({target_label}) a rejeté la clé publique pour tous les algorithmes (SSH_MSG_USERAUTH_FAILURE)"
                );
                logs.push(format!("[{}] [{target_label}] ❌ {err_msg}", now()));
                return Err((AppError::Auth(err_msg), logs.clone()));
            }
        } else if let Some(pwd) = req.password.filter(|p| !p.is_empty()) {
            logs.push(format!(
                "[{}] [{target_label}] Méthode : Mot de passe",
                now()
            ));
            match handle.authenticate_password(username, pwd).await {
                Ok(res) if res.success() => {
                    logs.push(format!(
                        "[{}] [{target_label}] Authentification par mot de passe acceptée !",
                        now()
                    ));
                }
                Ok(_) => {
                    let err_msg =
                        format!("Nom d'utilisateur ou mot de passe incorrect sur {target_label}");
                    logs.push(format!("[{}] [{target_label}] ❌ {err_msg}", now()));
                    return Err((AppError::Auth(err_msg), logs.clone()));
                }
                Err(e) => {
                    let err_msg =
                        format!("Erreur lors de l'authentification sur {target_label}: {e}");
                    logs.push(format!("[{}] [{target_label}] ❌ {err_msg}", now()));
                    return Err((AppError::Auth(err_msg), logs.clone()));
                }
            }
        } else {
            // Same order as OpenSSH: agent identities first, then the default key files.
            if Self::try_agent_auth(handle, username, req.agent_socket, None, target_label, logs)
                .await
                == AgentAuthOutcome::Accepted
            {
                return Ok(());
            }

            logs.push(format!(
                "[{}] [{target_label}] Recherche des clés SSH standard (~/.ssh/id_ed25519, ~/.ssh/id_rsa)...",
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
                        logs.push(format!(
                            "[{}] [{target_label}] Tentative avec {}",
                            now(),
                            key_p.display()
                        ));
                        let p = key_p.clone();
                        let pass = passphrase.map(String::from);
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
                                if let Ok(res) =
                                    handle.authenticate_publickey(username, key_with_alg).await
                                {
                                    if res.success() {
                                        logs.push(format!(
                                            "[{}] [{target_label}] Authentification réussie avec {}",
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
                let err_msg =
                    format!("Aucun mot de passe ni clé SSH valide fournie pour {target_label}");
                logs.push(format!("[{}] [{target_label}] ❌ {err_msg}", now()));
                return Err((AppError::Auth(err_msg), logs.clone()));
            }
        }

        Ok(())
    }

    async fn persist_host_key(
        key_status: Arc<tokio::sync::Mutex<Option<HostKeyStatus>>>,
        host: &str,
        port: u16,
        target_label: &str,
        logs: &mut Vec<String>,
    ) -> Result<(), (AppError, Vec<String>)> {
        let now = || Utc::now().format("%H:%M:%S%.3f").to_string();
        let recorded_status = key_status.lock().await.clone();
        match recorded_status {
            Some(HostKeyStatus::PendingEnrollment(ref pubkey)) => {
                let host_s = host.to_string();
                let pubkey_clone = pubkey.clone();
                let _lock = KNOWN_HOSTS_LOCK.lock().await;
                let learn_res = tokio::task::spawn_blocking(move || {
                    russh::keys::known_hosts::learn_known_hosts(&host_s, port, &pubkey_clone)
                })
                .await;

                match learn_res {
                    Ok(Ok(())) => {
                        let mut status = key_status.lock().await;
                        *status = Some(HostKeyStatus::Learned);
                        logs.push(format!(
                            "[{}] [{target_label}] 🔑 Nouvel hôte approuvé : clé publique enregistrée dans ~/.ssh/known_hosts.",
                            now()
                        ));
                    }
                    Ok(Err(e)) => {
                        let err_msg = format!(
                            "Échec d'enregistrement de la clé ({target_label}) dans ~/.ssh/known_hosts : {e}"
                        );
                        logs.push(format!("[{}] [{target_label}] ❌ {err_msg}", now()));
                        return Err((AppError::Io(err_msg), logs.clone()));
                    }
                    Err(e) => {
                        let err_msg = format!(
                            "Erreur système lors de l'enregistrement de la clé ({target_label}) : {e}"
                        );
                        logs.push(format!("[{}] [{target_label}] ❌ {err_msg}", now()));
                        return Err((AppError::Io(err_msg), logs.clone()));
                    }
                }
            }
            Some(HostKeyStatus::PendingReplacement { ref pubkey, line }) => {
                let host_s = host.to_string();
                let pubkey_clone = pubkey.clone();
                let _lock = KNOWN_HOSTS_LOCK.lock().await;
                let replace_res = tokio::task::spawn_blocking(move || {
                    replace_known_hosts_entry_atomic(&host_s, port, &pubkey_clone, Some(line))
                })
                .await;

                match replace_res {
                    Ok(Ok(())) => {
                        let mut status = key_status.lock().await;
                        *status = Some(HostKeyStatus::Learned);
                        logs.push(format!(
                            "[{}] [{target_label}] 🔄 Clé d'hôte SSH remplacée atomiquement dans ~/.ssh/known_hosts.",
                            now()
                        ));
                    }
                    Ok(Err(e)) => {
                        let err_msg = format!(
                            "Échec du remplacement de la clé ({target_label}) dans ~/.ssh/known_hosts : {e}"
                        );
                        logs.push(format!("[{}] [{target_label}] ❌ {err_msg}", now()));
                        return Err((AppError::Io(err_msg), logs.clone()));
                    }
                    Err(e) => {
                        let err_msg = format!(
                            "Erreur système lors du remplacement de la clé ({target_label}) : {e}"
                        );
                        logs.push(format!("[{}] [{target_label}] ❌ {err_msg}", now()));
                        return Err((AppError::Io(err_msg), logs.clone()));
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub async fn connect_with_logs_and_prompt(
        config: SftpConnectConfig,
        prompt_handler: Option<Arc<dyn HostKeyPromptHandler + Send + Sync>>,
    ) -> Result<(Self, Vec<String>), (AppError, Vec<String>)> {
        let mut logs = Vec::new();
        let now = || Utc::now().format("%H:%M:%S%.3f").to_string();

        logs.push(format!(
            "[{}] Démarrage de la séquence de connexion SFTP...",
            now()
        ));
        logs.push(format!(
            "[{}] Cible finale : {}:{}",
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
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        });

        let proxy_opt = config.proxy.clone().filter(|p| p.enabled);
        let bastion_opt = config.bastion.clone().filter(|b| b.enabled);

        // Both hosts are written into ~/.ssh/known_hosts once their key is accepted.
        let bastion_host = bastion_opt.as_ref().and_then(|b| b.host.as_deref());
        for (label, host) in [
            ("Serveur Cible", Some(config.host.as_str())),
            ("Bastion SSH", bastion_host.filter(|h| !h.trim().is_empty())),
        ] {
            if let Some(host) = host {
                if let Err(err) = validate_ssh_host(host) {
                    logs.push(format!("[{}] ❌ [{label}] {err}", now()));
                    return Err((err, logs));
                }
            }
        }

        // Premier point d'atterrissage réseau (Bastion si activé, sinon Cible finale)
        let (initial_host, initial_port, initial_label) = if let Some(ref bastion) = bastion_opt {
            let b_host = bastion
                .host
                .as_deref()
                .filter(|h| !h.trim().is_empty())
                .ok_or_else(|| {
                    let err = AppError::Config("L'adresse de l'hôte bastion est requise.".into());
                    logs.push(format!("[{}] ❌ {err}", now()));
                    (err, logs.clone())
                })?;
            let b_port = bastion.port.unwrap_or(22);
            (b_host.to_string(), b_port, "Bastion SSH")
        } else {
            (config.host.clone(), config.port, "Serveur Cible")
        };

        // 1. Établissement du flux TCP initial (direct ou via Proxy)
        let tcp_stream = if let Some(ref proxy) = proxy_opt {
            let p_type = proxy.proxy_type.as_deref().unwrap_or("socks5");
            let p_host = proxy.host.as_deref().unwrap_or("");
            let p_port = proxy
                .port
                .unwrap_or(if p_type == "http" { 8080 } else { 1080 });
            let p_display_addr = crate::sftp::proxy::format_host_port(p_host, p_port);
            let target_display_addr =
                crate::sftp::proxy::format_host_port(&initial_host, initial_port);
            logs.push(format!(
                "[{}] 🌐 Connexion au proxy {p_type} ({p_display_addr}) pour joindre {initial_label} ({target_display_addr})...",
                now()
            ));

            match tokio::time::timeout(
                Duration::from_secs(15),
                crate::sftp::proxy::connect_via_proxy(proxy, &initial_host, initial_port),
            )
            .await
            {
                Ok(Ok(s)) => {
                    logs.push(format!(
                        "[{}] ✅ Tunnel proxy {p_type} établi avec succès vers {initial_label} ({target_display_addr}).",
                        now()
                    ));
                    s
                }
                Ok(Err(e)) => {
                    logs.push(format!(
                        "[{}] ❌ Échec de négociation avec le proxy : {e}",
                        now()
                    ));
                    return Err((e, logs));
                }
                Err(_) => {
                    let err = AppError::Io(format!(
                        "Délai d'attente dépassé (15s) lors de la connexion au proxy {p_display_addr}"
                    ));
                    logs.push(format!("[{}] ❌ {err}", now()));
                    return Err((err, logs));
                }
            }
        } else {
            let addr = crate::sftp::proxy::format_host_port(&initial_host, initial_port);
            logs.push(format!(
                "[{}] 🔌 Connexion socket TCP directe vers {initial_label} ({addr})...",
                now()
            ));
            match tokio::time::timeout(
                Duration::from_secs(15),
                tokio::net::TcpStream::connect(&addr),
            )
            .await
            {
                Ok(Ok(s)) => {
                    logs.push(format!(
                        "[{}] Connexion socket TCP établie avec succès vers {addr}.",
                        now()
                    ));
                    s
                }
                Ok(Err(e)) => {
                    let err_msg = format!("Échec de connexion réseau vers {addr}: {e}");
                    logs.push(format!("[{}] ❌ {err_msg}", now()));
                    return Err((AppError::Io(err_msg), logs));
                }
                Err(_) => {
                    let err_msg = format!(
                        "Délai d'attente dépassé (15s) lors de la connexion réseau vers {addr}"
                    );
                    logs.push(format!("[{}] ❌ {err_msg}", now()));
                    return Err((AppError::Io(err_msg), logs));
                }
            }
        };

        // 2. Saut Bastion SSH (si activé)
        let (target_stream, bastion_handle_opt) = if let Some(ref bastion) = bastion_opt {
            logs.push(format!(
                "[{}] 🏰 Négociation SSH avec le Bastion ({initial_host}:{initial_port})...",
                now()
            ));

            let (mut b_handle, b_key_status) = Self::connect_ssh_over_stream(
                SshStream::Tcp(tcp_stream),
                &initial_host,
                initial_port,
                Arc::clone(&ssh_config),
                prompt_handler.clone(),
                "Bastion",
                &mut logs,
            )
            .await?;

            let b_username = bastion
                .username
                .as_deref()
                .filter(|u| !u.trim().is_empty())
                .unwrap_or(&config.username);

            Self::authenticate_session(
                &mut b_handle,
                &AuthRequest {
                    username: b_username,
                    auth_type: bastion.auth_type.as_deref(),
                    key_path: bastion.key_path.as_deref(),
                    passphrase: bastion.passphrase.as_deref(),
                    password: bastion.password.as_deref(),
                    agent_socket: bastion
                        .agent_socket
                        .as_deref()
                        .or(config.agent_socket.as_deref()),
                },
                "Bastion",
                &mut logs,
            )
            .await?;

            Self::persist_host_key(
                b_key_status,
                &initial_host,
                initial_port,
                "Bastion",
                &mut logs,
            )
            .await?;

            logs.push(format!(
                "[{}] 🌉 Ouverture du tunnel direct-tcpip à travers le Bastion vers {}:{}...",
                now(),
                config.host,
                config.port
            ));

            let channel_fut = b_handle.channel_open_direct_tcpip(
                &config.host,
                config.port as u32,
                "127.0.0.1",
                0,
            );
            let direct_channel = match tokio::time::timeout(Duration::from_secs(15), channel_fut)
                .await
            {
                Ok(Ok(c)) => {
                    logs.push(format!(
                        "[{}] ✅ Tunnel direct-tcpip Bastion ➔ Cible ouvert avec succès.",
                        now()
                    ));
                    c
                }
                Ok(Err(e)) => {
                    let err_msg = format!(
                        "Le Bastion a refusé l'ouverture du tunnel direct-tcpip vers {}:{}: {e}",
                        config.host, config.port
                    );
                    logs.push(format!("[{}] ❌ {err_msg}", now()));
                    return Err((AppError::Ssh(err_msg), logs));
                }
                Err(_) => {
                    let err_msg = format!(
                        "Délai d'attente dépassé (15s) lors de l'ouverture du tunnel direct-tcpip Bastion vers {}:{}",
                        config.host, config.port
                    );
                    logs.push(format!("[{}] ❌ {err_msg}", now()));
                    return Err((AppError::Io(err_msg), logs));
                }
            };

            let stream = SshStream::Channel(direct_channel.into_stream());
            (stream, Some(b_handle))
        } else {
            (SshStream::Tcp(tcp_stream), None)
        };

        // 3. Négociation SSH avec le Serveur Cible
        logs.push(format!(
            "[{}] 🎯 Négociation SSH avec le serveur cible ({}:{})...",
            now(),
            config.host,
            config.port
        ));

        let (mut handle, key_status) = Self::connect_ssh_over_stream(
            target_stream,
            &config.host,
            config.port,
            Arc::clone(&ssh_config),
            prompt_handler,
            "Serveur Cible",
            &mut logs,
        )
        .await?;

        Self::authenticate_session(
            &mut handle,
            &AuthRequest {
                username: &config.username,
                auth_type: config.auth_type.as_deref(),
                key_path: config.key_path.as_deref(),
                passphrase: config.passphrase.as_deref(),
                password: config.password.as_deref(),
                agent_socket: config.agent_socket.as_deref(),
            },
            "Serveur Cible",
            &mut logs,
        )
        .await?;

        // 4. Ouverture du canal SFTP
        logs.push(format!(
            "[{}] Ouverture du canal SSH et du sous-système SFTP...",
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

        let sftp_session = if config.use_sudo {
            logs.push(format!(
                "[{}] 🛡️ Mode Privilèges Élevés (Sudo) activé : lancement du serveur SFTP sous sudo...",
                now()
            ));
            let sudo_cmd = "sudo -n sh -c 'for p in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server; do [ -x \"$p\" ] && exec \"$p\"; done; exec sftp-server'";
            match channel.exec(true, sudo_cmd).await {
                Ok(_) => {
                    logs.push(format!(
                        "[{}] Commande sudo sftp-server lancée avec succès.",
                        now()
                    ));
                }
                Err(e) => {
                    let err_msg =
                        format!("Le serveur SSH a refusé l'exécution de sudo sftp-server: {e}");
                    logs.push(format!("[{}] ❌ {}", now(), err_msg));
                    return Err((AppError::Sftp(err_msg), logs));
                }
            }

            match SftpSession::new(channel.into_stream()).await {
                Ok(s) => {
                    logs.push(format!(
                        "[{}] ✅ Session SFTP Root initialisée avec succès ! Privilèges administrateur actifs.",
                        now()
                    ));
                    s
                }
                Err(e) => {
                    let err_msg = format!(
                        "Échec d'initialisation SFTP sous sudo (vérifiez vos droits sudo / NOPASSWD): {e}"
                    );
                    logs.push(format!("[{}] ❌ {}", now(), err_msg));
                    return Err((AppError::Sftp(err_msg), logs));
                }
            }
        } else {
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

            match SftpSession::new(channel.into_stream()).await {
                Ok(s) => {
                    logs.push(format!("[{}] ✅ Session SFTP initialisée avec succès ! Prêt pour la navigation et les transferts.", now()));
                    s
                }
                Err(e) => {
                    let err_msg = format!("Échec d'initialisation du protocole SFTP: {e}");
                    logs.push(format!("[{}] ❌ {}", now(), err_msg));
                    return Err((AppError::Sftp(err_msg), logs));
                }
            }
        };

        // Persister la clé d'hôte cible approuvée après initialisation réussie
        Self::persist_host_key(
            key_status.clone(),
            &config.host,
            config.port,
            "Serveur Cible",
            &mut logs,
        )
        .await?;

        let sudo_capability = if config.use_sudo {
            SudoCapability::Passwordless
        } else {
            Self::probe_sudo_capability(&handle).await
        };

        let final_status = key_status.lock().await.clone();
        Ok((
            Self {
                session: sftp_session,
                _handle: handle,
                _bastion_handle: bastion_handle_opt,
                username: config.username,
                identities: tokio::sync::RwLock::new(None),
                host_key_status: final_status,
                is_elevated: config.use_sudo,
                sudo_capability,
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

    pub async fn resolve_identity_str_to_id(
        &self,
        name_or_id: &str,
        is_group: bool,
    ) -> Result<u32, AppError> {
        let trimmed = name_or_id.trim();
        if let Ok(id) = trimmed.parse::<u32>() {
            return Ok(id);
        }

        let identities = self.get_or_load_identities().await;
        if is_group {
            identities
                .groups
                .iter()
                .find(|(_, name)| name.as_str() == trimmed)
                .map(|(gid, _)| *gid)
                .ok_or_else(|| {
                    AppError::NotFound(format!("Groupe distant '{trimmed}' introuvable"))
                })
        } else {
            identities
                .users
                .iter()
                .find(|(_, name)| name.as_str() == trimmed)
                .map(|(uid, _)| *uid)
                .ok_or_else(|| {
                    AppError::NotFound(format!("Utilisateur distant '{trimmed}' introuvable"))
                })
        }
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

    pub(crate) fn tmp_upload_path(remote_path: &str, transfer_id: &str) -> String {
        Self::tmp_upload_path_with_nonce(remote_path, transfer_id, fastrand::u64(..))
    }

    pub(crate) fn tmp_upload_path_with_nonce(
        remote_path: &str,
        transfer_id: &str,
        nonce: u64,
    ) -> String {
        let safe_id: String = transfer_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .take(24)
            .collect();
        let id = if safe_id.is_empty() {
            "tmp".to_string()
        } else {
            safe_id
        };
        let tmp_name = format!(".orbit-tmp-{id}-{nonce:016x}");
        match remote_path.rfind('/') {
            Some(idx) => {
                let parent = &remote_path[..idx];
                if parent.is_empty() {
                    format!("/{tmp_name}")
                } else {
                    format!("{parent}/{tmp_name}")
                }
            }
            None => tmp_name,
        }
    }

    async fn stream_upload(
        &self,
        local_file: &mut tokio::fs::File,
        mut remote_file: russh_sftp::client::fs::File,
        transfer: &mut TransferHandle,
    ) -> Result<(), AppError> {
        let mut buffer = vec![0u8; TRANSFER_CHUNK_SIZE];
        loop {
            transfer.checkpoint().await?;

            let n = local_file
                .read(&mut buffer)
                .await
                .map_err(|e| AppError::Io(format!("Error reading local file: {e}")))?;
            if n == 0 {
                break;
            }

            transfer
                .guard(async {
                    remote_file
                        .write_all(&buffer[..n])
                        .await
                        .map_err(|e| AppError::Sftp(format!("Error writing to SFTP: {e}")))
                })
                .await?;

            transfer.advance(n as u64);
        }

        transfer
            .guard(async {
                remote_file
                    .close()
                    .await
                    .map_err(|e| AppError::Sftp(format!("Error closing remote file: {e}")))
            })
            .await
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
        let x_usr = if m & 0o4000 != 0 {
            if m & 0o100 != 0 { 's' } else { 'S' }
        } else if m & 0o100 != 0 {
            'x'
        } else {
            '-'
        };
        let r_grp = if m & 0o040 != 0 { 'r' } else { '-' };
        let w_grp = if m & 0o020 != 0 { 'w' } else { '-' };
        let x_grp = if m & 0o2000 != 0 {
            if m & 0o010 != 0 { 's' } else { 'S' }
        } else if m & 0o010 != 0 {
            'x'
        } else {
            '-'
        };
        let r_oth = if m & 0o004 != 0 { 'r' } else { '-' };
        let w_oth = if m & 0o002 != 0 { 'w' } else { '-' };
        let x_oth = if m & 0o1000 != 0 {
            if m & 0o001 != 0 { 't' } else { 'T' }
        } else if m & 0o001 != 0 {
            'x'
        } else {
            '-'
        };
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

/// Valide qu'un chemin distant SFTP est sécurisé (protection anti-Directory-Traversal).
/// Rejette les octets nuls et tout composant '..' qui tenterait de s'échapper de l'arborescence autorisée.
pub fn validate_path_safety(path: &str) -> Result<(), AppError> {
    if path.contains('\0') {
        return Err(AppError::InvalidPath(
            "Chemin non sécurisé : présence d'un octet nul".to_string(),
        ));
    }

    let normalized = path.replace('\\', "/");
    for segment in normalized.split('/') {
        if segment == ".." {
            return Err(AppError::InvalidPath(format!(
                "Chemin non sécurisé (tentative de Directory Traversal '..') : {path}"
            )));
        }
    }

    Ok(())
}

/// Valide qu'un chemin de fichier local ne contient aucun composant de type ParentDir ('..').
pub fn validate_local_path_safety(path: &std::path::Path) -> Result<(), AppError> {
    for component in path.components() {
        if let std::path::Component::ParentDir = component {
            return Err(AppError::InvalidPath(format!(
                "Chemin local non sécurisé (tentative de Directory Traversal '..') : {}",
                path.display()
            )));
        }
    }
    Ok(())
}

async fn remove_dir_all_sftp(session: &SftpSession, path: &str) -> Result<(), AppError> {
    validate_path_safety(path)?;
    let read_dir = session.read_dir(path).await.map_err(|e| {
        AppError::Sftp(format!("Failed to read directory {path} for deletion: {e}"))
    })?;

    for entry in read_dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        validate_path_safety(&name)?;

        let child_path = if path.ends_with('/') {
            format!("{path}{name}")
        } else {
            format!("{path}/{name}")
        };

        let file_type = entry.file_type();
        if file_type.is_symlink() {
            // Never follow symlinks when deleting! A symlink (even to a directory) is removed with remove_file.
            session.remove_file(&child_path).await.map_err(|e| {
                AppError::Sftp(format!("Failed to remove symlink {child_path}: {e}"))
            })?;
        } else if file_type.is_dir() {
            Box::pin(remove_dir_all_sftp(session, &child_path)).await?;
        } else {
            session
                .remove_file(&child_path)
                .await
                .map_err(|e| AppError::Sftp(format!("Failed to remove file {child_path}: {e}")))?;
        }
    }

    session
        .remove_dir(path)
        .await
        .map_err(|e| AppError::Sftp(format!("Failed to remove directory {path}: {e}")))?;

    Ok(())
}

#[async_trait]
impl StorageProvider for SftpProvider {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, AppError> {
        validate_path_safety(path)?;
        let dir_path = if path.is_empty() { "/" } else { path };
        let read_dir = self.session.read_dir(dir_path).await.map_err(|e| {
            let err_str = e.to_string();
            if err_str.to_lowercase().contains("permission denied") {
                AppError::PermissionDenied(format!("Permission denied: cannot access '{dir_path}'"))
            } else {
                AppError::Sftp(format!("Failed to list directory {dir_path}: {e}"))
            }
        })?;

        let identities = self.get_or_load_identities().await;

        let mut entries = Vec::new();
        for entry in read_dir {
            let name = entry.file_name();
            // Ignorer les pseudo-répertoires '.' et '..' et séparateurs
            if name == "." || name == ".." || name.contains('/') {
                continue;
            }
            // Prévenir les attaques de Directory Traversal dans les noms retournés
            if validate_path_safety(&name).is_err() {
                continue;
            }

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
                name,
                path: entry.path(),
                is_dir,
                is_symlink: entry.file_type().is_symlink(),
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
        validate_path_safety(path)?;
        self.session
            .create_dir(path)
            .await
            .map_err(|e| AppError::Sftp(format!("Failed to create directory {path}: {e}")))?;
        Ok(())
    }

    async fn delete(&self, path: &str, is_dir: bool) -> Result<(), AppError> {
        validate_path_safety(path)?;
        if is_dir {
            remove_dir_all_sftp(&self.session, path).await
        } else {
            self.session
                .remove_file(path)
                .await
                .map_err(|e| AppError::Sftp(format!("Failed to remove file {path}: {e}")))?;
            Ok(())
        }
    }

    async fn rename(&self, old_path: &str, new_path: &str) -> Result<(), AppError> {
        validate_path_safety(old_path)?;
        validate_path_safety(new_path)?;
        self.session.rename(old_path, new_path).await.map_err(|e| {
            AppError::Sftp(format!("Failed to rename {old_path} to {new_path}: {e}"))
        })?;
        Ok(())
    }

    async fn read_preview(&self, path: &str, max_bytes: usize) -> Result<Vec<u8>, AppError> {
        validate_path_safety(path)?;
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
        transfer: &mut TransferHandle,
    ) -> Result<(), AppError> {
        validate_local_path_safety(&local_path)?;
        validate_path_safety(&remote_path)?;

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

        transfer.start(total_bytes);

        // Check pre-existing destination metadata to preserve permissions upon atomic replace
        let existing_dest_meta = self.session.metadata(&remote_path).await.ok();

        let tmp_path = Self::tmp_upload_path(&remote_path, transfer.id());

        // Attempt atomic upload via an unpredictable temporary file with exclusive open (CREATE | EXCLUDE)
        // to prevent symlink and pre-creation attacks.
        let open_res = self
            .session
            .open_with_flags(
                &tmp_path,
                russh_sftp::protocol::OpenFlags::CREATE
                    | russh_sftp::protocol::OpenFlags::EXCLUDE
                    | russh_sftp::protocol::OpenFlags::WRITE,
            )
            .await;

        match open_res {
            Ok(remote_file) => {
                let copy_result = self
                    .stream_upload(&mut local_file, remote_file, transfer)
                    .await;

                if let Err(err) = copy_result {
                    // Transfer interrupted or failed: delete temporary file.
                    // The original target file is completely untouched and intact.
                    let _ = self.session.remove_file(&tmp_path).await;
                    return Err(err);
                }

                // Verify cancellation signal before promoting the temporary file
                if let Err(cancel_err) = transfer.checkpoint().await {
                    let _ = self.session.remove_file(&tmp_path).await;
                    return Err(cancel_err);
                }

                // Preserve existing destination permissions if destination is being overwritten
                if let Some(ref dest_meta) = existing_dest_meta {
                    let mut attrs = russh_sftp::protocol::FileAttributes::empty();
                    attrs.permissions = dest_meta.permissions;
                    let _ = self.session.set_metadata(&tmp_path, attrs).await;
                }

                // Atomically rename temporary file to target path
                let mut rename_result = self.session.rename(&tmp_path, &remote_path).await;
                if rename_result.is_err() && existing_dest_meta.is_some() {
                    // Some SFTP servers (draft-02 strict) reject rename if target exists.
                    // Safely move target to a backup path before renaming, restoring it if rename fails.
                    let backup_path = Self::tmp_upload_path(&remote_path, "bak");
                    if self
                        .session
                        .rename(&remote_path, &backup_path)
                        .await
                        .is_ok()
                    {
                        rename_result = self.session.rename(&tmp_path, &remote_path).await;
                        if rename_result.is_ok() {
                            let _ = self.session.remove_file(&backup_path).await;
                        } else {
                            // Restore original destination on failure
                            let _ = self.session.rename(&backup_path, &remote_path).await;
                        }
                    }
                }

                match rename_result {
                    Ok(_) => {
                        transfer.complete();
                        return Ok(());
                    }
                    Err(rename_err) => {
                        eprintln!(
                            "[Orbit SFTP] ⚠️ Server refused rename ({rename_err}). Falling back to direct upload."
                        );
                        let _ = self.session.remove_file(&tmp_path).await;
                        if let Err(seek_err) = local_file.rewind().await {
                            return Err(AppError::Io(format!(
                                "Cannot rewind local file: {seek_err}"
                            )));
                        }
                        transfer.start(total_bytes);
                    }
                }
            }
            Err(create_err) => {
                eprintln!(
                    "[Orbit SFTP] ⚠️ Could not create temp file {tmp_path} ({create_err}). Falling back to direct upload."
                );
            }
        }

        // Direct upload fallback (if temp file or rename is forbidden by server)
        let remote_file =
            self.session.create(&remote_path).await.map_err(|e| {
                AppError::Sftp(format!("Cannot create remote file {remote_path}: {e}"))
            })?;

        let copy_result = self
            .stream_upload(&mut local_file, remote_file, transfer)
            .await;

        if let Err(err) = copy_result {
            if let Err(rm_err) = self.session.remove_file(&remote_path).await {
                eprintln!(
                    "[Orbit SFTP] ⚠️ Could not remove partial remote file {remote_path}: {rm_err}"
                );
            }
            return Err(err);
        }

        transfer.complete();
        Ok(())
    }

    async fn download_file(
        &self,
        remote_path: String,
        local_path: PathBuf,
        transfer: &mut TransferHandle,
    ) -> Result<(), AppError> {
        validate_path_safety(&remote_path)?;
        validate_local_path_safety(&local_path)?;

        let mut remote_file = transfer
            .guard(async {
                self.session.open(&remote_path).await.map_err(|e| {
                    AppError::Sftp(format!("Cannot open remote file {remote_path}: {e}"))
                })
            })
            .await?;

        let meta = transfer
            .guard(async {
                remote_file
                    .metadata()
                    .await
                    .map_err(|e| AppError::Sftp(format!("Cannot get remote file metadata: {e}")))
            })
            .await?;
        let total_bytes = meta.size.unwrap_or(0);

        let partial_path = partial_download_path(&local_path, transfer.id());
        let mut local_file = create_partial_download_file(&partial_path).await?;

        transfer.start(total_bytes);

        let copy_result: Result<(), AppError> = async {
            let mut buffer = vec![0u8; TRANSFER_CHUNK_SIZE];
            loop {
                transfer.checkpoint().await?;

                let n = transfer
                    .guard(async {
                        remote_file
                            .read(&mut buffer)
                            .await
                            .map_err(|e| AppError::Sftp(format!("Error reading from SFTP: {e}")))
                    })
                    .await?;
                if n == 0 {
                    break;
                }

                local_file
                    .write_all(&buffer[..n])
                    .await
                    .map_err(|e| AppError::Io(format!("Error writing to local file: {e}")))?;

                transfer.advance(n as u64);
            }

            local_file
                .flush()
                .await
                .map_err(|e| AppError::Io(format!("Error flushing local file: {e}")))
        }
        .await;

        drop(local_file);
        if let Err(err) = copy_result {
            let _ = tokio::fs::remove_file(&partial_path).await;
            return Err(err);
        }
        finalize_partial_download(&partial_path, &local_path).await?;

        transfer.complete();
        Ok(())
    }

    async fn set_permissions(
        &self,
        path: &str,
        mode: Option<u32>,
        owner: Option<&str>,
        group: Option<&str>,
        recursive: bool,
    ) -> Result<(), AppError> {
        validate_path_safety(path)?;

        let resolved_uid = if let Some(u) = owner {
            if u.trim().is_empty() {
                None
            } else {
                Some(self.resolve_identity_str_to_id(u, false).await?)
            }
        } else {
            None
        };

        let resolved_gid = if let Some(g) = group {
            if g.trim().is_empty() {
                None
            } else {
                Some(self.resolve_identity_str_to_id(g, true).await?)
            }
        } else {
            None
        };

        let change_ownership = resolved_uid.is_some() || resolved_gid.is_some();

        if recursive {
            let entries = self.walk(path).await?;
            let mut sorted_entries = entries;
            sorted_entries.sort_by_key(|a| std::cmp::Reverse(a.relative_path.len()));

            for entry in sorted_entries {
                if entry.is_symlink {
                    continue;
                }
                let child_path = crate::walk::join_remote(path, &entry.relative_path);
                validate_path_safety(&child_path)?;

                let mut child_attrs = russh_sftp::protocol::FileAttributes::empty();
                if let Some(m) = mode {
                    child_attrs.permissions = Some(m);
                }
                if change_ownership {
                    let mut c_uid = resolved_uid;
                    let mut c_gid = resolved_gid;
                    if c_uid.is_none() || c_gid.is_none() {
                        let meta = self.session.metadata(&child_path).await.map_err(|e| {
                            AppError::Sftp(format!(
                                "Échec de lecture des métadonnées de '{child_path}': {e}"
                            ))
                        })?;
                        if c_uid.is_none() {
                            c_uid = meta.uid;
                        }
                        if c_gid.is_none() {
                            c_gid = meta.gid;
                        }
                    }
                    if let Some(u) = c_uid {
                        child_attrs.uid = Some(u);
                    }
                    if let Some(g) = c_gid {
                        child_attrs.gid = Some(g);
                    }
                }
                self.session
                    .set_metadata(&child_path, child_attrs)
                    .await
                    .map_err(|e| {
                        AppError::Sftp(format!(
                            "Échec de modification des attributs de '{child_path}': {e}"
                        ))
                    })?;
            }
        }

        let mut root_attrs = russh_sftp::protocol::FileAttributes::empty();
        if let Some(m) = mode {
            root_attrs.permissions = Some(m);
        }
        if change_ownership {
            let mut r_uid = resolved_uid;
            let mut r_gid = resolved_gid;
            if r_uid.is_none() || r_gid.is_none() {
                let meta = self.session.metadata(path).await.map_err(|e| {
                    AppError::Sftp(format!("Échec de lecture des métadonnées de '{path}': {e}"))
                })?;
                if r_uid.is_none() {
                    r_uid = meta.uid;
                }
                if r_gid.is_none() {
                    r_gid = meta.gid;
                }
            }
            if let Some(u) = r_uid {
                root_attrs.uid = Some(u);
            }
            if let Some(g) = r_gid {
                root_attrs.gid = Some(g);
            }
        }

        self.session
            .set_metadata(path, root_attrs)
            .await
            .map_err(|e| {
                let err_str = e.to_string();
                if err_str.to_lowercase().contains("permission denied") {
                    AppError::PermissionDenied(format!("Permission refusée pour modifier '{path}' (droits administrateur / sudo requis pour changer le propriétaire)"))
                } else {
                    AppError::Sftp(format!(
                        "Échec de modification des attributs de '{path}': {e}"
                    ))
                }
            })?;

        Ok(())
    }

    async fn fingerprint(&self, path: &str) -> Result<RemoteFingerprint, AppError> {
        validate_path_safety(path)?;
        let meta = self.session.metadata(path).await.map_err(|e| {
            let msg = e.to_string();
            if msg.to_lowercase().contains("no such file") {
                AppError::NotFound(format!("Fichier distant introuvable : {path}"))
            } else {
                AppError::Sftp(format!("Cannot stat {path}: {e}"))
            }
        })?;
        if meta.is_dir() {
            return Err(AppError::InvalidPath(format!("{path} est un dossier")));
        }
        if !meta.is_regular() {
            return Err(AppError::InvalidPath(format!(
                "{path} n'est pas un fichier ordinaire"
            )));
        }
        Ok(RemoteFingerprint {
            size: meta.size.unwrap_or(0),
            modified: meta.mtime.map(|t| t.to_string()),
            etag: None,
        })
    }

    fn is_elevated(&self) -> bool {
        self.is_elevated
    }

    fn sudo_capability(&self) -> SudoCapability {
        self.sudo_capability
    }

    async fn list_identities(&self) -> Result<(Vec<String>, Vec<String>), AppError> {
        let maps = self.get_or_load_identities().await;
        let mut users: Vec<String> = maps.users.into_values().collect();
        let mut groups: Vec<String> = maps.groups.into_values().collect();
        users.sort();
        users.dedup();
        groups.sort();
        groups.dedup();
        Ok((users, groups))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

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

    #[test]
    fn test_validate_path_safety_valid_paths() {
        assert!(validate_path_safety("/").is_ok());
        assert!(validate_path_safety("").is_ok());
        assert!(validate_path_safety(".").is_ok());
        assert!(validate_path_safety("/home/ubuntu/file.txt").is_ok());
        assert!(validate_path_safety("documents/work/invoice.pdf").is_ok());
        assert!(validate_path_safety(".hidden").is_ok());
        assert!(validate_path_safety("/var/www/.env").is_ok());
        // Double dots inside a single segment name are legitimate file names
        assert!(validate_path_safety("archive..tar.gz").is_ok());
        assert!(validate_path_safety("/backups/file..2026.bak").is_ok());
    }

    #[test]
    fn test_validate_path_safety_traversal_attacks() {
        assert!(validate_path_safety("..").is_err());
        assert!(validate_path_safety("../etc/passwd").is_err());
        assert!(validate_path_safety("/var/www/../../etc/shadow").is_err());
        assert!(validate_path_safety("foo/bar/../..").is_err());
        assert!(validate_path_safety("foo/../bar").is_err());
        // Windows-style backslashes
        assert!(validate_path_safety("..\\windows\\win.ini").is_err());
        assert!(validate_path_safety("C:\\Users\\..\\secret").is_err());
        assert!(validate_path_safety("subdir\\..\\parent").is_err());
    }

    #[test]
    fn test_validate_path_safety_null_bytes() {
        assert!(validate_path_safety("file\0.txt").is_err());
        assert!(validate_path_safety("/home/user/\0/exploit").is_err());
    }

    #[test]
    fn test_validate_local_path_safety() {
        assert!(validate_local_path_safety(Path::new("/home/user/downloads/file.txt")).is_ok());
        assert!(validate_local_path_safety(Path::new("downloads/file.txt")).is_ok());
        assert!(validate_local_path_safety(Path::new(".gitignore")).is_ok());
        assert!(validate_local_path_safety(Path::new("archive..tar.gz")).is_ok());

        assert!(validate_local_path_safety(Path::new("../file.txt")).is_err());
        assert!(validate_local_path_safety(Path::new("/var/www/../../etc/passwd")).is_err());
        assert!(validate_local_path_safety(Path::new("foo/../bar")).is_err());
    }

    #[test]
    fn test_host_key_status_variants() {
        let v = HostKeyStatus::Verified;
        let l = HostKeyStatus::Learned;
        let c = HostKeyStatus::Changed { line: 42 };
        let f = HostKeyStatus::CheckFailed("error".into());
        let a = HostKeyStatus::AcceptedOnce;
        let r = HostKeyStatus::Rejected("user rejected".into());

        assert_eq!(v, HostKeyStatus::Verified);
        assert_eq!(l, HostKeyStatus::Learned);
        assert_eq!(c, HostKeyStatus::Changed { line: 42 });
        assert_eq!(a, HostKeyStatus::AcceptedOnce);
        assert_eq!(r, HostKeyStatus::Rejected("user rejected".into()));
        assert_ne!(v, l);
        assert_ne!(c, HostKeyStatus::Changed { line: 12 });
        assert_eq!(f, HostKeyStatus::CheckFailed("error".into()));
    }

    #[test]
    fn test_fingerprint() {
        let raw =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGt12r2S6bBv3VpXq5L6yUe0Vv4D3KjWv3m6v2y5Qz12 test";
        let pk = russh::keys::ssh_key::PublicKey::from_openssh(raw).unwrap();
        let fp = pk.fingerprint(russh::keys::ssh_key::HashAlg::Sha256);
        assert_eq!(
            fp.to_string(),
            "SHA256:25r5wEeMp/gWr7FE0QJPZ0n7PMhhmR7lBSi2IvcExK4"
        );
    }

    struct MockPromptHandler {
        decision: HostKeyDecision,
    }

    #[async_trait]
    impl HostKeyPromptHandler for MockPromptHandler {
        async fn prompt(&self, req: HostKeyPromptRequest) -> HostKeyDecision {
            assert_eq!(req.host, "test-prompt-host.invalid");
            assert_eq!(req.port, 2222);
            assert!(req.is_new);
            assert_eq!(
                req.fingerprint,
                "SHA256:25r5wEeMp/gWr7FE0QJPZ0n7PMhhmR7lBSi2IvcExK4"
            );
            self.decision
        }
    }

    #[tokio::test]
    async fn test_ssh_handler_check_server_key_prompt_accept_and_remember() {
        let raw =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGt12r2S6bBv3VpXq5L6yUe0Vv4D3KjWv3m6v2y5Qz12 test";
        let pk = russh::keys::ssh_key::PublicKey::from_openssh(raw).unwrap();
        let status = Arc::new(tokio::sync::Mutex::new(None));
        let mock_handler = Arc::new(MockPromptHandler {
            decision: HostKeyDecision::AcceptAndRemember,
        });

        let mut handler = SshHandler::new(
            "test-prompt-host.invalid".to_string(),
            2222,
            Arc::clone(&status),
            Some(mock_handler),
        );

        let server_key = PublicKeyOrCertificate::PublicKey {
            key: pk.clone(),
            hash_alg: None,
        };

        let res = handler.check_server_key(&server_key).await.unwrap();
        assert!(res);
        let current_status = status.lock().await.clone();
        assert_eq!(current_status, Some(HostKeyStatus::PendingEnrollment(pk)));
    }

    #[tokio::test]
    async fn test_ssh_handler_check_server_key_prompt_accept_once() {
        let raw =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGt12r2S6bBv3VpXq5L6yUe0Vv4D3KjWv3m6v2y5Qz12 test";
        let pk = russh::keys::ssh_key::PublicKey::from_openssh(raw).unwrap();
        let status = Arc::new(tokio::sync::Mutex::new(None));
        let mock_handler = Arc::new(MockPromptHandler {
            decision: HostKeyDecision::AcceptOnce,
        });

        let mut handler = SshHandler::new(
            "test-prompt-host.invalid".to_string(),
            2222,
            Arc::clone(&status),
            Some(mock_handler),
        );

        let server_key = PublicKeyOrCertificate::PublicKey {
            key: pk,
            hash_alg: None,
        };

        let res = handler.check_server_key(&server_key).await.unwrap();
        assert!(res);
        let current_status = status.lock().await.clone();
        assert_eq!(current_status, Some(HostKeyStatus::AcceptedOnce));
    }

    #[tokio::test]
    async fn test_ssh_handler_check_server_key_prompt_reject() {
        let raw =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGt12r2S6bBv3VpXq5L6yUe0Vv4D3KjWv3m6v2y5Qz12 test";
        let pk = russh::keys::ssh_key::PublicKey::from_openssh(raw).unwrap();
        let status = Arc::new(tokio::sync::Mutex::new(None));
        let mock_handler = Arc::new(MockPromptHandler {
            decision: HostKeyDecision::Reject,
        });

        let mut handler = SshHandler::new(
            "test-prompt-host.invalid".to_string(),
            2222,
            Arc::clone(&status),
            Some(mock_handler),
        );

        let server_key = PublicKeyOrCertificate::PublicKey {
            key: pk,
            hash_alg: None,
        };

        let res = handler.check_server_key(&server_key).await.unwrap();
        assert!(!res);
        let current_status = status.lock().await.clone();
        assert!(matches!(current_status, Some(HostKeyStatus::Rejected(_))));
    }

    #[tokio::test]
    async fn test_ssh_handler_no_prompt_handler_rejects_unknown_host() {
        let raw =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGt12r2S6bBv3VpXq5L6yUe0Vv4D3KjWv3m6v2y5Qz12 test";
        let pk = russh::keys::ssh_key::PublicKey::from_openssh(raw).unwrap();
        let status = Arc::new(tokio::sync::Mutex::new(None));

        // When prompt_handler is None, unknown keys must be rejected (fail-closed)
        let mut handler = SshHandler::new(
            "test-prompt-host.invalid".to_string(),
            2222,
            Arc::clone(&status),
            None,
        );

        let server_key = PublicKeyOrCertificate::PublicKey {
            key: pk,
            hash_alg: None,
        };

        let res = handler.check_server_key(&server_key).await.unwrap();
        assert!(!res);
        let current_status = status.lock().await.clone();
        assert!(matches!(current_status, Some(HostKeyStatus::Rejected(_))));
    }

    #[test]
    fn test_parse_sudo_probe_output() {
        assert_eq!(
            parse_sudo_probe_output("prefix\nORBIT_SUDO:NOPASSWD\n"),
            SudoCapability::Passwordless
        );
        assert_eq!(
            parse_sudo_probe_output("ORBIT_SUDO:PASSWD\n"),
            SudoCapability::PasswordRequired
        );
        assert_eq!(
            parse_sudo_probe_output("ORBIT_SUDO:NONE\n"),
            SudoCapability::None
        );
        assert_eq!(
            parse_sudo_probe_output("sudo: a password is required"),
            SudoCapability::None
        );
        assert_eq!(
            parse_sudo_probe_output("ORBIT_SUDO:PASSWD\r\n"),
            SudoCapability::PasswordRequired
        );
    }

    #[test]
    fn test_parse_sudo_probe_ignores_embedded_tokens() {
        // Banners or shell start-up output mentioning a token must not be mistaken for it.
        for text in [
            "MOTD: ORBIT_SUDO:NOPASSWD is disabled\n",
            "echo \"ORBIT_SUDO:NOPASSWD\"\n",
            " ORBIT_SUDO:NOPASSWD\n",
            "ORBIT_SUDO:NOPASSWD trailing\n",
            "\x1b[2J\x1b[31mORBIT_SUDO:NOPASSWD\x1b[0m\n",
            "ORBIT_SUDO:NOPASSWD\0\n",
            "orbit_sudo:nopasswd\n",
        ] {
            assert_eq!(
                parse_sudo_probe_output(text),
                SudoCapability::None,
                "{text:?} should not be detected"
            );
        }
        // The real answer still wins when it comes after noise.
        assert_eq!(
            parse_sudo_probe_output("\x1b[2Jwelcome ORBIT_SUDO:NOPASSWD\nORBIT_SUDO:PASSWD\n"),
            SudoCapability::PasswordRequired
        );
    }

    #[test]
    fn test_sudo_probe_output_is_bounded() {
        let mut output = Vec::new();
        let chunk = vec![b'A'; 64 * 1024];
        let mut chunks = 0;
        while !push_sudo_probe_output(&mut output, &chunk) {
            chunks += 1;
            assert!(chunks < 10, "a flood must stop the read loop");
        }
        assert_eq!(output.len(), SUDO_PROBE_MAX_OUTPUT);
        assert_eq!(
            parse_sudo_probe_output(&String::from_utf8_lossy(&output)),
            SudoCapability::None
        );
    }

    #[test]
    fn test_sudo_probe_output_stops_on_complete_token_line() {
        let mut output = Vec::new();
        assert!(!push_sudo_probe_output(&mut output, b"noise\n"));
        // Split across chunks: not complete until the newline arrives.
        assert!(!push_sudo_probe_output(&mut output, b"ORBIT_SUDO:PASS"));
        assert!(!push_sudo_probe_output(&mut output, b"WD"));
        assert!(push_sudo_probe_output(&mut output, b"\n"));
        assert_eq!(
            parse_sudo_probe_output(&String::from_utf8_lossy(&output)),
            SudoCapability::PasswordRequired
        );
    }

    #[test]
    fn test_sudo_probe_output_stops_on_crlf_token_line() {
        let mut output = Vec::new();
        assert!(push_sudo_probe_output(
            &mut output,
            b"ORBIT_SUDO:NOPASSWD\r\n"
        ));
        assert_eq!(
            parse_sudo_probe_output(&String::from_utf8_lossy(&output)),
            SudoCapability::Passwordless
        );
    }

    #[test]
    fn test_sudo_probe_token_after_cap_is_ignored() {
        let mut output = Vec::new();
        let noise = vec![b'x'; SUDO_PROBE_MAX_OUTPUT];
        assert!(push_sudo_probe_output(&mut output, &noise));
        push_sudo_probe_output(&mut output, b"\nORBIT_SUDO:NOPASSWD\n");
        assert_eq!(output.len(), SUDO_PROBE_MAX_OUTPUT);
        assert_eq!(
            parse_sudo_probe_output(&String::from_utf8_lossy(&output)),
            SudoCapability::None
        );
    }

    #[test]
    fn test_prompt_guard_lifecycle() {
        let flag = AtomicBool::new(false);
        assert!(!flag.load(Ordering::SeqCst));
        {
            let _guard = PromptGuard::new(&flag);
            assert!(flag.load(Ordering::SeqCst));
        }
        assert!(!flag.load(Ordering::SeqCst));
    }

    #[test]
    fn test_tmp_upload_path() {
        assert_eq!(
            SftpProvider::tmp_upload_path_with_nonce("/var/log/app.log", "tx-1234", 0x42),
            "/var/log/.orbit-tmp-tx-1234-0000000000000042"
        );
        assert_eq!(
            SftpProvider::tmp_upload_path_with_nonce("/file.txt", "tx-99", 0x99),
            "/.orbit-tmp-tx-99-0000000000000099"
        );
        assert_eq!(
            SftpProvider::tmp_upload_path_with_nonce("relative_file.txt", "abc", 1),
            ".orbit-tmp-abc-0000000000000001"
        );
        assert_eq!(
            SftpProvider::tmp_upload_path_with_nonce(
                "/deep/nested/path/to/target.bin",
                "tx!@#special-42",
                0xabc
            ),
            "/deep/nested/path/to/.orbit-tmp-txspecial-42-0000000000000abc"
        );
    }

    #[test]
    fn test_tmp_upload_path_security_sanitization() {
        // Path traversal payload in transfer_id must be stripped
        let path1 = SftpProvider::tmp_upload_path_with_nonce(
            "/var/data/file.txt",
            "../../../../etc/shadow",
            0,
        );
        assert_eq!(path1, "/var/data/.orbit-tmp-etcshadow-0000000000000000");
        assert!(!path1.contains(".."));

        // Backslash traversal attempt
        let path2 =
            SftpProvider::tmp_upload_path_with_nonce("/srv/data.bin", "..\\..\\sensitive", 0);
        assert_eq!(path2, "/srv/.orbit-tmp-sensitive-0000000000000000");
        assert!(!path2.contains('\\'));

        // Null byte injection attempt
        let path3 = SftpProvider::tmp_upload_path_with_nonce("/srv/data.bin", "tx\0injected", 0);
        assert_eq!(path3, "/srv/.orbit-tmp-txinjected-0000000000000000");
        assert!(!path3.contains('\0'));

        // All-special-characters payload falls back safely without escaping parent
        let path4 = SftpProvider::tmp_upload_path_with_nonce("/dir/test.txt", "!@#$%^&*()/?<>", 0);
        assert_eq!(path4, "/dir/.orbit-tmp-tmp-0000000000000000");

        // Length bounding to 24 safe characters
        let long_id = "a".repeat(100);
        let path5 = SftpProvider::tmp_upload_path_with_nonce("/file.txt", &long_id, 0);
        assert_eq!(
            path5,
            format!("/.orbit-tmp-{}-0000000000000000", "a".repeat(24))
        );
    }
}
