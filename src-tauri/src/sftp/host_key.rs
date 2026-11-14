use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, oneshot};

use crate::models::{HostKeyDecision, HostKeyPromptRequest};

static PROMPT_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Supprime la ligne `line_number` (1-indexée) d'une chaîne représentant le contenu de known_hosts.
pub fn remove_line_from_content(content: &str, line_number: usize) -> String {
    if line_number == 0 {
        return content.to_string();
    }
    let mut new_lines = Vec::new();
    for (idx, line) in content.lines().enumerate() {
        if idx + 1 != line_number {
            new_lines.push(line);
        }
    }
    let mut updated = new_lines.join("\n");
    if !updated.is_empty() && (content.ends_with('\n') || content.is_empty()) {
        updated.push('\n');
    }
    updated
}

/// Supprime la ligne `line_number` (1-indexée) du fichier ~/.ssh/known_hosts de l'utilisateur.
pub fn remove_known_hosts_line(line_number: usize) -> std::io::Result<()> {
    if line_number == 0 {
        return Ok(());
    }
    let known_hosts_path = match dirs::home_dir() {
        Some(h) => h.join(".ssh").join("known_hosts"),
        None => return Ok(()),
    };
    if !known_hosts_path.exists() {
        return Ok(());
    }
    let content = std::fs::read_to_string(&known_hosts_path)?;
    let updated = remove_line_from_content(&content, line_number);
    std::fs::write(&known_hosts_path, updated)?;
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
}

impl HostKeyPromptManager {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn generate_request_id() -> String {
        let count = PROMPT_COUNTER.fetch_add(1, Ordering::SeqCst);
        let now = chrono::Utc::now().timestamp_millis();
        format!("prompt-{now}-{count}")
    }

    pub async fn register_prompt(&self, request_id: String) -> oneshot::Receiver<HostKeyDecision> {
        let (tx, rx) = oneshot::channel();
        let mut map = self.pending.lock().await;
        map.insert(request_id, tx);
        rx
    }

    pub async fn resolve_prompt(&self, request_id: &str, decision: HostKeyDecision) -> bool {
        let mut map = self.pending.lock().await;
        if let Some(tx) = map.remove(request_id) {
            tx.send(decision).is_ok()
        } else {
            false
        }
    }

    pub async fn cancel_prompt(&self, request_id: &str) {
        let mut map = self.pending.lock().await;
        map.remove(request_id);
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
        let rx = self.manager.register_prompt(request_id.clone()).await;

        if let Err(e) = self.app_handle.emit("ssh:host-key-prompt", &req) {
            eprintln!("Failed to emit ssh:host-key-prompt: {e}");
            self.manager.cancel_prompt(&request_id).await;
            return HostKeyDecision::Reject;
        }

        // Attente de la réponse utilisateur (délai max 60 secondes pour éviter de bloquer indéfiniment)
        match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
            Ok(Ok(decision)) => decision,
            Ok(Err(_)) => HostKeyDecision::Reject,
            Err(_) => {
                self.manager.cancel_prompt(&request_id).await;
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
        let req_id = "test-req-1".to_string();
        let rx = manager.register_prompt(req_id.clone()).await;

        let resolved = manager
            .resolve_prompt(&req_id, HostKeyDecision::AcceptAndRemember)
            .await;
        assert!(resolved);

        let decision = rx.await.unwrap();
        assert_eq!(decision, HostKeyDecision::AcceptAndRemember);
    }

    #[tokio::test]
    async fn test_cancel_prompt() {
        let manager = HostKeyPromptManager::new();
        let req_id = "test-req-2".to_string();
        let rx = manager.register_prompt(req_id.clone()).await;

        manager.cancel_prompt(&req_id).await;
        assert!(rx.await.is_err());
    }

    #[test]
    fn test_remove_line_from_content() {
        let content = "line1\nline2\nline3\n";
        // Remove line 2
        let res = remove_line_from_content(content, 2);
        assert_eq!(res, "line1\nline3\n");

        // Remove line 1
        let res1 = remove_line_from_content(content, 1);
        assert_eq!(res1, "line2\nline3\n");

        // Remove line 3
        let res3 = remove_line_from_content(content, 3);
        assert_eq!(res3, "line1\nline2\n");

        // Out of bounds / 0 does nothing
        assert_eq!(remove_line_from_content(content, 0), content);
        assert_eq!(remove_line_from_content(content, 99), content);
    }
}
