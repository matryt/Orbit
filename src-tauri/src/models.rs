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
    /// Optional SSH agent socket (or Windows named pipe) used when `auth_type` is "agent".
    #[serde(
        rename = "agentSocket",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_socket: Option<String>,
    #[serde(rename = "isFavorite", default)]
    pub is_favorite: bool,
    #[serde(rename = "useSudo", default)]
    pub use_sudo: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bastion: Option<BastionConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<ProxyConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(default)]
    pub is_symlink: bool,
    pub size: u64,
    pub modified_at: String,
    pub permissions: Option<String>,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub etag: Option<String>,
}

/// Identity of a remote file revision, used to detect changes made by someone else.
///
/// Two fingerprints are equal when the remote file was (very likely) not modified in between.
/// SFTP only offers a one-second `mtime` resolution, so a same-size change within the same
/// second goes unnoticed; S3 adds the ETag, which changes with the content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFingerprint {
    pub size: u64,
    pub modified: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct BastionConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(rename = "profileId", default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(rename = "authType", default, skip_serializing_if = "Option::is_none")]
    pub auth_type: Option<String>,
    #[serde(rename = "keyPath", default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    #[serde(
        rename = "agentSocket",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_socket: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ProxyConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(rename = "proxyType", default, skip_serializing_if = "Option::is_none")]
    pub proxy_type: Option<String>, // "socks5" | "http"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpConnectConfig {
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// "password" | "key" | "agent"; `None` keeps the legacy inference from the other fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_type: Option<String>,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_socket: Option<String>,
    #[serde(default)]
    pub use_sudo: bool,
    pub sudo_password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bastion: Option<BastionConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<ProxyConfig>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfigImportResult {
    pub profiles: Vec<ConnectionProfile>,
    pub warnings: Vec<String>,
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

    #[test]
    fn test_connection_profile_bastion_and_proxy_serde() {
        let json = r#"{
            "id": "prof-with-jump",
            "name": "Jump Server",
            "type": "sftp",
            "host": "internal.lan",
            "port": 22,
            "username": "deploy",
            "bastion": {
                "enabled": true,
                "profileId": "prof-bastion-1"
            },
            "proxy": {
                "enabled": true,
                "proxyType": "socks5",
                "host": "127.0.0.1",
                "port": 1080
            }
        }"#;

        let profile: ConnectionProfile = serde_json::from_str(json).unwrap();
        assert!(profile.bastion.is_some());
        let bastion = profile.bastion.as_ref().unwrap();
        assert!(bastion.enabled);
        assert_eq!(bastion.profile_id.as_deref(), Some("prof-bastion-1"));

        assert!(profile.proxy.is_some());
        let proxy = profile.proxy.as_ref().unwrap();
        assert!(proxy.enabled);
        assert_eq!(proxy.proxy_type.as_deref(), Some("socks5"));
        assert_eq!(proxy.host.as_deref(), Some("127.0.0.1"));
        assert_eq!(proxy.port, Some(1080));

        let serialized = serde_json::to_string(&profile).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(parsed["bastion"]["profileId"], "prof-bastion-1");
        assert_eq!(parsed["bastion"]["enabled"], true);
        assert_eq!(parsed["proxy"]["proxyType"], "socks5");
        assert_eq!(parsed["proxy"]["port"], 1080);
    }
}
