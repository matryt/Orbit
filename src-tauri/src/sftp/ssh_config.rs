//! Parser and importer for OpenSSH `ssh_config` (`~/.ssh/config`).
//!
//! Maps `Host` entries into Orbit SFTP `ConnectionProfile`s:
//! - `HostName` -> `profile.host` (defaults to the concrete Host alias if omitted)
//! - `User` -> `profile.username`
//! - `Port` -> `profile.port` (defaults to 22)
//! - `IdentityFile` -> `profile.key_path` (with `~` expanded to user home)
//! - `IdentityAgent` -> `profile.agent_socket` (with `~` expanded to user home)
//! - `ProxyJump` -> `profile.bastion` (links directly to another parsed host profile or existing profile, or inline bastion)

use std::collections::HashMap;
use std::path::Path;

use crate::error::AppError;
use crate::models::{BastionConfig, ConnectionProfile, SshConfigImportResult};
use crate::sftp::agent;
use crate::sftp::host_key::validate_ssh_host;

/// Raw directive values extracted for a block.
#[derive(Debug, Clone, Default)]
struct DirectiveSet {
    hostname: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
    proxy_jump: Option<String>,
    identity_agent: Option<String>,
}

impl DirectiveSet {
    /// Applies a directive key-value pair, keeping the first defined value (OpenSSH semantics).
    fn set_directive(&mut self, key: &str, val: String) {
        match key {
            "hostname" => {
                self.hostname.get_or_insert(val);
            }
            "user" => {
                self.user.get_or_insert(val);
            }
            "port" => {
                if self.port.is_none() {
                    if let Ok(p) = val.parse::<u16>() {
                        if p > 0 {
                            self.port = Some(p);
                        }
                    }
                }
            }
            "identityfile" => {
                self.identity_file.get_or_insert(val);
            }
            "proxyjump" => {
                self.proxy_jump.get_or_insert(val);
            }
            "identityagent" => {
                self.identity_agent.get_or_insert(val);
            }
            _ => {}
        }
    }
}

/// A parsed concrete host entry ready for profile conversion.
#[derive(Debug, Clone)]
struct ParsedHostEntry {
    name: String,
    directives: DirectiveSet,
}

/// Parses `[user@]host[:port]` target from a `ProxyJump` directive.
/// Handles bracketed IPv6 addresses such as `[2001:db8::1]:2222`.
pub fn parse_jump_target(target: &str) -> (Option<String>, String, Option<u16>) {
    let target = target.trim();
    let (user, remainder) = if let Some((u, r)) = target.split_once('@') {
        (Some(u.trim().to_string()), r.trim())
    } else {
        (None, target)
    };

    // Bracketed IPv6: [2001:db8::1]:2222 or [2001:db8::1]
    if remainder.starts_with('[') {
        if let Some(end_bracket) = remainder.find(']') {
            let host = remainder[1..end_bracket].to_string();
            let after = &remainder[end_bracket + 1..];
            let port = if let Some(colon) = after.strip_prefix(':') {
                colon.parse::<u16>().ok()
            } else {
                None
            };
            return (user, host, port);
        }
    }

    // Unbracketed IPv6 with multiple colons: do not split as port
    if remainder.contains(':') && remainder.matches(':').count() > 1 {
        return (user, remainder.to_string(), None);
    }

    // Standard host[:port]
    if let Some((h, p)) = remainder.rsplit_once(':') {
        if let Ok(port) = p.parse::<u16>() {
            return (user, h.to_string(), Some(port));
        }
    }

    (user, remainder.to_string(), None)
}

/// Cleans an argument: strips inline comments (preceded by whitespace and `#`) and surrounding quotes.
fn clean_arg(raw: &str) -> String {
    let trimmed = raw.trim();
    // Strip trailing comment if not quoted
    let without_comment = if !trimmed.starts_with('"') && !trimmed.starts_with('\'') {
        if let Some(idx) = trimmed.find(" #") {
            trimmed[..idx].trim()
        } else if let Some(idx) = trimmed.find("\t#") {
            trimmed[..idx].trim()
        } else {
            trimmed
        }
    } else {
        trimmed
    };

    let s = without_comment.trim();
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        s[1..s.len() - 1].trim().to_string()
    } else {
        s.to_string()
    }
}

/// Parses a line into `(key, value)` where delimiter is whitespace or `=`.
fn parse_line_directive(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }

    // Find first whitespace or '='
    let sep_pos = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let key = line[..sep_pos].trim().to_lowercase();
    let rest = line[sep_pos..].trim_start();
    let val_raw = if let Some(after_eq) = rest.strip_prefix('=') {
        after_eq.trim_start()
    } else {
        rest
    };

    let value = clean_arg(val_raw);
    if key.is_empty() || value.is_empty() {
        return None;
    }

    Some((key, value))
}

/// Parses the contents of an SSH configuration file into `ConnectionProfile`s.
pub fn parse_ssh_config(
    content: &str,
    existing_profiles: &[ConnectionProfile],
    home_dir: Option<&Path>,
) -> SshConfigImportResult {
    let mut warnings = Vec::new();
    let mut global_defaults = DirectiveSet::default();
    let mut parsed_entries: Vec<ParsedHostEntry> = Vec::new();

    // Context: None = global defaults, Some(vec_of_hostnames) = in host block
    let mut current_hosts: Option<Vec<String>> = None;
    let mut current_directives = DirectiveSet::default();

    let commit_current_block = |hosts_opt: Option<Vec<String>>,
                                directives: DirectiveSet,
                                out: &mut Vec<ParsedHostEntry>,
                                defaults: &mut DirectiveSet| {
        match hosts_opt {
            Some(hosts) => {
                for h in hosts {
                    out.push(ParsedHostEntry {
                        name: h,
                        directives: directives.clone(),
                    });
                }
            }
            None => {
                // Was global defaults
                if defaults.hostname.is_none() {
                    defaults.hostname = directives.hostname;
                }
                if defaults.user.is_none() {
                    defaults.user = directives.user;
                }
                if defaults.port.is_none() {
                    defaults.port = directives.port;
                }
                if defaults.identity_file.is_none() {
                    defaults.identity_file = directives.identity_file;
                }
                if defaults.proxy_jump.is_none() {
                    defaults.proxy_jump = directives.proxy_jump;
                }
                if defaults.identity_agent.is_none() {
                    defaults.identity_agent = directives.identity_agent;
                }
            }
        }
    };

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if let Some((key, value)) = parse_line_directive(trimmed) {
            if key == "host" {
                // Commit previous block
                commit_current_block(
                    current_hosts.take(),
                    current_directives,
                    &mut parsed_entries,
                    &mut global_defaults,
                );
                current_directives = DirectiveSet::default();

                // Split patterns by whitespace
                let patterns: Vec<String> = value
                    .split_whitespace()
                    .map(clean_arg)
                    .filter(|p| !p.is_empty())
                    .collect();

                let concrete: Vec<String> = patterns
                    .into_iter()
                    .filter(|p| !p.contains('*') && !p.contains('?'))
                    .collect();

                if concrete.is_empty() {
                    // Wildcard host block (e.g. `Host *`) treated as global defaults
                    current_hosts = None;
                } else {
                    current_hosts = Some(concrete);
                }
            } else if key == "match" {
                // Orbit does not evaluate Match conditional blocks; commit and treat as ignored
                commit_current_block(
                    current_hosts.take(),
                    current_directives,
                    &mut parsed_entries,
                    &mut global_defaults,
                );
                current_directives = DirectiveSet::default();
                current_hosts = None;
            } else {
                current_directives.set_directive(&key, value);
            }
        }
    }

    // Commit final block
    commit_current_block(
        current_hosts.take(),
        current_directives,
        &mut parsed_entries,
        &mut global_defaults,
    );

    // First pass: generate safe unique IDs and base profiles for all valid concrete hosts.
    // Map of lowercase host alias -> (profile_id, index in profiles)
    let mut alias_to_profile_idx: HashMap<String, usize> = HashMap::new();
    let mut intermediate_profiles: Vec<(ConnectionProfile, Option<String>)> = Vec::new();

    for entry in parsed_entries {
        let host_val = entry
            .directives
            .hostname
            .clone()
            .or_else(|| global_defaults.hostname.clone())
            .unwrap_or_else(|| entry.name.clone());

        if let Err(err) = validate_ssh_host(&host_val) {
            warnings.push(format!(
                "Hôte '{}' ignoré car l'adresse '{}' est invalide : {}",
                entry.name, host_val, err
            ));
            continue;
        }

        let user_val = entry
            .directives
            .user
            .clone()
            .or_else(|| global_defaults.user.clone());

        let port_val = entry.directives.port.or(global_defaults.port).unwrap_or(22);

        let identity_file_raw = entry
            .directives
            .identity_file
            .clone()
            .or_else(|| global_defaults.identity_file.clone());

        let key_path = identity_file_raw.map(|p| {
            agent::expand_home(&p, home_dir)
                .to_string_lossy()
                .into_owned()
        });

        let identity_agent_raw = entry
            .directives
            .identity_agent
            .clone()
            .or_else(|| global_defaults.identity_agent.clone())
            .filter(|a| a.to_lowercase() != "none");

        let agent_socket = identity_agent_raw.map(|a| {
            agent::expand_home(&a, home_dir)
                .to_string_lossy()
                .into_owned()
        });

        let is_pub = key_path
            .as_deref()
            .map(|kp| agent::is_public_key_path(Path::new(kp)))
            .unwrap_or(false);

        let auth_type = if agent_socket.is_some() || is_pub {
            Some("agent".to_string())
        } else if key_path.is_some() {
            Some("key".to_string())
        } else {
            None
        };

        let proxy_jump_raw = entry
            .directives
            .proxy_jump
            .clone()
            .or_else(|| global_defaults.proxy_jump.clone())
            .filter(|pj| pj.to_lowercase() != "none" && pj.to_lowercase() != "off");

        // Safe ID generation: alphanumeric with prefix, never contains ':' to prevent keyring collision.
        let safe_id = format!("prof-ssh-{}", fastrand::u64(100_000_000..999_999_999));

        let profile = ConnectionProfile {
            id: safe_id,
            name: entry.name.clone(),
            storage_type: "sftp".to_string(),
            endpoint: None,
            bucket: None,
            region: None,
            access_key: None,
            host: Some(host_val),
            port: Some(port_val),
            username: user_val,
            auth_type,
            key_path,
            agent_socket,
            is_favorite: true,
            use_sudo: false,
            bastion: None,
            proxy: None,
        };

        let idx = intermediate_profiles.len();
        alias_to_profile_idx.insert(entry.name.to_lowercase(), idx);
        intermediate_profiles.push((profile, proxy_jump_raw));
    }

    // Second pass: resolve ProxyJump to link directly to bastions.
    let base_profiles: Vec<ConnectionProfile> = intermediate_profiles
        .iter()
        .map(|(p, _)| p.clone())
        .collect();
    let mut final_profiles: Vec<ConnectionProfile> =
        Vec::with_capacity(intermediate_profiles.len());

    for (mut profile, proxy_jump_opt) in intermediate_profiles {
        if let Some(pj) = proxy_jump_opt {
            // Split hops; take the first hop if multiple are configured
            let hops: Vec<&str> = pj
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();
            if hops.len() > 1 {
                warnings.push(format!(
                    "ProxyJump contient plusieurs sauts ('{}') : seul le premier saut est importé pour '{}'.",
                    pj, profile.name
                ));
            }

            if let Some(&first_hop) = hops.first() {
                let (jump_user, jump_host, jump_port) = parse_jump_target(first_hop);

                // 1. Check if first_hop matches another host imported from the same config file
                if let Some(&b_idx) = alias_to_profile_idx.get(&first_hop.to_lowercase()) {
                    let b_prof = &base_profiles[b_idx];
                    profile.bastion = Some(BastionConfig {
                        enabled: true,
                        profile_id: Some(b_prof.id.clone()),
                        host: b_prof.host.clone(),
                        port: b_prof.port,
                        username: b_prof.username.clone(),
                        auth_type: b_prof.auth_type.clone(),
                        key_path: b_prof.key_path.clone(),
                        agent_socket: b_prof.agent_socket.clone(),
                        password: None,
                        passphrase: None,
                    });
                } else if let Some(existing) = existing_profiles.iter().find(|p| {
                    p.name.eq_ignore_ascii_case(first_hop) || p.host.as_deref() == Some(&jump_host)
                }) {
                    // 2. Check if it matches an existing profile in Orbit
                    profile.bastion = Some(BastionConfig {
                        enabled: true,
                        profile_id: Some(existing.id.clone()),
                        host: existing.host.clone(),
                        port: existing.port,
                        username: existing.username.clone(),
                        auth_type: existing.auth_type.clone(),
                        key_path: existing.key_path.clone(),
                        agent_socket: existing.agent_socket.clone(),
                        password: None,
                        passphrase: None,
                    });
                } else {
                    // 3. Inline bastion specification
                    if let Err(err) = validate_ssh_host(&jump_host) {
                        warnings.push(format!(
                            "Le bastion ProxyJump '{}' pour '{}' est invalide : {}",
                            jump_host, profile.name, err
                        ));
                    } else {
                        profile.bastion = Some(BastionConfig {
                            enabled: true,
                            profile_id: None,
                            host: Some(jump_host),
                            port: Some(jump_port.unwrap_or(22)),
                            username: jump_user,
                            auth_type: Some("key".to_string()),
                            key_path: None,
                            agent_socket: None,
                            password: None,
                            passphrase: None,
                        });
                    }
                }
            }
        }

        final_profiles.push(profile);
    }

    SshConfigImportResult {
        profiles: final_profiles,
        warnings,
    }
}

/// Reads and parses an SSH configuration file from the specified path or default `~/.ssh/config`.
pub fn load_and_parse_ssh_config(
    path: Option<&str>,
    existing_profiles: &[ConnectionProfile],
) -> Result<SshConfigImportResult, AppError> {
    let resolved_path = match path {
        Some(p) if !p.trim().is_empty() => {
            agent::expand_home(p.trim(), dirs::home_dir().as_deref())
        }
        _ => match dirs::home_dir() {
            Some(home) => home.join(".ssh").join("config"),
            None => {
                return Err(AppError::Config(
                    "Impossible de déterminer le répertoire personnel de l'utilisateur.".into(),
                ));
            }
        },
    };

    if !resolved_path.exists() {
        return Err(AppError::Config(format!(
            "Le fichier de configuration SSH est introuvable : {}",
            resolved_path.display()
        )));
    }

    let content = std::fs::read_to_string(&resolved_path).map_err(|e| {
        AppError::Io(format!(
            "Erreur lors de la lecture de '{}' : {}",
            resolved_path.display(),
            e
        ))
    })?;

    Ok(parse_ssh_config(
        &content,
        existing_profiles,
        dirs::home_dir().as_deref(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_parse_jump_target_variants() {
        let (u, h, p) = parse_jump_target("bastion.corp.com");
        assert_eq!(u, None);
        assert_eq!(h, "bastion.corp.com");
        assert_eq!(p, None);

        let (u, h, p) = parse_jump_target("jumpuser@bastion.corp.com:2222");
        assert_eq!(u, Some("jumpuser".to_string()));
        assert_eq!(h, "bastion.corp.com");
        assert_eq!(p, Some(2222));

        let (u, h, p) = parse_jump_target("admin@[2001:db8::1]:2200");
        assert_eq!(u, Some("admin".to_string()));
        assert_eq!(h, "2001:db8::1");
        assert_eq!(p, Some(2200));

        let (u, h, p) = parse_jump_target("2001:db8::1");
        assert_eq!(u, None);
        assert_eq!(h, "2001:db8::1");
        assert_eq!(p, None);
    }

    #[test]
    fn test_parse_ssh_config_basic_and_inheritance() {
        let config = r#"
# Global configuration
User defaultuser
Port 2200
IdentityFile ~/.ssh/id_default

Host s1
    HostName 192.168.1.10
    User customuser

Host s2
    HostName s2.domain.org
    Port 2222

Host s3
    IdentityAgent ~/.1password/agent.sock
"#;
        let home = PathBuf::from("/Users/alice");
        let res = parse_ssh_config(config, &[], Some(&home));
        assert_eq!(res.warnings.len(), 0);
        assert_eq!(res.profiles.len(), 3);

        let s1 = &res.profiles[0];
        assert_eq!(s1.name, "s1");
        assert_eq!(s1.host.as_deref(), Some("192.168.1.10"));
        assert_eq!(s1.username.as_deref(), Some("customuser"));
        assert_eq!(s1.port, Some(2200));
        assert_eq!(s1.key_path.as_deref(), Some("/Users/alice/.ssh/id_default"));
        assert_eq!(s1.auth_type.as_deref(), Some("key"));

        let s2 = &res.profiles[1];
        assert_eq!(s2.name, "s2");
        assert_eq!(s2.host.as_deref(), Some("s2.domain.org"));
        assert_eq!(s2.username.as_deref(), Some("defaultuser"));
        assert_eq!(s2.port, Some(2222));

        let s3 = &res.profiles[2];
        assert_eq!(s3.name, "s3");
        assert_eq!(s3.host.as_deref(), Some("s3")); // defaults to name
        assert_eq!(
            s3.agent_socket.as_deref(),
            Some("/Users/alice/.1password/agent.sock")
        );
        assert_eq!(s3.auth_type.as_deref(), Some("agent"));
    }

    #[test]
    fn test_parse_ssh_config_proxy_jump_linking() {
        let config = r#"
Host bastion-prod
    HostName bastion.example.com
    User gatekeeper
    Port 2220
    IdentityFile ~/.ssh/id_bastion

Host web-prod
    HostName 10.0.1.50
    User app
    ProxyJump bastion-prod

Host inline-jump
    HostName 10.0.2.10
    ProxyJump operator@jump.standalone.org:2202
"#;
        let home = PathBuf::from("/Users/alice");
        let res = parse_ssh_config(config, &[], Some(&home));
        assert_eq!(res.profiles.len(), 3);

        let bastion = &res.profiles[0];
        let web = &res.profiles[1];
        let inline = &res.profiles[2];

        assert_eq!(bastion.name, "bastion-prod");
        assert_eq!(web.name, "web-prod");
        assert!(web.bastion.is_some());

        let web_b = web.bastion.as_ref().unwrap();
        assert!(web_b.enabled);
        assert_eq!(web_b.profile_id.as_deref(), Some(bastion.id.as_str()));
        assert_eq!(web_b.host.as_deref(), Some("bastion.example.com"));
        assert_eq!(web_b.username.as_deref(), Some("gatekeeper"));
        assert_eq!(web_b.port, Some(2220));
        assert_eq!(
            web_b.key_path.as_deref(),
            Some("/Users/alice/.ssh/id_bastion")
        );

        let inline_b = inline.bastion.as_ref().unwrap();
        assert!(inline_b.enabled);
        assert_eq!(inline_b.profile_id, None);
        assert_eq!(inline_b.host.as_deref(), Some("jump.standalone.org"));
        assert_eq!(inline_b.username.as_deref(), Some("operator"));
        assert_eq!(inline_b.port, Some(2202));
    }

    #[test]
    fn test_parse_ssh_config_proxy_jump_forward_reference() {
        // web is defined before its bastion
        let config = r#"
Host web-forward
    HostName 10.0.1.99
    ProxyJump bastion-after

Host bastion-after
    HostName bastion.after.org
    User jumpuser
    Port 2222
"#;
        let res = parse_ssh_config(config, &[], None);
        assert_eq!(res.profiles.len(), 2);
        let web = &res.profiles[0];
        let bastion = &res.profiles[1];

        assert_eq!(web.name, "web-forward");
        assert_eq!(bastion.name, "bastion-after");
        let bastion_cfg = web.bastion.as_ref().unwrap();
        assert_eq!(bastion_cfg.profile_id.as_deref(), Some(bastion.id.as_str()));
        assert_eq!(bastion_cfg.host.as_deref(), Some("bastion.after.org"));
        assert_eq!(bastion_cfg.username.as_deref(), Some("jumpuser"));
        assert_eq!(bastion_cfg.port, Some(2222));
    }

    #[test]
    fn test_parse_ssh_config_multi_host_and_wildcard_filtering() {
        let config = r#"
Host *
    User globaluser

Host srv-a srv-b *.internal
    HostName 10.0.0.1
    Port 22
"#;
        let res = parse_ssh_config(config, &[], None);
        // *.internal is wildcard, srv-a and srv-b are concrete
        assert_eq!(res.profiles.len(), 2);
        assert_eq!(res.profiles[0].name, "srv-a");
        assert_eq!(res.profiles[0].username.as_deref(), Some("globaluser"));
        assert_eq!(res.profiles[1].name, "srv-b");
    }

    #[test]
    fn test_parse_ssh_config_rejects_malicious_hosts() {
        let config = r#"
Host good
    HostName 10.0.0.1

Host bad-injection
    HostName "bad;host/injection"

Host bad-chars
    HostName bad[host]
"#;
        let res = parse_ssh_config(config, &[], None);
        assert_eq!(res.profiles.len(), 1);
        assert_eq!(res.profiles[0].name, "good");
        assert_eq!(res.warnings.len(), 2);
        assert!(res.warnings[0].contains("bad-injection"));
        assert!(res.warnings[0].contains("bad;host/injection"));
        assert!(res.warnings[1].contains("bad-chars"));
    }

    #[test]
    fn test_parse_ssh_config_id_no_colons() {
        let config = r#"
Host srv1
    HostName 1.2.3.4
"#;
        let res = parse_ssh_config(config, &[], None);
        assert_eq!(res.profiles.len(), 1);
        assert!(
            !res.profiles[0].id.contains(':'),
            "Profile ID must never contain ':'"
        );
    }
}
