//! SSH agent support: locating the agent socket and selecting identities.
//!
//! A GUI app launched from the Dock/Finder does not inherit the `SSH_AUTH_SOCK` exported in the
//! user's shell rc files, and agents such as 1Password or Secretive are usually wired through
//! `IdentityAgent` in `~/.ssh/config`. We therefore probe several well-known locations instead of
//! relying solely on the environment.

use russh::keys::agent::AgentIdentity;
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::{PrivateKey, PublicKey, load_public_key};
use std::path::{Path, PathBuf};

/// Type-erased agent client, so Unix sockets, Windows named pipes and Pageant share one type.
pub type DynAgentClient = AgentClient<Box<dyn AgentStream + Send + Unpin + 'static>>;

/// Where an agent may be listening.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentEndpoint {
    /// Unix domain socket (macOS / Linux), or a named pipe path on Windows.
    Socket(PathBuf),
    /// PuTTY's Pageant (Windows only).
    #[allow(dead_code)]
    Pageant,
}

/// A candidate endpoint with a human-readable origin, used in connection logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCandidate {
    pub endpoint: AgentEndpoint,
    pub source: &'static str,
}

impl AgentCandidate {
    pub fn describe(&self) -> String {
        match &self.endpoint {
            AgentEndpoint::Socket(p) => format!("{} ({})", self.source, p.display()),
            AgentEndpoint::Pageant => self.source.to_string(),
        }
    }
}

/// An agent connection together with the identities it exposes.
pub struct ConnectedAgent {
    pub client: DynAgentClient,
    pub candidate: AgentCandidate,
    pub keys: Vec<PublicKey>,
}

/// Why no agent identity could be offered to the server. Nothing was sent in any of these cases.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentLookupFailure {
    /// No agent endpoint could be reached.
    NoAgent,
    /// Agents were reachable but none holds a usable key.
    Empty,
    /// Agents hold keys, but not the one designated in the profile.
    NoMatchingKey,
}

impl AgentLookupFailure {
    /// Classifies the outcome of probing every candidate endpoint.
    pub fn from_probe(any_reachable: bool, any_key: bool) -> Self {
        if any_key {
            Self::NoMatchingKey
        } else if any_reachable {
            Self::Empty
        } else {
            Self::NoAgent
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::NoAgent => "Aucun agent SSH joignable",
            Self::Empty => "L'agent SSH ne contient aucune clé",
            Self::NoMatchingKey => "Aucun agent SSH ne détient la clé demandée",
        }
    }

    /// Actionable advice shown in the connection logs.
    pub fn hint(self) -> &'static str {
        match self {
            Self::NoAgent => {
                "Activez l'agent SSH (ssh-agent, 1Password, Secretive…) ou indiquez son socket dans le profil."
            }
            Self::Empty => {
                if cfg!(target_os = "macos") {
                    "Chargez votre clé avec « ssh-add --apple-use-keychain ~/.ssh/<clé> » ou activez l'agent SSH de 1Password / Secretive."
                } else {
                    "Chargez votre clé avec « ssh-add ~/.ssh/<clé> » ou activez l'agent SSH de 1Password."
                }
            }
            Self::NoMatchingKey => {
                "Chargez cette clé dans l'agent (ssh-add) ou vérifiez le fichier indiqué dans le profil."
            }
        }
    }
}

/// Expands a leading `~` against the given home directory.
pub fn expand_home(path: &str, home: Option<&Path>) -> PathBuf {
    if path == "~" {
        if let Some(h) = home {
            return h.to_path_buf();
        }
    } else if let Some(rest) = path.strip_prefix("~/") {
        if let Some(h) = home {
            return h.join(rest);
        }
    }
    PathBuf::from(path)
}

/// Builds the ordered list of agent endpoints to probe.
///
/// Order: explicit socket from the profile, `SSH_AUTH_SOCK`, then well-known third-party agents
/// (1Password, Secretive) and, on Windows, the OpenSSH named pipe and Pageant. Duplicates are
/// removed while preserving the first occurrence. Existence is not checked here so the function
/// stays pure and testable.
pub fn candidate_endpoints(
    explicit: Option<&str>,
    env_sock: Option<&str>,
    home: Option<&Path>,
) -> Vec<AgentCandidate> {
    if let Some(p) = explicit.map(str::trim).filter(|p| !p.is_empty()) {
        if p.eq_ignore_ascii_case("none") {
            return Vec::new();
        }
        return vec![AgentCandidate {
            endpoint: AgentEndpoint::Socket(expand_home(p, home)),
            source: "socket du profil",
        }];
    }

    let mut out: Vec<AgentCandidate> = Vec::new();
    let mut push = |endpoint: AgentEndpoint, source: &'static str| {
        if !out.iter().any(|c| c.endpoint == endpoint) {
            out.push(AgentCandidate { endpoint, source });
        }
    };

    if let Some(p) = env_sock.map(str::trim).filter(|p| !p.is_empty()) {
        push(AgentEndpoint::Socket(PathBuf::from(p)), "SSH_AUTH_SOCK");
    }

    if let Some(h) = home {
        if cfg!(target_os = "macos") {
            push(
                AgentEndpoint::Socket(
                    h.join("Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"),
                ),
                "1Password",
            );
            push(
                AgentEndpoint::Socket(h.join(
                    "Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh",
                )),
                "Secretive",
            );
        } else if cfg!(unix) {
            push(
                AgentEndpoint::Socket(h.join(".1password/agent.sock")),
                "1Password",
            );
        }
    }

    if cfg!(windows) {
        // Shared by the Windows OpenSSH agent service and 1Password for Windows.
        push(
            AgentEndpoint::Socket(PathBuf::from(r"\\.\pipe\openssh-ssh-agent")),
            "Agent OpenSSH Windows",
        );
        push(AgentEndpoint::Pageant, "Pageant");
    }

    out
}

/// Candidates for the current process environment.
pub fn default_candidates(explicit: Option<&str>) -> Vec<AgentCandidate> {
    let env_sock = std::env::var("SSH_AUTH_SOCK").ok();
    let home = dirs::home_dir();
    candidate_endpoints(explicit, env_sock.as_deref(), home.as_deref())
}

async fn open_endpoint(endpoint: &AgentEndpoint) -> Result<DynAgentClient, String> {
    match endpoint {
        AgentEndpoint::Socket(path) => {
            #[cfg(unix)]
            {
                AgentClient::connect_uds(path)
                    .await
                    .map(AgentClient::dynamic)
                    .map_err(|e| e.to_string())
            }
            #[cfg(windows)]
            {
                AgentClient::connect_named_pipe(path.as_os_str())
                    .await
                    .map(AgentClient::dynamic)
                    .map_err(|e| e.to_string())
            }
            #[cfg(not(any(unix, windows)))]
            {
                let _ = path;
                Err("Agent SSH non supporté sur cette plateforme".into())
            }
        }
        AgentEndpoint::Pageant => {
            #[cfg(windows)]
            {
                AgentClient::connect_pageant()
                    .await
                    .map(AgentClient::dynamic)
                    .map_err(|e| e.to_string())
            }
            #[cfg(not(windows))]
            {
                Err("Pageant n'est disponible que sous Windows".into())
            }
        }
    }
}

/// Extracts the plain public keys from agent identities.
///
/// Certificates are skipped for now: authenticating with them requires a different flow.
pub fn plain_keys(identities: Vec<AgentIdentity>) -> Vec<PublicKey> {
    identities
        .into_iter()
        .filter_map(|id| match id {
            AgentIdentity::PublicKey { key, .. } => Some(key),
            AgentIdentity::Certificate { .. } => None,
        })
        .collect()
}

/// Keeps only the agent keys matching `wanted` (compared on key material, ignoring comments).
/// Without a filter every key is kept, in agent order.
pub fn select_keys(keys: Vec<PublicKey>, wanted: Option<&PublicKey>) -> Vec<PublicKey> {
    match wanted {
        Some(w) => keys
            .into_iter()
            .filter(|k| k.key_data() == w.key_data())
            .collect(),
        None => keys,
    }
}

/// Connects to the first reachable agent that holds a usable identity.
///
/// When `wanted` is set, only an agent holding that exact key qualifies. This lets an empty
/// system agent (always present on macOS through launchd) be skipped in favour of 1Password or
/// Secretive. `logs` receives one line per probed endpoint.
pub async fn connect_agent(
    candidates: &[AgentCandidate],
    wanted: Option<&PublicKey>,
    logs: &mut Vec<String>,
) -> Result<ConnectedAgent, AgentLookupFailure> {
    let mut any_reachable = false;
    let mut any_key = false;
    for candidate in candidates {
        if let AgentEndpoint::Socket(p) = &candidate.endpoint {
            // Named pipes cannot be stat'ed reliably; only pre-check real filesystem sockets.
            if cfg!(unix) && !p.exists() {
                continue;
            }
        }

        let mut client = match open_endpoint(&candidate.endpoint).await {
            Ok(c) => c,
            Err(e) => {
                logs.push(format!("Agent {} injoignable : {e}", candidate.describe()));
                continue;
            }
        };

        let identities = match tokio::time::timeout(
            std::time::Duration::from_secs(3),
            client.request_identities(),
        )
        .await
        {
            Ok(Ok(ids)) => ids,
            Ok(Err(e)) => {
                logs.push(format!(
                    "Agent {} : lecture des identités impossible ({e})",
                    candidate.describe()
                ));
                continue;
            }
            Err(_) => {
                logs.push(format!(
                    "Agent {} : délai d'attente dépassé (3s) lors de la lecture des identités",
                    candidate.describe()
                ));
                continue;
            }
        };

        any_reachable = true;
        let total = identities.len();
        let all_keys = plain_keys(identities);
        any_key |= !all_keys.is_empty();
        let keys = select_keys(all_keys, wanted);
        if keys.is_empty() {
            logs.push(if wanted.is_some() {
                format!(
                    "Agent {} : {total} identité(s), aucune ne correspond à la clé demandée",
                    candidate.describe()
                )
            } else {
                format!(
                    "Agent {} : aucune clé utilisable ({total} identité(s))",
                    candidate.describe()
                )
            });
            continue;
        }

        logs.push(format!(
            "Agent {} : {} clé(s) utilisable(s)",
            candidate.describe(),
            keys.len()
        ));
        return Ok(ConnectedAgent {
            client,
            candidate: candidate.clone(),
            keys,
        });
    }
    Err(AgentLookupFailure::from_probe(any_reachable, any_key))
}

/// Loads the public key used to pick an agent identity for `key_path`.
///
/// Accepts either a `.pub` file (the setup recommended by 1Password) or a private key path,
/// in which case the sibling `<path>.pub` is used. Returns `None` when no public key is available.
pub fn load_wanted_public_key(key_path: &Path) -> Option<PublicKey> {
    if is_public_key_path(key_path) {
        return load_public_key(key_path).ok();
    }
    let mut pub_path = key_path.as_os_str().to_owned();
    pub_path.push(".pub");
    if let Ok(k) = load_public_key(PathBuf::from(pub_path)) {
        return Some(k);
    }
    // The OpenSSH private key format stores the public half in clear, even when the private
    // part is encrypted, so no passphrase is needed here.
    let contents = std::fs::read_to_string(key_path).ok()?;
    PrivateKey::from_openssh(contents.trim())
        .ok()
        .map(|k| k.public_key().clone())
}

/// Whether the path designates a public key file rather than a private key.
pub fn is_public_key_path(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("pub"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::parse_public_key_base64;

    const KEY_A: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIOibTcbar67B0XnkYT74QVR94FSGIpz3ZrtYfaV+iFqu";
    const KEY_B: &str = "AAAAC3NzaC1lZDI1NTE5AAAAINWbB08YK7lWG+kdi7vgy3/dSL60cnyaAaXGzAhLX5KV";

    fn key(b64: &str) -> PublicKey {
        parse_public_key_base64(b64).expect("valid test key")
    }

    #[test]
    fn test_candidate_order_and_dedup() {
        let home = PathBuf::from("/home/dev");
        let cands = candidate_endpoints(
            Some("~/agent.sock"),
            Some("/home/dev/agent.sock"),
            Some(&home),
        );
        // The explicit socket is exclusive and prevents probing other endpoints
        assert_eq!(cands.len(), 1);
        assert_eq!(
            cands[0].endpoint,
            AgentEndpoint::Socket(PathBuf::from("/home/dev/agent.sock"))
        );
        assert_eq!(cands[0].source, "socket du profil");
    }

    #[test]
    fn test_candidate_none_disables_agent() {
        let home = PathBuf::from("/home/dev");
        let cands = candidate_endpoints(Some("none"), Some("/tmp/agent.sock"), Some(&home));
        assert_eq!(cands.len(), 0);
    }

    #[test]
    fn test_candidate_env_before_well_known() {
        let home = PathBuf::from("/home/dev");
        let cands = candidate_endpoints(None, Some("/tmp/ssh-xyz/agent.1"), Some(&home));
        assert_eq!(cands[0].source, "SSH_AUTH_SOCK");
        if cfg!(unix) {
            assert!(cands.iter().any(|c| c.source == "1Password"));
        }
    }

    #[test]
    fn test_candidate_ignores_blank_values() {
        let cands = candidate_endpoints(Some("  "), Some(""), None);
        assert!(
            cands
                .iter()
                .all(|c| c.source != "socket du profil" && c.source != "SSH_AUTH_SOCK")
        );
    }

    #[test]
    fn test_lookup_failure_classification() {
        assert_eq!(
            AgentLookupFailure::from_probe(false, false),
            AgentLookupFailure::NoAgent
        );
        assert_eq!(
            AgentLookupFailure::from_probe(true, false),
            AgentLookupFailure::Empty
        );
        assert_eq!(
            AgentLookupFailure::from_probe(true, true),
            AgentLookupFailure::NoMatchingKey
        );
    }

    #[tokio::test]
    async fn test_connect_agent_without_reachable_endpoint() {
        let cands = vec![AgentCandidate {
            endpoint: AgentEndpoint::Socket(PathBuf::from("/nonexistent/orbit/agent.sock")),
            source: "test",
        }];
        let mut logs = Vec::new();
        let res = connect_agent(&cands, None, &mut logs).await;
        assert!(matches!(res, Err(AgentLookupFailure::NoAgent)));
    }

    #[test]
    fn test_expand_home() {
        let home = PathBuf::from("/Users/me");
        assert_eq!(
            expand_home("~/.ssh/agent", Some(&home)),
            PathBuf::from("/Users/me/.ssh/agent")
        );
        assert_eq!(expand_home("~", Some(&home)), home);
        assert_eq!(
            expand_home("/abs/sock", Some(&home)),
            PathBuf::from("/abs/sock")
        );
        assert_eq!(expand_home("~/x", None), PathBuf::from("~/x"));
    }

    #[test]
    fn test_select_keys_filters_on_key_material() {
        let keys = vec![key(KEY_A), key(KEY_B)];
        let mut wanted = key(KEY_B);
        wanted.set_comment("different comment");
        let selected = select_keys(keys.clone(), Some(&wanted));
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].key_data(), key(KEY_B).key_data());

        assert_eq!(select_keys(keys, None).len(), 2);
    }

    #[test]
    fn test_select_keys_no_match() {
        assert!(select_keys(vec![key(KEY_A)], Some(&key(KEY_B))).is_empty());
    }

    #[test]
    fn test_plain_keys_skips_certificates() {
        let ids = vec![AgentIdentity::from(key(KEY_A))];
        assert_eq!(plain_keys(ids).len(), 1);
    }

    #[test]
    fn test_is_public_key_path() {
        assert!(is_public_key_path(Path::new("/x/id_ed25519.pub")));
        assert!(is_public_key_path(Path::new("/x/KEY.PUB")));
        assert!(!is_public_key_path(Path::new("/x/id_ed25519")));
    }

    #[test]
    fn test_load_wanted_public_key_from_private_path() {
        let dir = std::env::temp_dir().join(format!("orbit-agent-test-{}", fastrand::u64(..)));
        std::fs::create_dir_all(&dir).unwrap();
        let priv_path = dir.join("id_test");
        std::fs::write(
            dir.join("id_test.pub"),
            format!("ssh-ed25519 {KEY_A} test@orbit\n"),
        )
        .unwrap();

        let loaded = load_wanted_public_key(&priv_path).expect("sibling .pub is read");
        assert_eq!(loaded.key_data(), key(KEY_A).key_data());

        let direct = load_wanted_public_key(&dir.join("id_test.pub")).expect(".pub is read");
        assert_eq!(direct.key_data(), key(KEY_A).key_data());

        assert!(load_wanted_public_key(&dir.join("missing")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
