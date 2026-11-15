use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Deserialize)]
pub struct GitHubAsset {
    pub name: String,
    pub browser_download_url: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GitHubRelease {
    pub tag_name: String,
    pub name: Option<String>,
    pub html_url: String,
    pub body: Option<String>,
    pub published_at: Option<String>,
    #[serde(default)]
    pub assets: Vec<GitHubAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub release_name: String,
    pub release_notes: String,
    pub published_at: Option<String>,
    pub release_url: String,
    pub download_url: Option<String>,
    pub asset_name: Option<String>,
}

/// Parses a SemVer-like version string into (major, minor, patch).
/// Strips leading 'v' / 'V' and ignores prerelease tags for comparison.
pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let cleaned = v.trim().trim_start_matches(['v', 'V']);
    // Strip prerelease suffix (e.g. "-beta.1")
    let core = cleaned.split(['-', '+']).next()?;
    let mut parts = core.split('.');

    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;

    Some((major, minor, patch))
}

/// Returns true if `latest` is strictly greater than `current`.
pub fn is_newer_version(current: &str, latest: &str) -> bool {
    let (c_maj, c_min, c_patch) = match parse_version(current) {
        Some(v) => v,
        None => return false,
    };
    let (l_maj, l_min, l_patch) = match parse_version(latest) {
        Some(v) => v,
        None => return false,
    };

    (l_maj, l_min, l_patch) > (c_maj, c_min, c_patch)
}

/// Selects the best download asset for the current operating system.
pub fn find_os_asset(assets: &[GitHubAsset]) -> Option<(String, String)> {
    let target_os = std::env::consts::OS;

    for asset in assets {
        let name_lower = asset.name.to_lowercase();
        let matches = match target_os {
            "macos" => name_lower.ends_with(".dmg"),
            "windows" => name_lower.ends_with(".exe") || name_lower.ends_with(".msi"),
            "linux" => name_lower.ends_with(".appimage") || name_lower.ends_with(".deb"),
            _ => false,
        };
        if matches {
            return Some((asset.browser_download_url.clone(), asset.name.clone()));
        }
    }

    None
}

/// Checks GitHub for the latest release of Orbit.
pub async fn check_for_updates() -> Result<UpdateCheckResult, AppError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| AppError::Io(format!("Failed to build HTTP client: {e}")))?;

    let url = "https://api.github.com/repos/matryt/Orbit/releases/latest";
    let resp = client
        .get(url)
        .header("User-Agent", "Orbit-Desktop-App")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| AppError::Io(format!("Erreur réseau vérification mise à jour: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::Io(format!(
            "GitHub API error: status {}",
            resp.status()
        )));
    }

    let release = resp
        .json::<GitHubRelease>()
        .await
        .map_err(|e| AppError::Io(format!("Format réponse GitHub invalide: {e}")))?;

    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let has_update = is_newer_version(&current_version, &release.tag_name);

    let (download_url, asset_name) = match find_os_asset(&release.assets) {
        Some((url, name)) => (Some(url), Some(name)),
        None => (Some(release.html_url.clone()), None),
    };

    Ok(UpdateCheckResult {
        current_version,
        latest_version: release.tag_name.clone(),
        has_update,
        release_name: release.name.unwrap_or(release.tag_name),
        release_notes: release.body.unwrap_or_default(),
        published_at: release.published_at,
        release_url: release.html_url,
        download_url,
        asset_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_version() {
        assert_eq!(parse_version("0.1.2"), Some((0, 1, 2)));
        assert_eq!(parse_version("v0.1.2"), Some((0, 1, 2)));
        assert_eq!(parse_version("V1.0.0"), Some((1, 0, 0)));
        assert_eq!(parse_version("v0.2.0-beta.1"), Some((0, 2, 0)));
        assert_eq!(parse_version("invalid"), None);
    }

    #[test]
    fn test_is_newer_version() {
        // Newer versions
        assert!(is_newer_version("0.1.2", "0.1.3"));
        assert!(is_newer_version("0.1.2", "v0.2.0"));
        assert!(is_newer_version("0.1.2", "1.0.0"));
        assert!(is_newer_version("v0.1.2", "v0.2.0"));

        // Equal or older
        assert!(!is_newer_version("0.1.2", "0.1.2"));
        assert!(!is_newer_version("v0.1.2", "0.1.2"));
        assert!(!is_newer_version("0.2.0", "0.1.2"));
        assert!(!is_newer_version("1.0.0", "0.9.9"));
        assert!(!is_newer_version("0.1.2", "invalid"));
    }

    #[test]
    fn test_find_os_asset() {
        let assets = vec![
            GitHubAsset {
                name: "Orbit_0.2.0_universal.dmg".to_string(),
                browser_download_url: "https://example.com/Orbit.dmg".to_string(),
                size: 1000,
            },
            GitHubAsset {
                name: "Orbit_0.2.0_x64-setup.exe".to_string(),
                browser_download_url: "https://example.com/Orbit.exe".to_string(),
                size: 2000,
            },
        ];

        let found = find_os_asset(&assets);
        assert!(found.is_some());
        let (url, name) = found.unwrap();
        #[cfg(target_os = "macos")]
        {
            assert!(name.ends_with(".dmg"));
            assert_eq!(url, "https://example.com/Orbit.dmg");
        }
        #[cfg(target_os = "windows")]
        {
            assert!(name.ends_with(".exe"));
            assert_eq!(url, "https://example.com/Orbit.exe");
        }
    }
}
