use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::models::ConnectionProfile;

static CONFIG_LOCK: Mutex<()> = Mutex::new(());

pub struct ConfigService;

impl ConfigService {
    pub fn get_connections_file(app: &AppHandle) -> Result<PathBuf, AppError> {
        let config_dir = app
            .path()
            .app_config_dir()
            .map_err(|e| AppError::Io(format!("Impossible d'accéder au dossier de config: {e}")))?;

        if !config_dir.exists() {
            fs::create_dir_all(&config_dir).map_err(|e| {
                AppError::Io(format!("Impossible de créer le dossier de config: {e}"))
            })?;
        }

        Ok(config_dir.join("connections.json"))
    }

    pub fn load_profiles(app: &AppHandle) -> Result<Vec<ConnectionProfile>, AppError> {
        let path = Self::get_connections_file(app)?;
        if !path.exists() {
            return Ok(Vec::new());
        }

        let content = fs::read_to_string(&path)
            .map_err(|e| AppError::Io(format!("Erreur de lecture de {}: {e}", path.display())))?;

        if content.trim().is_empty() {
            return Ok(Vec::new());
        }

        let profiles: Vec<ConnectionProfile> = serde_json::from_str(&content).map_err(|e| {
            AppError::Io(format!(
                "Erreur de désérialisation de connections.json: {e}"
            ))
        })?;

        Ok(profiles)
    }

    pub fn save_profiles(app: &AppHandle, profiles: &[ConnectionProfile]) -> Result<(), AppError> {
        let path = Self::get_connections_file(app)?;
        let json = serde_json::to_string_pretty(profiles)
            .map_err(|e| AppError::Io(format!("Erreur de sérialisation JSON: {e}")))?;

        fs::write(&path, json)
            .map_err(|e| AppError::Io(format!("Erreur d'écriture dans {}: {e}", path.display())))?;

        Ok(())
    }

    pub fn save_profile(app: &AppHandle, profile: ConnectionProfile) -> Result<(), AppError> {
        let _guard = CONFIG_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut profiles = Self::load_profiles(app)?;
        if let Some(pos) = profiles.iter().position(|p| p.id == profile.id) {
            profiles[pos] = profile;
        } else {
            profiles.push(profile);
        }
        Self::save_profiles(app, &profiles)
    }

    pub fn delete_profile(app: &AppHandle, profile_id: &str) -> Result<(), AppError> {
        let _guard = CONFIG_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut profiles = Self::load_profiles(app)?;
        profiles.retain(|p| p.id != profile_id);
        Self::save_profiles(app, &profiles)
    }
}
