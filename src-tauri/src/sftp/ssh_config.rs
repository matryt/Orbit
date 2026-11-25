//! Parser and importer for OpenSSH `ssh_config` (`~/.ssh/config`).
//!
//! Maps `Host` entries into Orbit SFTP `ConnectionProfile`s:
//! - `HostName` -> `profile.host` (defaults to the concrete Host alias if omitted)
//! - `User` -> `profile.username` (falls back to local user if omitted)
//! - `Port` -> `profile.port` (defaults to 22)
//! - `IdentityFile` -> `profile.key_path` (with `~` expanded to user home)
//! - `IdentityAgent` -> `profile.agent_socket` (`none` disables agent discovery)
//! - `ProxyJump` -> `profile.bastion` (links directly to matching host or inline bastion)

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

#[derive(Debug, Clone)]
enum SectionContext {
    Global,
    Host(Vec<String>),
    IgnoredMatch,
}

#[derive(Debug, Clone)]
struct ConfigSection {
    context: SectionContext,
    directives: DirectiveSet,
}

/// Matches a simple wildcard pattern (* and ?) case-insensitively.
pub fn pattern_matches(pattern: &str, text: &str) -> bool {
    let p_bytes = pattern.as_bytes();
    let t_bytes = text.as_bytes();
    let (mut pi, mut ti) = (0, 0);
    let (mut star_pi, mut star_ti) = (None, 0);

    while ti < t_bytes.len() {
        if pi < p_bytes.len()
            && (p_bytes[pi] == b'?' || p_bytes[pi].eq_ignore_ascii_case(&t_bytes[ti]))
        {
            pi += 1;
            ti += 1;
        } else if pi < p_bytes.len() && p_bytes[pi] == b'*' {
            star_pi = Some(pi);
            pi += 1;
            star_ti = ti;
        } else if let Some(sp) = star_pi {
            pi = sp + 1;
            star_ti += 1;
            ti = star_ti;
        } else {
            return false;
        }
    }

    while pi < p_bytes.len() && p_bytes[pi] == b'*' {
        pi += 1;
    }

    pi == p_bytes.len()
}

/// Evaluates OpenSSH pattern lists including negations (e.g. `*.corp, !bad.corp`).
pub fn matches_ssh_patterns(patterns: &[String], host: &str) -> bool {
    let mut matched = false;
    for pat in patterns {
        if let Some(negated) = pat.strip_prefix('!') {
            if pattern_matches(negated, host) {
                return false;
            }
        } else if pattern_matches(pat, host) {
            matched = true;
        }
    }
    matched
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

fn get_local_username() -> Option<String> {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
}

/// Parses the contents of an SSH configuration file into `ConnectionProfile`s.
pub fn parse_ssh_config(
    content: &str,
    existing_profiles: &[ConnectionProfile],
    home_dir: Option<&Path>,
) -> SshConfigImportResult {
    let mut warnings = Vec::new();
    let mut sections: Vec<ConfigSection> = Vec::new();

    let mut current_context = SectionContext::Global;
    let mut current_directives = DirectiveSet::default();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if let Some((key, value)) = parse_line_directive(trimmed) {
            if key == "host" {
                sections.push(ConfigSection {
                    context: current_context,
                    directives: current_directives,
                });
                current_directives = DirectiveSet::default();

                let patterns: Vec<String> = value
                    .split_whitespace()
                    .map(clean_arg)
                    .filter(|p| !p.is_empty())
                    .collect();

                current_context = SectionContext::Host(patterns);
            } else if key == "match" {
                sections.push(ConfigSection {
                    context: current_context,
                    directives: current_directives,
                });
                current_directives = DirectiveSet::default();
                current_context = SectionContext::IgnoredMatch;
            } else {
                current_directives.set_directive(&key, value);
            }
        }
    }

    sections.push(ConfigSection {
        context: current_context,
        directives: current_directives,
    });

    // Collect all distinct concrete aliases in file order
    let mut concrete_aliases: Vec<String> = Vec::new();
    for sec in &sections {
        if let SectionContext::Host(patterns) = &sec.context {
            for pat in patterns {
                if !pat.contains('*') && !pat.contains('?') && !pat.starts_with('!') {
                    if !concrete_aliases.iter().any(|a| a.eq_ignore_ascii_case(pat)) {
                        concrete_aliases.push(pat.clone());
                    }
                }
            }
        }
    }

    let local_user = get_local_username();

    // First pass: generate base profiles evaluating sections in file order (first match wins)
    let mut alias_to_profile_idx: HashMap<String, usize> = HashMap::new();
    let mut intermediate_profiles: Vec<(ConnectionProfile, Option<String>)> = Vec::new();

    for alias in concrete_aliases {
        let mut merged = DirectiveSet::default();

        for sec in &sections {
            let applies = match &sec.context {
                SectionContext::Global => true,
                SectionContext::Host(patterns) => matches_ssh_patterns(patterns, &alias),
                SectionContext::IgnoredMatch => false,
            };

            if applies {
                if merged.hostname.is_none() {
                    merged.hostname = sec.directives.hostname.clone();
                }
                if merged.user.is_none() {
                    merged.user = sec.directives.user.clone();
                }
                if merged.port.is_none() {
                    merged.port = sec.directives.port;
                }
                if merged.identity_file.is_none() {
                    merged.identity_file = sec.directives.identity_file.clone();
                }
                if merged.proxy_jump.is_none() {
                    merged.proxy_jump = sec.directives.proxy_jump.clone();
                }
                if merged.identity_agent.is_none() {
                    merged.identity_agent = sec.directives.identity_agent.clone();
                }
            }
        }

        let host_val = merged.hostname.unwrap_or_else(|| alias.clone());

        if let Err(err) = validate_ssh_host(&host_val) {
            warnings.push(format!(
                "Hôte '{}' ignoré car l'adresse '{}' est invalide : {}",
                alias, host_val, err
            ));
            continue;
        }

        let user_val = merged.user.or_else(|| local_user.clone());
        let port_val = merged.port.unwrap_or(22);

        let key_path = merged.identity_file.map(|p| {
            agent::expand_home(&p, home_dir)
                .to_string_lossy()
                .into_owned()
        });

        let is_none_agent = merged
            .identity_agent
            .as_deref()
            .map(|a| a.trim().eq_ignore_ascii_case("none"))
            .unwrap_or(false);

        let agent_socket = if is_none_agent {
            Some("none".to_string())
        } else {
            merged.identity_agent.map(|a| {
                agent::expand_home(&a, home_dir)
                    .to_string_lossy()
                    .into_owned()
            })
        };

        let is_pub = key_path
            .as_deref()
            .map(|kp| agent::is_public_key_path(Path::new(kp)))
            .unwrap_or(false);

        let auth_type = if is_none_agent {
            if key_path.is_some() {
                Some("key".to_string())
            } else {
                None
            }
        } else if agent_socket.is_some() || is_pub {
            Some("agent".to_string())
        } else if key_path.is_some() {
            Some("key".to_string())
        } else {
            None
        };

        let proxy_jump_raw = merged.proxy_jump.filter(|pj| {
            !pj.trim().eq_ignore_ascii_case("none") && !pj.trim().eq_ignore_ascii_case("off")
        });

        let safe_id = format!("prof-ssh-{}", fastrand::u64(100_000_000..999_999_999));

        let profile = ConnectionProfile {
            id: safe_id,
            name: alias.clone(),
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
        alias_to_profile_idx.insert(alias.to_lowercase(), idx);
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

                // Look up matching bastion by host or full alias
                let matching_idx = alias_to_profile_idx
                    .get(&first_hop.to_lowercase())
                    .or_else(|| alias_to_profile_idx.get(&jump_host.to_lowercase()));

                if let Some(&b_idx) = matching_idx {
                    let b_prof = &base_profiles[b_idx];
                    profile.bastion = Some(BastionConfig {
                        enabled: true,
                        profile_id: Some(b_prof.id.clone()),
                        host: b_prof.host.clone(),
                        port: jump_port.or(b_prof.port),
                        username: jump_user.or_else(|| b_prof.username.clone()),
                        auth_type: b_prof.auth_type.clone(),
                        key_path: b_prof.key_path.clone(),
                        agent_socket: b_prof.agent_socket.clone(),
                        password: None,
                        passphrase: None,
                    });
                } else if let Some(existing) = existing_profiles.iter().find(|p| {
                    p.name.eq_ignore_ascii_case(first_hop)
                        || p.name.eq_ignore_ascii_case(&jump_host)
                        || p.host.as_deref() == Some(&jump_host)
                }) {
                    profile.bastion = Some(BastionConfig {
                        enabled: true,
                        profile_id: Some(existing.id.clone()),
                        host: existing.host.clone(),
                        port: jump_port.or(existing.port),
                        username: jump_user.or_else(|| existing.username.clone()),
                        auth_type: existing.auth_type.clone(),
                        key_path: existing.key_path.clone(),
                        agent_socket: existing.agent_socket.clone(),
                        password: None,
                        passphrase: None,
                    });
                } else {
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
Host s1
    HostName 192.168.1.10
    User customuser

Host s2
    HostName s2.domain.org
    Port 2222

Host s3
    IdentityAgent ~/.1password/agent.sock

# Global configuration applied as defaults
Host *
    User defaultuser
    Port 2200
    IdentityFile ~/.ssh/id_default
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
        assert_eq!(s3.host.as_deref(), Some("s3"));
        assert_eq!(
            s3.agent_socket.as_deref(),
            Some("/Users/alice/.1password/agent.sock")
        );
        assert_eq!(s3.auth_type.as_deref(), Some("agent"));
    }

    #[test]
    fn test_parse_ssh_config_first_wins_order() {
        let config = r#"
User globaluser

Host app
    User localuser
"#;
        // In OpenSSH, directives before any Host line come first in file order, so globaluser wins!
        let res = parse_ssh_config(config, &[], None);
        assert_eq!(res.profiles.len(), 1);
        assert_eq!(res.profiles[0].username.as_deref(), Some("globaluser"));
    }

    #[test]
    fn test_parse_ssh_config_wildcard_scoping() {
        let config = r#"
Host prod-*
    User deploy

Host dev
    HostName 10.0.0.1
"#;
        let res = parse_ssh_config(config, &[], None);
        assert_eq!(res.profiles.len(), 1);
        assert_eq!(res.profiles[0].name, "dev");
        // dev should not inherit deploy from prod-*
        assert_ne!(res.profiles[0].username.as_deref(), Some("deploy"));
    }

    #[test]
    fn test_parse_ssh_config_identity_agent_none() {
        let config = r#"
Host server-no-agent
    HostName 10.0.0.1
    IdentityAgent none
    IdentityFile ~/.ssh/id_rsa
"#;
        let res = parse_ssh_config(config, &[], None);
        assert_eq!(res.profiles.len(), 1);
        assert_eq!(res.profiles[0].agent_socket.as_deref(), Some("none"));
        assert_eq!(res.profiles[0].auth_type.as_deref(), Some("key"));
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

Host jump-override
    HostName 10.0.3.10
    ProxyJump override_user@bastion-prod:2229
"#;
        let home = PathBuf::from("/Users/alice");
        let res = parse_ssh_config(config, &[], Some(&home));
        assert_eq!(res.profiles.len(), 4);

        let bastion = &res.profiles[0];
        let web = &res.profiles[1];
        let inline = &res.profiles[2];
        let override_p = &res.profiles[3];

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

        let override_b = override_p.bastion.as_ref().unwrap();
        assert!(override_b.enabled);
        assert_eq!(override_b.profile_id.as_deref(), Some(bastion.id.as_str()));
        assert_eq!(override_b.username.as_deref(), Some("override_user"));
        assert_eq!(override_b.port, Some(2229));
    }

    #[test]
    fn test_parse_ssh_config_proxy_jump_forward_reference() {
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
        assert!(res.warnings[1].contains("bad[host]"));
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
