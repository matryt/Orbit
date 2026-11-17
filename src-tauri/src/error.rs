use serde::Serialize;
use thiserror::Error;

#[derive(Error, Debug, Serialize)]
#[serde(tag = "type", content = "message")]
pub enum AppError {
    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    #[error("I/O error: {0}")]
    Io(String),

    #[error("SFTP error: {0}")]
    Sftp(String),

    #[error("SSH error: {0}")]
    Ssh(String),

    #[error("Authentication error: {0}")]
    Auth(String),

    #[error("Keyring error: {0}")]
    Keyring(String),

    #[error("Not connected: {0}")]
    NotConnected(String),

    #[error("Cancelled: {0}")]
    Cancelled(String),

    #[error("File not found: {0}")]
    NotFound(String),

    #[error("Invalid path: {0}")]
    InvalidPath(String),

    #[error("Transfer error: {0}")]
    Transfer(String),

    #[error("S3 error: {0}")]
    S3(String),
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::Io(err.to_string())
    }
}
