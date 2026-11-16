use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub storage_type: String, // "s3" | "sftp"
    pub endpoint: Option<String>,
    pub bucket: Option<String>,
    pub region: Option<String>,
    #[serde(rename = "accessKey", default)]
    pub access_key: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    #[serde(rename = "authType")]
    pub auth_type: Option<String>,
    #[serde(rename = "keyPath")]
    pub key_path: Option<String>,
    #[serde(rename = "isFavorite", default)]
    pub is_favorite: bool,
    #[serde(rename = "useSudo", default)]
    pub use_sudo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_at: String,
    pub permissions: Option<String>,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub etag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferProgress {
    pub transfer_id: String,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub speed_bps: u64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpConnectConfig {
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
    #[serde(default)]
    pub use_sudo: bool,
    pub sudo_password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3ConnectConfig {
    pub profile_id: String,
    pub endpoint: Option<String>,
    pub bucket: String,
    pub region: Option<String>,
    #[serde(rename = "accessKey")]
    pub access_key: String,
    #[serde(rename = "secretKey")]
    pub secret_key: Option<String>,
    #[serde(rename = "forcePathStyle", default)]
    pub force_path_style: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SudoCapability {
    None,
    Passwordless,
    PasswordRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpSessionInfo {
    pub profile_id: String,
    pub is_elevated: bool,
    pub sudo_capability: SudoCapability,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionTestResult {
    pub success: bool,
    pub message: String,
    pub logs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostKeyPromptRequest {
    pub request_id: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub is_new: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub changed_line: Option<usize>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostKeyDecision {
    AcceptAndRemember,
    AcceptOnce,
    Reject,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_connection_profile_use_sudo_serde() {
        let json = r#"{
            "id": "prof-1",
            "name": "Production Server",
            "type": "sftp",
            "host": "example.com",
            "port": 22,
            "username": "admin",
            "isFavorite": true,
            "useSudo": true
        }"#;

        let profile: ConnectionProfile = serde_json::from_str(json).unwrap();
        assert!(profile.use_sudo);

        let serialized = serde_json::to_string(&profile).unwrap();
        assert!(serialized.contains(r#""useSudo":true"#));

        // Default to false when omitted
        let json_omitted = r#"{
            "id": "prof-2",
            "name": "Local Server",
            "type": "sftp"
        }"#;
        let profile_omitted: ConnectionProfile = serde_json::from_str(json_omitted).unwrap();
        assert!(!profile_omitted.use_sudo);
    }
}
