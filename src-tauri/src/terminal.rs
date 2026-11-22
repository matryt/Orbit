use std::path::{Path, PathBuf};
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

/// Construit la spécification Jump Host / Bastion pour OpenSSH (`-J [user@]host[:port]`).
pub fn build_bastion_spec(
    bastion: &BastionConfig,
    all_profiles: &[ConnectionProfile],
) -> Option<String> {
    if !bastion.enabled {
        return None;
    }

    let b_prof = bastion
        .profile_id
        .as_ref()
        .and_then(|id| all_profiles.iter().find(|p| p.id == *id));

    let host = bastion
        .host
        .as_deref()
        .or_else(|| b_prof.and_then(|p| p.host.as_deref()))?;

    let host_trimmed = host.trim();
    if host_trimmed.is_empty() {
        return None;
    }

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

    let mut spec = String::new();
    if let Some(u) = user {
        spec.push_str(u);
        spec.push('@');
    }
    spec.push_str(host_trimmed);
    if port != 22 && port != 0 {
        spec.push(':');
        spec.push_str(&port.to_string());
    }

    Some(spec)
}

/// Construit la liste des arguments pour le binaire OpenSSH `ssh`.
pub fn build_ssh_args(
    profile: &ConnectionProfile,
    all_profiles: &[ConnectionProfile],
    remote_path: Option<&str>,
) -> Result<Vec<String>, String> {
    if profile.storage_type != "sftp" {
        return Err("L'ouverture dans un terminal n'est supportée que pour les profils SFTP.".to_string());
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
        if let Some(spec) = build_bastion_spec(bastion, all_profiles) {
            args.push("-J".to_string());
            args.push(spec);
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

    if let Some(path) = remote_path {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            args.push("-t".to_string());
            let escaped_path = escape_single_quotes(trimmed);
            args.push(format!("cd '{}' && exec $SHELL -l", escaped_path));
        }
    }

    Ok(args)
}

/// Formate la commande SSH complète sous forme de chaîne pour les shells ou terminaux.
pub fn format_ssh_command_line(args: &[String]) -> String {
    let mut parts = vec!["ssh".to_string()];
    for arg in args {
        if arg.contains(' ')
            || arg.contains('\t')
            || arg.contains('\'')
            || arg.contains('"')
            || arg.contains('$')
        {
            let escaped = arg
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('$', "\\$");
            parts.push(format!("\"{escaped}\""));
        } else {
            parts.push(arg.clone());
        }
    }
    parts.join(" ")
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
    let ssh_cmd = format_ssh_command_line(&ssh_args);

    #[cfg(target_os = "macos")]
    {
        launch_macos(&ssh_cmd, &ssh_args)
    }

    #[cfg(target_os = "windows")]
    {
        launch_windows(profile, &ssh_cmd, &ssh_args)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        launch_linux(&ssh_cmd, &ssh_args)
    }
}

// ---------------------------------------------------------------------------
// Adaptateur macOS
// ---------------------------------------------------------------------------
#[cfg(target_os = "macos")]
fn launch_macos(ssh_cmd: &str, _ssh_args: &[String]) -> Result<(), String> {
    let iterm_available = Path::new("/Applications/iTerm.app").exists()
        || dirs::home_dir()
            .map(|h| h.join("Applications/iTerm.app").exists())
            .unwrap_or(false);

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
        {ssh_cmd}\n\
        STATUS=$?\n\
        if [ $STATUS -ne 0 ]; then\n\
            echo \"\"\n\
            echo \"La commande SSH s'est terminée avec le code $STATUS.\"\n\
            echo \"Appuyez sur Entrée pour fermer cette fenêtre...\"\n\
            read -r _\n\
        fi\n"
    );

    std::fs::write(&script_path, &script_content)
        .map_err(|e| format!("Impossible de créer le script temporaire pour Terminal: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o700));
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
    let escaped_cmd = ssh_cmd.replace('\\', "\\\\").replace('"', "\\\"");
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
    ssh_cmd: &str,
    ssh_args: &[String],
) -> Result<(), String> {
    // Priorité 1 : Windows Terminal (`wt.exe -d . ssh ...`)
    let wt_found = find_in_path("wt").is_some()
        || dirs::data_local_dir()
            .map(|d| d.join("Microsoft\\WindowsApps\\wt.exe").exists())
            .unwrap_or(false);

    if wt_found {
        let mut cmd = Command::new("wt.exe");
        cmd.args(["-d", "."]).arg("ssh").args(ssh_args);
        if let Ok(_) = cmd.spawn() {
            return Ok(());
        }
    }

    // Priorité 2 : PuTTY (`putty.exe -ssh -P <port> -l <user> -i <key> <host>`)
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

        if let Ok(_) = cmd.spawn() {
            return Ok(());
        }
    }

    // Fallback 1 : PowerShell
    if let Ok(_) = Command::new("powershell.exe")
        .args(["-NoExit", "-Command", ssh_cmd])
        .spawn()
    {
        return Ok(());
    }

    // Fallback 2 : cmd.exe
    Command::new("cmd.exe")
        .args(["/c", "start", "cmd.exe", "/k", ssh_cmd])
        .spawn()
        .map_err(|e| format!("Échec du lancement du terminal sous Windows: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Adaptateur Linux & Unix
// ---------------------------------------------------------------------------
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn launch_linux(_ssh_cmd: &str, ssh_args: &[String]) -> Result<(), String> {
    // 1. Variable $TERMINAL si définie
    if let Ok(term) = std::env::var("TERMINAL") {
        let trimmed = term.trim();
        if !trimmed.is_empty() {
            if let Ok(_) = Command::new(trimmed).arg("-e").arg("ssh").args(ssh_args).spawn() {
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
                "kitty" => {
                    cmd.arg("ssh").args(ssh_args);
                }
                _ => {
                    cmd.arg("-e").arg("ssh").args(ssh_args);
                }
            }

            if let Ok(_) = cmd.spawn() {
                return Ok(());
            }
        }
    }

    Err("Aucun émulateur de terminal pris en charge n'a été détecté (x-terminal-emulator, gnome-terminal, konsole, kitty, alacritty, xterm).".to_string())
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
    fn test_build_ssh_args_simple() {
        let prof = create_dummy_profile("p1", "sftp", Some("example.com"), Some(22), Some("ubuntu"), None);
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
    fn test_build_ssh_args_with_remote_path() {
        let prof = create_dummy_profile("p3", "sftp", Some("server.org"), Some(22), Some("deploy"), None);
        let args = build_ssh_args(&prof, &[], Some("/var/www/my app's folder")).unwrap();
        assert_eq!(
            args,
            vec![
                "-p",
                "22",
                "deploy@server.org",
                "-t",
                "cd '/var/www/my app'\\''s folder' && exec $SHELL -l"
            ]
        );
    }

    #[test]
    fn test_build_ssh_args_inline_bastion() {
        let mut prof = create_dummy_profile("p4", "sftp", Some("target.internal"), Some(22), Some("root"), None);
        prof.bastion = Some(BastionConfig {
            enabled: true,
            profile_id: None,
            host: Some("jump.example.com".to_string()),
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
                "bastionuser@jump.example.com:2200",
                "root@target.internal"
            ]
        );
    }

    #[test]
    fn test_build_ssh_args_referenced_bastion_profile() {
        let bastion_prof = create_dummy_profile(
            "bastion-profile-id",
            "sftp",
            Some("jump.company.com"),
            Some(22),
            Some("secops"),
            None,
        );

        let mut prof = create_dummy_profile("p5", "sftp", Some("prod.db"), Some(22), Some("dba"), None);
        prof.bastion = Some(BastionConfig {
            enabled: true,
            profile_id: Some("bastion-profile-id".to_string()),
            host: None,
            port: None,
            username: None,
            auth_type: None,
            key_path: None,
            password: None,
            passphrase: None,
        });

        let args = build_ssh_args(&prof, &[bastion_prof], None).unwrap();
        assert_eq!(
            args,
            vec![
                "-p",
                "22",
                "-J",
                "secops@jump.company.com",
                "dba@prod.db"
            ]
        );
    }

    #[test]
    fn test_build_ssh_args_rejects_s3() {
        let prof = create_dummy_profile("p6", "s3", Some("bucket"), None, None, None);
        let err = build_ssh_args(&prof, &[], None).unwrap_err();
        assert!(err.contains("SFTP"));
    }

    #[test]
    fn test_format_ssh_command_line() {
        let args = vec![
            "-p".to_string(),
            "22".to_string(),
            "-J".to_string(),
            "jump.com".to_string(),
            "user@target".to_string(),
            "-t".to_string(),
            "cd '/var/log' && exec $SHELL -l".to_string(),
        ];
        let cmd = format_ssh_command_line(&args);
        assert_eq!(
            cmd,
            "ssh -p 22 -J jump.com user@target -t \"cd '/var/log' && exec \\$SHELL -l\""
        );
    }
}
