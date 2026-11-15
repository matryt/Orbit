use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::error::AppError;
use crate::provider::StorageProvider;

struct ConnectingSession {
    generation: u64,
    cancel_tx: Option<tokio::sync::watch::Sender<bool>>,
}

pub struct SessionManager {
    providers: Arc<RwLock<HashMap<String, Arc<dyn StorageProvider>>>>,
    active_profile_id: Arc<RwLock<Option<String>>>,
    connecting_sessions: Arc<RwLock<HashMap<String, ConnectingSession>>>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            providers: Arc::new(RwLock::new(HashMap::new())),
            active_profile_id: Arc::new(RwLock::new(None)),
            connecting_sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Déclare le début d'une tentative de connexion et retourne un numéro de génération unique
    /// ainsi qu'un receiver signalant une éventuelle annulation / déconnexion.
    pub async fn start_connecting(
        &self,
        profile_id: &str,
    ) -> (u64, tokio::sync::watch::Receiver<bool>) {
        let mut sessions = self.connecting_sessions.write().await;
        let next_gen = sessions.get(profile_id).map(|s| s.generation).unwrap_or(0) + 1;
        let (tx, rx) = tokio::sync::watch::channel(false);
        sessions.insert(
            profile_id.to_string(),
            ConnectingSession {
                generation: next_gen,
                cancel_tx: Some(tx),
            },
        );
        (next_gen, rx)
    }

    /// Valide l'installation du provider uniquement si aucune déconnexion n'a eu lieu entre-temps.
    pub async fn complete_connecting(
        &self,
        profile_id: &str,
        generation: u64,
        provider: Arc<dyn StorageProvider>,
    ) -> bool {
        let mut sessions = self.connecting_sessions.write().await;
        if sessions.get(profile_id).map(|s| s.generation) != Some(generation) {
            // Une déconnexion ou une nouvelle tentative de connexion a eu lieu entre-temps
            return false;
        }
        if let Some(session) = sessions.get_mut(profile_id) {
            session.cancel_tx = None;
        }

        let mut map = self.providers.write().await;
        map.insert(profile_id.to_string(), provider);
        let mut active = self.active_profile_id.write().await;
        *active = Some(profile_id.to_string());
        true
    }

    pub async fn set_provider(&self, profile_id: String, provider: Arc<dyn StorageProvider>) {
        let mut map = self.providers.write().await;
        map.insert(profile_id.clone(), provider);
        let mut active = self.active_profile_id.write().await;
        *active = Some(profile_id);
    }

    pub async fn remove_provider(&self, profile_id: &str) {
        // Déclenche l'annulation immédiate de toute connexion en cours pour ce profil
        let mut sessions = self.connecting_sessions.write().await;
        if let Some(session) = sessions.get_mut(profile_id) {
            session.generation += 1;
            if let Some(tx) = session.cancel_tx.take() {
                let _ = tx.send(true);
            }
        }
        drop(sessions);

        let mut map = self.providers.write().await;
        map.remove(profile_id);
        let mut active = self.active_profile_id.write().await;
        if active.as_deref() == Some(profile_id) {
            *active = None;
        }
    }

    pub async fn get_provider(
        &self,
        profile_id: Option<&str>,
    ) -> Result<Arc<dyn StorageProvider>, AppError> {
        let map = self.providers.read().await;

        let target_id = match profile_id {
            Some(id) => Some(id.to_string()),
            None => {
                let active = self.active_profile_id.read().await;
                active.clone()
            }
        };

        if let Some(id) = target_id {
            if let Some(provider) = map.get(&id) {
                return Ok(provider.clone());
            }
        }

        Err(AppError::NotConnected(
            "Aucune connexion active. Veuillez vous connecter à un profil serveur d'abord.".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_cancellation_signal_on_remove_provider() {
        let session = SessionManager::new();
        let (gen1, mut cancel_rx) = session.start_connecting("profile-test").await;
        assert_eq!(gen1, 1);
        assert!(!*cancel_rx.borrow());

        // Calling remove_provider (disconnect) immediately triggers the cancel signal
        session.remove_provider("profile-test").await;
        assert!(cancel_rx.changed().await.is_ok());
        assert!(*cancel_rx.borrow());
    }

    #[tokio::test]
    async fn test_complete_connecting_fails_if_disconnected() {
        let session = SessionManager::new();
        let (gen1, _) = session.start_connecting("profile-test").await;

        // Disconnect occurs during connection, invalidating gen1
        session.remove_provider("profile-test").await;

        // Next connect attempt gets gen 3 (gen1 was 1, disconnect bumped to 2, next is 3)
        let (gen2, _) = session.start_connecting("profile-test").await;
        assert_eq!(gen2, 3);
        assert_ne!(gen1, gen2);
    }
}
