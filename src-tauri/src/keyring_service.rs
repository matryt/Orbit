use crate::error::AppError;
use keyring::Entry;

const SERVICE_NAME: &str = "com.orbit.app";

pub struct KeyringService;

impl KeyringService {
    pub fn save_secret(profile_id: &str, secret: &str) -> Result<(), AppError> {
        let entry =
            Entry::new(SERVICE_NAME, profile_id).map_err(|e| AppError::Keyring(e.to_string()))?;
        entry
            .set_password(secret)
            .map_err(|e| AppError::Keyring(e.to_string()))?;
        Ok(())
    }

    pub fn get_secret(profile_id: &str) -> Result<Option<String>, AppError> {
        let entry =
            Entry::new(SERVICE_NAME, profile_id).map_err(|e| AppError::Keyring(e.to_string()))?;
        match entry.get_password() {
            Ok(pwd) => Ok(Some(pwd)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::Keyring(e.to_string())),
        }
    }

    pub fn delete_secret(profile_id: &str) -> Result<(), AppError> {
        let entry =
            Entry::new(SERVICE_NAME, profile_id).map_err(|e| AppError::Keyring(e.to_string()))?;
        match entry.delete_credential() {
            Ok(_) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Keyring(e.to_string())),
        }
    }
}
