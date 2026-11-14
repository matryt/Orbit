use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, oneshot};

use crate::models::{HostKeyDecision, HostKeyPromptRequest};

static PROMPT_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Met à jour une chaîne représentant le contenu de known_hosts en retirant `host` (et `[host]:port`)
/// de toute ligne correspondante (tout en conservant les autres motifs séparés par des virgules),
/// et en ajoutant la nouvelle entrée avec `new_pubkey`.
pub fn update_known_hosts_content(
    content: &str,
    host: &str,
    port: u16,
    new_pubkey: &russh::keys::ssh_key::PublicKey,
) -> std::io::Result<String> {
    let target_plain = host;
    let target_port = format!("[{host}]:{port}");

    let mut new_lines = Vec::new();

    for line in content.lines() {
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

        let (marker, pattern_idx) = if parts[0].starts_with('@') {
            (Some(parts[0]), 1)
        } else {
            (None, 0)
        };

        if parts.len() <= pattern_idx + 1 {
            new_lines.push(line.to_string());
            continue;
        }

        let patterns_str = parts[pattern_idx];
        let patterns: Vec<&str> = patterns_str.split(',').collect();

        let matches_target = |pat: &&str| -> bool {
            if port == 22 {
                *pat == target_plain || *pat == target_port.as_str()
            } else {
                *pat == target_port.as_str()
            }
        };

        if patterns.iter().any(matches_target) {
            let remaining_patterns: Vec<&str> = patterns
                .into_iter()
                .filter(|pat| !matches_target(pat))
                .collect();

            if !remaining_patterns.is_empty() {
                let new_pattern_str = remaining_patterns.join(",");
                let mut rebuilt_parts = Vec::new();
                if let Some(m) = marker {
                    rebuilt_parts.push(m);
                }
                rebuilt_parts.push(&new_pattern_str);
                for rest in &parts[(pattern_idx + 1)..] {
                    rebuilt_parts.push(rest);
                }
                new_lines.push(rebuilt_parts.join(" "));
            }
            // Si aucun motif ne reste, la ligne est omise (elle concernait uniquement cet hôte)
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

/// Met à jour de façon atomique ~/.ssh/known_hosts pour remplacer la clé d'hôte.
pub fn replace_known_hosts_entry_atomic(
    host: &str,
    port: u16,
    new_pubkey: &russh::keys::ssh_key::PublicKey,
) -> std::io::Result<()> {
    let known_hosts_path = match dirs::home_dir() {
        Some(h) => h.join(".ssh").join("known_hosts"),
        None => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Répertoire personnel introuvable",
            ))
        }
    };

    let content = if known_hosts_path.exists() {
        std::fs::read_to_string(&known_hosts_path)?
    } else {
        String::new()
    };

    let updated_content = update_known_hosts_content(&content, host, port, new_pubkey)?;

    let ssh_dir = match known_hosts_path.parent() {
        Some(p) => p,
        None => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Dossier parent de known_hosts introuvable",
            ))
        }
    };

    if !ssh_dir.exists() {
        std::fs::create_dir_all(ssh_dir)?;
    }

    let temp_path = ssh_dir.join(format!(".known_hosts.{}.tmp", std::process::id()));
    std::fs::write(&temp_path, updated_content)?;
    std::fs::rename(&temp_path, &known_hosts_path)?;

    Ok(())
}

/// Trait permettant d'interagir avec l'utilisateur ou l'interface pour approuver une empreinte SSH.
#[async_trait::async_trait]
pub trait HostKeyPromptHandler: Send + Sync {
    async fn prompt(&self, req: HostKeyPromptRequest) -> HostKeyDecision;
}

/// Gestionnaire de requêtes d'approbation d'empreinte SSH en attente.
#[derive(Default)]
pub struct HostKeyPromptManager {
    pending: Mutex<HashMap<String, oneshot::Sender<HostKeyDecision>>>,
    pending_requests: Mutex<HashMap<String, HostKeyPromptRequest>>,
    in_flight_enrollments: Mutex<HashMap<(String, u16), russh::keys::ssh_key::PublicKey>>,
}

impl HostKeyPromptManager {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            pending_requests: Mutex::new(HashMap::new()),
            in_flight_enrollments: Mutex::new(HashMap::new()),
        }
    }

    pub fn generate_request_id() -> String {
        let count = PROMPT_COUNTER.fetch_add(1, Ordering::SeqCst);
        let now = chrono::Utc::now().timestamp_millis();
        format!("prompt-{now}-{count}")
    }

    pub async fn register_prompt(
        &self,
        req: HostKeyPromptRequest,
    ) -> oneshot::Receiver<HostKeyDecision> {
        let (tx, rx) = oneshot::channel();
        let mut map = self.pending.lock().await;
        let mut req_map = self.pending_requests.lock().await;
        req_map.insert(req.request_id.clone(), req.clone());
        map.insert(req.request_id, tx);
        rx
    }

    pub async fn get_pending_requests(&self) -> Vec<HostKeyPromptRequest> {
        let req_map = self.pending_requests.lock().await;
        req_map.values().cloned().collect()
    }

    pub async fn is_in_flight_enrolled(
        &self,
        host: &str,
        port: u16,
        pubkey: &russh::keys::ssh_key::PublicKey,
    ) -> bool {
        let enrollments = self.in_flight_enrollments.lock().await;
        if let Some(existing) = enrollments.get(&(host.to_string(), port)) {
            existing == pubkey
        } else {
            false
        }
    }

    pub async fn record_in_flight_enrollment(
        &self,
        host: String,
        port: u16,
        pubkey: russh::keys::ssh_key::PublicKey,
    ) {
        let mut enrollments = self.in_flight_enrollments.lock().await;
        enrollments.insert((host, port), pubkey);
    }

    pub async fn resolve_prompt(&self, request_id: &str, decision: HostKeyDecision) -> bool {
        let mut map = self.pending.lock().await;
        let mut req_map = self.pending_requests.lock().await;
        req_map.remove(request_id);
        if let Some(tx) = map.remove(request_id) {
            tx.send(decision).is_ok()
        } else {
            false
        }
    }

    pub async fn cancel_prompt(&self, request_id: &str) {
        let mut map = self.pending.lock().await;
        let mut req_map = self.pending_requests.lock().await;
        req_map.remove(request_id);
        map.remove(request_id);
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
        let rx = self.manager.register_prompt(req.clone()).await;

        let mut guard = PromptDropGuard {
            request_id: request_id.clone(),
            manager: Arc::clone(&self.manager),
            app_handle: self.app_handle.clone(),
            resolved: false,
        };

        if let Err(e) = self.app_handle.emit("ssh:host-key-prompt", &req) {
            eprintln!("Failed to emit ssh:host-key-prompt: {e}");
            guard.resolved = true;
            self.manager.cancel_prompt(&request_id).await;
            return HostKeyDecision::Reject;
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
                // Expiration (60s) : notifier le frontend pour fermer le modal
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
    async fn test_resolve_prompt() {
        let manager = HostKeyPromptManager::new();
        let req = HostKeyPromptRequest {
            request_id: "test-req-1".to_string(),
            host: "example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:abc".to_string(),
            is_new: true,
            changed_line: None,
        };

        let rx = manager.register_prompt(req).await;
        assert_eq!(manager.get_pending_requests().await.len(), 1);

        let resolved = manager
            .resolve_prompt("test-req-1", HostKeyDecision::AcceptAndRemember)
            .await;
        assert!(resolved);
        assert_eq!(manager.get_pending_requests().await.len(), 0);

        let decision = rx.await.unwrap();
        assert_eq!(decision, HostKeyDecision::AcceptAndRemember);
    }

    #[tokio::test]
    async fn test_cancel_prompt() {
        let manager = HostKeyPromptManager::new();
        let req = HostKeyPromptRequest {
            request_id: "test-req-2".to_string(),
            host: "example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:abc".to_string(),
            is_new: true,
            changed_line: None,
        };

        let rx = manager.register_prompt(req).await;
        assert_eq!(manager.get_pending_requests().await.len(), 1);

        manager.cancel_prompt("test-req-2").await;
        assert_eq!(manager.get_pending_requests().await.len(), 0);
        assert!(rx.await.is_err());
    }

    #[test]
    fn test_update_known_hosts_content_preserves_other_hosts() {
        let raw_pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGt12r2S6bBv3VpXq5L6yUe0Vv4D3KjWv3m6v2y5Qz12 test";
        let new_pk = russh::keys::ssh_key::PublicKey::from_openssh(raw_pub).unwrap();

        let initial_content = "\
# Comment line
server1,192.168.1.1,server.example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC old_key
unrelated.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI123456 other_key
";

        // Replace server.example.com
        let updated = update_known_hosts_content(initial_content, "server.example.com", 22, &new_pk)
            .unwrap();

        // 1. Comment line is preserved
        assert!(updated.contains("# Comment line"));
        // 2. Unrelated host is preserved
        assert!(updated.contains("unrelated.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI123456 other_key"));
        // 3. The other hosts on that line (server1, 192.168.1.1) still keep their old key!
        assert!(updated.contains("server1,192.168.1.1 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC old_key"));
        // 4. A new dedicated line for server.example.com with new key is added at the end
        assert!(updated.contains(&format!("server.example.com {}", new_pk.to_openssh().unwrap())));
    }

    #[test]
    fn test_update_known_hosts_content_single_host_line_removed() {
        let raw_pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGt12r2S6bBv3VpXq5L6yUe0Vv4D3KjWv3m6v2y5Qz12 test";
        let new_pk = russh::keys::ssh_key::PublicKey::from_openssh(raw_pub).unwrap();

        let initial_content = "\
[myhost.com]:2222 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC old_key
";

        let updated = update_known_hosts_content(initial_content, "myhost.com", 2222, &new_pk).unwrap();

        // The old line dedicated to [myhost.com]:2222 must be replaced, not duplicated
        assert!(!updated.contains("old_key"));
        assert!(updated.contains(&format!("[myhost.com]:2222 {}", new_pk.to_openssh().unwrap())));
    }
}
