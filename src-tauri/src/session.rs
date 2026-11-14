use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::error::AppError;
use crate::provider::StorageProvider;

pub struct SessionManager {
    providers: Arc<RwLock<HashMap<String, Arc<dyn StorageProvider>>>>,
    active_profile_id: Arc<RwLock<Option<String>>>,
    connecting_generations: Arc<RwLock<HashMap<String, u64>>>,
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
            connecting_generations: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Déclare le début d'une tentative de connexion et retourne un numéro de génération unique.
    pub async fn start_connecting(&self, profile_id: &str) -> u64 {
        let mut gens = self.connecting_generations.write().await;
        let next_gen = gens.get(profile_id).copied().unwrap_or(0) + 1;
        gens.insert(profile_id.to_string(), next_gen);
        next_gen
    }

    /// Valide l'installation du provider uniquement si aucune déconnexion n'a eu lieu entre-temps.
    pub async fn complete_connecting(
        &self,
        profile_id: &str,
        generation: u64,
        provider: Arc<dyn StorageProvider>,
    ) -> bool {
        let gens = self.connecting_generations.read().await;
        if gens.get(profile_id).copied() != Some(generation) {
            // Une déconnexion ou une nouvelle connexion a été initiée entre-temps : annuler
            return false;
        }
        drop(gens);

        self.set_provider(profile_id.to_string(), provider).await;
        true
    }

    pub async fn set_provider(&self, profile_id: String, provider: Arc<dyn StorageProvider>) {
        let mut map = self.providers.write().await;
        map.insert(profile_id.clone(), provider);
        let mut active = self.active_profile_id.write().await;
        *active = Some(profile_id);
    }

    pub async fn remove_provider(&self, profile_id: &str) {
        // Incrémente la génération pour invalider toute connexion en cours pour ce profil
        let mut gens = self.connecting_generations.write().await;
        let next_gen = gens.get(profile_id).copied().unwrap_or(0) + 1;
        gens.insert(profile_id.to_string(), next_gen);
        drop(gens);

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
