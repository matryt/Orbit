use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::{Mutex, oneshot};

use crate::models::{HostKeyDecision, HostKeyPromptRequest};

static PROMPT_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Longest host name accepted (RFC 1035 limit for a fully qualified domain name).
const MAX_HOST_LEN: usize = 253;

/// Checks that `host` is a plain host name or IP address before it is used to connect and,
/// above all, written into `~/.ssh/known_hosts`.
///
/// The host ends up verbatim in a known_hosts line: a line break would forge an extra entry
/// (e.g. `* ssh-ed25519 <attacker key>`, trusted for every host), and whitespace, `,`, `#`,
/// `*`, `?`, `!`, `[`, `]`, `@` or `|` would change how the pattern field is parsed.
/// IPv6 addresses are written without brackets (`2001:db8::1`), as elsewhere in Orbit.
pub fn validate_ssh_host(host: &str) -> Result<(), crate::error::AppError> {
    if host.is_empty() {
        return Err(crate::error::AppError::Config(
            "L'adresse de l'hôte est vide.".into(),
        ));
    }
    if host.len() > MAX_HOST_LEN {
        return Err(crate::error::AppError::Config(format!(
            "L'adresse de l'hôte dépasse {MAX_HOST_LEN} caractères."
        )));
    }
    if let Some(c) = host.chars().find(|&c| {
        c.is_control()
            || c.is_whitespace()
            || matches!(
                c,
                ',' | '#' | '*' | '?' | '!' | '[' | ']' | '@' | '|' | '/' | '\\' | ';'
            )
    }) {
        return Err(crate::error::AppError::Config(format!(
            "Adresse d'hôte invalide : caractère interdit {c:?}."
        )));
    }
    Ok(())
}

/// Met à jour une chaîne représentant le contenu de known_hosts en retirant l'ancienne entrée
/// pour `host:port` (y compris les lignes hachées ou ciblées par `changed_line`), tout en préservant :
/// 1. Les autres algorithmes pour cet hôte (ex: ssh-rsa préservé si on remplace ssh-ed25519)
/// 2. Les directives `@cert-authority` et autres marqueurs
/// 3. Les autres hôtes séparés par des virgules sur la même ligne.
pub fn update_known_hosts_content(
    content: &str,
    host: &str,
    port: u16,
    new_pubkey: &russh::keys::ssh_key::PublicKey,
    changed_line: Option<usize>,
) -> std::io::Result<String> {
    validate_ssh_host(host)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string()))?;

    let target_plain = host;
    let target_port = format!("[{host}]:{port}");
    let expected_key_type = new_pubkey.algorithm().to_string();

    let mut new_lines = Vec::new();

    for (line_idx, line) in content.lines().enumerate() {
        let current_line_num = line_idx + 1;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            new_lines.push(line.to_string());
            continue;
        }

        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.is_empty() {
            new_lines.push(line.to_string());
            continue;
        }

        // Ne jamais supprimer ni écraser les directives @cert-authority ou autres marqueurs
        if parts[0].starts_with('@') {
            new_lines.push(line.to_string());
            continue;
        }

        let patterns_str = parts[0];
        let line_key_type = if parts.len() > 1 { parts[1] } else { "" };
        let patterns: Vec<&str> = patterns_str.split(',').collect();

        let matches_target = |pat: &&str| -> bool {
            if port == 22 {
                *pat == target_plain || *pat == target_port.as_str()
            } else {
                *pat == target_port.as_str()
            }
        };

        let is_exact_changed_line = changed_line == Some(current_line_num);
        let matches_host_and_key_type =
            patterns.iter().any(matches_target) && line_key_type == expected_key_type;

        if is_exact_changed_line || matches_host_and_key_type {
            let remaining_patterns: Vec<&str> = patterns
                .into_iter()
                .filter(|pat| !matches_target(pat))
                .collect();

            if !remaining_patterns.is_empty() && !is_exact_changed_line {
                let new_pattern_str = remaining_patterns.join(",");
                let mut rebuilt_parts = Vec::new();
                rebuilt_parts.push(new_pattern_str.as_str());
                for rest in &parts[1..] {
                    rebuilt_parts.push(rest);
                }
                new_lines.push(rebuilt_parts.join(" "));
            }
            // Si aucun motif ne reste (ou si c'était l'entrée exacte changée/hachée), la ligne est omise
        } else {
            new_lines.push(line.to_string());
        }
    }

    let new_entry_target = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };

    let openssh_key = new_pubkey
        .to_openssh()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;

    new_lines.push(format!("{new_entry_target} {openssh_key}"));

    let mut result = new_lines.join("\n");
    result.push('\n');
    Ok(result)
}

/// Met à jour de façon atomique ~/.ssh/known_hosts de manière portable (compatible Windows, macOS et Linux).
pub fn replace_known_hosts_entry_atomic(
    host: &str,
    port: u16,
    new_pubkey: &russh::keys::ssh_key::PublicKey,
    changed_line: Option<usize>,
) -> std::io::Result<()> {
    let known_hosts_path = match dirs::home_dir() {
        Some(h) => h.join(".ssh").join("known_hosts"),
        None => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Répertoire personnel introuvable",
            ));
        }
    };

    let content = if known_hosts_path.exists() {
        std::fs::read_to_string(&known_hosts_path)?
    } else {
        String::new()
    };

    let updated_content =
        update_known_hosts_content(&content, host, port, new_pubkey, changed_line)?;

    let ssh_dir = match known_hosts_path.parent() {
        Some(p) => p,
        None => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Dossier parent de known_hosts introuvable",
            ));
        }
    };

    if !ssh_dir.exists() {
        std::fs::create_dir_all(ssh_dir)?;
    }

    let temp_path = ssh_dir.join(format!(".known_hosts.{}.tmp", std::process::id()));
    std::fs::write(&temp_path, updated_content)?;

    // Sur Windows, std::fs::rename échoue si le fichier de destination existe déjà.
    #[cfg(windows)]
    {
        if known_hosts_path.exists() {
            let backup_path = ssh_dir.join(format!(".known_hosts.{}.bak", std::process::id()));
            let _ = std::fs::remove_file(&backup_path);
            let _ = std::fs::rename(&known_hosts_path, &backup_path);
            if let Err(e) = std::fs::rename(&temp_path, &known_hosts_path) {
                let _ = std::fs::rename(&backup_path, &known_hosts_path);
                return Err(e);
            }
            let _ = std::fs::remove_file(&backup_path);
        } else {
            std::fs::rename(&temp_path, &known_hosts_path)?;
        }
    }

    #[cfg(not(windows))]
    {
        std::fs::rename(&temp_path, &known_hosts_path)?;
    }

    Ok(())
}

/// Trait permettant d'interagir avec l'utilisateur ou l'interface pour approuver une empreinte SSH.
#[async_trait::async_trait]
pub trait HostKeyPromptHandler: Send + Sync {
    async fn prompt(&self, req: HostKeyPromptRequest) -> HostKeyDecision;
}

struct Listener {
    request_id: String,
    tx: oneshot::Sender<HostKeyDecision>,
}

struct CoalescedPrompt {
    req: HostKeyPromptRequest,
    listeners: Vec<Listener>,
}

#[derive(Default)]
struct PromptState {
    by_target: HashMap<(String, u16, String), CoalescedPrompt>,
    by_request_id: HashMap<String, (String, u16, String)>,
}

/// Gestionnaire de requêtes d'approbation d'empreinte SSH en attente.
#[derive(Default)]
pub struct HostKeyPromptManager {
    state: Mutex<PromptState>,
}

impl HostKeyPromptManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(PromptState::default()),
        }
    }

    pub fn generate_request_id() -> String {
        let count = PROMPT_COUNTER.fetch_add(1, Ordering::SeqCst);
        let now = chrono::Utc::now().timestamp_millis();
        format!("prompt-{now}-{count}")
    }

    /// Enregistre une invite ou fusionne (coalesce) avec une invite concurrente déjà active pour le même hôte/clé.
    /// Retourne `(receiver, is_new_prompt)` : si `is_new_prompt` est faux, la modale est déjà affichée pour cette clé.
    pub async fn register_or_coalesce_prompt(
        &self,
        req: HostKeyPromptRequest,
    ) -> (oneshot::Receiver<HostKeyDecision>, bool) {
        let target_key = (req.host.clone(), req.port, req.fingerprint.clone());
        let (tx, rx) = oneshot::channel();
        let req_id = req.request_id.clone();

        let mut state = self.state.lock().await;
        state
            .by_request_id
            .insert(req_id.clone(), target_key.clone());

        if let Some(existing) = state.by_target.get_mut(&target_key) {
            existing.listeners.push(Listener {
                request_id: req_id,
                tx,
            });
            (rx, false)
        } else {
            state.by_target.insert(
                target_key,
                CoalescedPrompt {
                    req,
                    listeners: vec![Listener {
                        request_id: req_id,
                        tx,
                    }],
                },
            );
            (rx, true)
        }
    }

    pub async fn get_pending_requests(&self) -> Vec<HostKeyPromptRequest> {
        let state = self.state.lock().await;
        state.by_target.values().map(|c| c.req.clone()).collect()
    }

    pub async fn resolve_prompt(&self, request_id: &str, decision: HostKeyDecision) -> bool {
        let mut state = self.state.lock().await;
        let target_key = match state.by_request_id.remove(request_id) {
            Some(k) => k,
            None => return false,
        };

        if let Some(coalesced) = state.by_target.remove(&target_key) {
            // Nettoyer l'ID principal affiché ainsi que tous les request_ids associés
            state.by_request_id.remove(&coalesced.req.request_id);
            for listener in &coalesced.listeners {
                state.by_request_id.remove(&listener.request_id);
            }
            let mut delivered = false;
            for listener in coalesced.listeners {
                if listener.tx.send(decision).is_ok() {
                    delivered = true;
                }
            }
            delivered
        } else {
            false
        }
    }

    pub async fn cancel_prompt(&self, request_id: &str) {
        let mut state = self.state.lock().await;
        let target_key = match state.by_request_id.get(request_id).cloned() {
            Some(k) => k,
            None => return,
        };

        let mut remove_target = false;
        let mut primary_id_to_remove = None;
        let mut remove_caller_id = false;

        if let Some(coalesced) = state.by_target.get_mut(&target_key) {
            coalesced.listeners.retain(|l| l.request_id != request_id);

            if coalesced.listeners.is_empty() {
                remove_target = true;
                primary_id_to_remove = Some(coalesced.req.request_id.clone());
            } else if coalesced.req.request_id != request_id {
                remove_caller_id = true;
            }
        } else {
            remove_caller_id = true;
        }

        if let Some(id) = primary_id_to_remove {
            state.by_request_id.remove(&id);
        }
        if remove_caller_id {
            state.by_request_id.remove(request_id);
        }
        if remove_target {
            state.by_target.remove(&target_key);
        }
    }
}

/// RAII Drop guard pour garantir le nettoyage et l'expiration en cas d'annulation du future de connexion
struct PromptDropGuard {
    request_id: String,
    manager: Arc<HostKeyPromptManager>,
    app_handle: tauri::AppHandle,
    resolved: bool,
}

impl Drop for PromptDropGuard {
    fn drop(&mut self) {
        if !self.resolved {
            use tauri::Emitter;
            let req_id = self.request_id.clone();
            let mgr = Arc::clone(&self.manager);
            let app = self.app_handle.clone();
            tokio::spawn(async move {
                mgr.cancel_prompt(&req_id).await;
                let _ = app.emit(
                    "ssh:host-key-expired",
                    serde_json::json!({ "request_id": req_id }),
                );
            });
        }
    }
}

/// Implémentation du handler pour Tauri : émet un événement vers le frontend et attend la réponse.
pub struct TauriHostKeyPromptHandler {
    app_handle: tauri::AppHandle,
    manager: Arc<HostKeyPromptManager>,
}

impl TauriHostKeyPromptHandler {
    pub fn new(app_handle: tauri::AppHandle, manager: Arc<HostKeyPromptManager>) -> Self {
        Self {
            app_handle,
            manager,
        }
    }
}

#[async_trait::async_trait]
impl HostKeyPromptHandler for TauriHostKeyPromptHandler {
    async fn prompt(&self, req: HostKeyPromptRequest) -> HostKeyDecision {
        use tauri::Emitter;

        let request_id = req.request_id.clone();
        let (rx, is_new_prompt) = self.manager.register_or_coalesce_prompt(req.clone()).await;

        let mut guard = PromptDropGuard {
            request_id: request_id.clone(),
            manager: Arc::clone(&self.manager),
            app_handle: self.app_handle.clone(),
            resolved: false,
        };

        if is_new_prompt {
            if let Err(e) = self.app_handle.emit("ssh:host-key-prompt", &req) {
                eprintln!("Failed to emit ssh:host-key-prompt: {e}");
                guard.resolved = true;
                self.manager.cancel_prompt(&request_id).await;
                return HostKeyDecision::Reject;
            }
        }

        match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
            Ok(Ok(decision)) => {
                guard.resolved = true;
                decision
            }
            Ok(Err(_)) => {
                guard.resolved = true;
                HostKeyDecision::Reject
            }
            Err(_) => {
                guard.resolved = true;
                self.manager.cancel_prompt(&request_id).await;
                let _ = self.app_handle.emit(
                    "ssh:host-key-expired",
                    serde_json::json!({ "request_id": request_id }),
                );
                HostKeyDecision::Reject
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_request_id() {
        let id1 = HostKeyPromptManager::generate_request_id();
        let id2 = HostKeyPromptManager::generate_request_id();
        assert_ne!(id1, id2);
        assert!(id1.starts_with("prompt-"));
    }

    #[tokio::test]
    async fn test_coalesced_prompt_shares_decision() {
        let manager = HostKeyPromptManager::new();
        let req1 = HostKeyPromptRequest {
            request_id: "test-req-1".to_string(),
            host: "shared.example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:same_fingerprint".to_string(),
            is_new: true,
            changed_line: None,
        };

        let req2 = HostKeyPromptRequest {
            request_id: "test-req-2".to_string(),
            host: "shared.example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:same_fingerprint".to_string(),
            is_new: true,
            changed_line: None,
        };

        let (rx1, is_new1) = manager.register_or_coalesce_prompt(req1).await;
        let (rx2, is_new2) = manager.register_or_coalesce_prompt(req2).await;

        // The first prompt is new, the second is coalesced
        assert!(is_new1);
        assert!(!is_new2);
        assert_eq!(manager.get_pending_requests().await.len(), 1);

        // Resolving test-req-1 resolves both receivers!
        let resolved = manager
            .resolve_prompt("test-req-1", HostKeyDecision::AcceptAndRemember)
            .await;
        assert!(resolved);

        assert_eq!(rx1.await.unwrap(), HostKeyDecision::AcceptAndRemember);
        assert_eq!(rx2.await.unwrap(), HostKeyDecision::AcceptAndRemember);

        // Memory is cleanly cleared
        assert_eq!(manager.get_pending_requests().await.len(), 0);
    }

    #[tokio::test]
    async fn test_cancel_prompt_retains_coalesced_listeners() {
        let manager = HostKeyPromptManager::new();
        let req1 = HostKeyPromptRequest {
            request_id: "cancel-test-1".to_string(),
            host: "cancel.example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:cancel_fp".to_string(),
            is_new: true,
            changed_line: None,
        };
        let req2 = HostKeyPromptRequest {
            request_id: "cancel-test-2".to_string(),
            host: "cancel.example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:cancel_fp".to_string(),
            is_new: true,
            changed_line: None,
        };

        let (rx1, _) = manager.register_or_coalesce_prompt(req1).await;
        let (rx2, _) = manager.register_or_coalesce_prompt(req2).await;

        // Cancel only the first request
        manager.cancel_prompt("cancel-test-1").await;

        // rx1 was dropped by cancellation
        assert!(rx1.await.is_err());

        // The prompt is STILL pending because rx2 is waiting!
        assert_eq!(manager.get_pending_requests().await.len(), 1);

        // Crucial test: Resolving through the displayed request ID ("cancel-test-1")
        // still succeeds and delivers to surviving listener rx2!
        let resolved = manager
            .resolve_prompt("cancel-test-1", HostKeyDecision::AcceptOnce)
            .await;
        assert!(resolved);
        assert_eq!(rx2.await.unwrap(), HostKeyDecision::AcceptOnce);

        // Now both are resolved and cleared
        assert_eq!(manager.get_pending_requests().await.len(), 0);
    }

    #[test]
    fn test_update_known_hosts_preserves_other_algorithms_and_ca() {
        let raw_pub =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGt12r2S6bBv3VpXq5L6yUe0Vv4D3KjWv3m6v2y5Qz12 test";
        let new_pk = russh::keys::ssh_key::PublicKey::from_openssh(raw_pub).unwrap();

        let initial_content = "\
@cert-authority *.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICA_KEY ca
server.example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC_RSA rsa_key
server.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOLD_ED old_ed_key
";

        // Replace ssh-ed25519 on server.example.com (changed_line 3)
        let updated =
            update_known_hosts_content(initial_content, "server.example.com", 22, &new_pk, Some(3))
                .unwrap();

        // 1. @cert-authority is preserved
        assert!(updated.contains("@cert-authority *.example.com"));
        // 2. The ssh-rsa key for server.example.com is strictly preserved!
        assert!(updated.contains("server.example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC_RSA"));
        // 3. The old ed25519 key is gone
        assert!(!updated.contains("AAAAC3NzaC1lZDI1NTE5AAAAIOLD_ED"));
        // 4. The new ed25519 key is added
        assert!(updated.contains(&format!(
            "server.example.com {}",
            new_pk.to_openssh().unwrap()
        )));
    }

    fn sample_key() -> russh::keys::ssh_key::PublicKey {
        russh::keys::ssh_key::PublicKey::from_openssh(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGt12r2S6bBv3VpXq5L6yUe0Vv4D3KjWv3m6v2y5Qz12",
        )
        .unwrap()
    }

    #[test]
    fn test_validate_ssh_host_accepts_regular_hosts() {
        for host in [
            "example.com",
            "srv-01.internal",
            "my_host",
            "192.168.1.10",
            "2001:db8::1",
            "fe80::1%en0",
            "xn--caf-dma.fr",
            "café.fr",
        ] {
            assert!(
                validate_ssh_host(host).is_ok(),
                "{host:?} should be accepted"
            );
        }
    }

    #[test]
    fn test_validate_ssh_host_rejects_known_hosts_injection() {
        let too_long = "a".repeat(MAX_HOST_LEN + 1);
        for host in [
            "",
            "evil.com\n* ssh-ed25519 AAAA",
            "evil.com\r\nx",
            "host\0",
            "two words",
            "tab\there",
            "a,b",
            "#comment",
            "*",
            "host?",
            "!negated",
            "[::1]",
            "@cert-authority",
            "|1|hashed",
            "user@host",
            "a/b",
            "a\\b",
            "nbsp\u{a0}host",
            too_long.as_str(),
        ] {
            assert!(
                validate_ssh_host(host).is_err(),
                "{host:?} should be rejected"
            );
        }
    }

    #[test]
    fn test_update_known_hosts_rejects_injected_host() {
        let res = update_known_hosts_content(
            "",
            "evil.com\n* ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFORGED",
            22,
            &sample_key(),
            None,
        );
        assert!(res.is_err());
    }

    #[test]
    fn test_update_known_hosts_survives_corrupted_content() {
        let long_line = format!("host.example {}\n", "A".repeat(100_000));
        let corrupted = format!(
            "truncated\n\
             host.example ssh-ed25519\n\
             host.example ssh-ed25519 !!!not-base64!!!\n\
             host.example unknown-algo AAAA\n\
             \t   \n\
             # comment\r\n\
             @revoked\n\
             |1|bm90LWEtc2FsdA==|bm90LWEtaGFzaA== ssh-ed25519 AAAA\n\
             {long_line}\
             \u{feff}bom.example ssh-rsa AAAA\n"
        );
        let updated =
            update_known_hosts_content(&corrupted, "new.example", 22, &sample_key(), None).unwrap();
        // Unrelated lines are kept as they were.
        for kept in [
            "truncated",
            "host.example ssh-ed25519 !!!not-base64!!!",
            "host.example unknown-algo AAAA",
            "@revoked",
            "|1|bm90LWEtc2FsdA==|bm90LWEtaGFzaA== ssh-ed25519 AAAA",
        ] {
            assert!(updated.contains(kept), "{kept:?} should be preserved");
        }
        assert!(updated.contains(&"A".repeat(100_000)));
        // Exactly one new entry, on its own line.
        let new_entry = format!("new.example {}", sample_key().to_openssh().unwrap());
        assert_eq!(updated.lines().filter(|l| *l == new_entry).count(), 1);
        assert!(updated.ends_with('\n'));
    }

    #[test]
    fn test_update_known_hosts_out_of_range_changed_line() {
        let content = "a.example ssh-ed25519 AAAA\n";
        let updated =
            update_known_hosts_content(content, "b.example", 22, &sample_key(), Some(9999))
                .unwrap();
        assert!(updated.contains("a.example ssh-ed25519 AAAA"));
    }

    #[test]
    fn test_update_known_hosts_non_default_port_uses_brackets() {
        let content = "[srv.example]:2222 ssh-ed25519 OLD\nsrv.example ssh-ed25519 PORT22\n";
        let key = sample_key();
        let updated = update_known_hosts_content(content, "srv.example", 2222, &key, None).unwrap();
        // The port 22 entry is a different target and must stay.
        assert!(updated.contains("srv.example ssh-ed25519 PORT22"));
        assert!(!updated.contains("OLD"));
        assert!(updated.contains(&format!("[srv.example]:2222 {}", key.to_openssh().unwrap())));
    }
}
