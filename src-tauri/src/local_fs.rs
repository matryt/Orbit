use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::models::FileEntry;

pub fn resolve_local_path(input_path: Option<&str>) -> Result<PathBuf, AppError> {
    let raw = match input_path {
        Some(s) if !s.trim().is_empty() => s.trim(),
        _ => {
            return dirs::home_dir().ok_or_else(|| {
                AppError::NotFound("Répertoire personnel de l'utilisateur introuvable".into())
            });
        }
    };

    let path_buf = if raw == "~" {
        dirs::home_dir().ok_or_else(|| {
            AppError::NotFound("Répertoire personnel de l'utilisateur introuvable".into())
        })?
    } else if let Some(stripped) = raw.strip_prefix("~/") {
        let home = dirs::home_dir().ok_or_else(|| {
            AppError::NotFound("Répertoire personnel de l'utilisateur introuvable".into())
        })?;
        home.join(stripped)
    } else {
        PathBuf::from(raw)
    };

    match std::fs::metadata(&path_buf) {
        Ok(_) => path_buf.canonicalize().map_err(AppError::from),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            Err(AppError::PermissionDenied(format!(
                "Permission denied: cannot access '{}'",
                path_buf.display()
            )))
        }
        Err(_) => Err(AppError::NotFound(format!(
            "Le dossier local '{}' n'existe pas",
            path_buf.display()
        ))),
    }
}

pub fn format_unix_mode(mode: u32, is_dir: bool) -> String {
    let prefix = if is_dir { 'd' } else { '-' };
    let r_usr = if mode & 0o400 != 0 { 'r' } else { '-' };
    let w_usr = if mode & 0o200 != 0 { 'w' } else { '-' };
    let x_usr = if mode & 0o4000 != 0 {
        if mode & 0o100 != 0 { 's' } else { 'S' }
    } else if mode & 0o100 != 0 {
        'x'
    } else {
        '-'
    };
    let r_grp = if mode & 0o040 != 0 { 'r' } else { '-' };
    let w_grp = if mode & 0o020 != 0 { 'w' } else { '-' };
    let x_grp = if mode & 0o2000 != 0 {
        if mode & 0o010 != 0 { 's' } else { 'S' }
    } else if mode & 0o010 != 0 {
        'x'
    } else {
        '-'
    };
    let r_oth = if mode & 0o004 != 0 { 'r' } else { '-' };
    let w_oth = if mode & 0o002 != 0 { 'w' } else { '-' };
    let x_oth = if mode & 0o1000 != 0 {
        if mode & 0o001 != 0 { 't' } else { 'T' }
    } else if mode & 0o001 != 0 {
        'x'
    } else {
        '-'
    };
    format!(
        "{}{}{}{}{}{}{}{}{}{}",
        prefix, r_usr, w_usr, x_usr, r_grp, w_grp, x_grp, r_oth, w_oth, x_oth
    )
}

#[cfg(unix)]
fn resolve_uid(uid: u32, cache: &mut std::collections::HashMap<u32, String>) -> String {
    if let Some(name) = cache.get(&uid) {
        return name.clone();
    }
    let name = unsafe {
        let mut pwd = std::mem::zeroed::<libc::passwd>();
        let mut result = std::ptr::null_mut();
        let mut buf = vec![0u8; 1024];
        let res = libc::getpwuid_r(
            uid,
            &mut pwd,
            buf.as_mut_ptr() as *mut libc::c_char,
            buf.len(),
            &mut result,
        );
        if res == 0 && !result.is_null() && !pwd.pw_name.is_null() {
            std::ffi::CStr::from_ptr(pwd.pw_name)
                .to_string_lossy()
                .to_string()
        } else {
            uid.to_string()
        }
    };
    cache.insert(uid, name.clone());
    name
}

#[cfg(unix)]
fn resolve_gid(gid: u32, cache: &mut std::collections::HashMap<u32, String>) -> String {
    if let Some(name) = cache.get(&gid) {
        return name.clone();
    }
    let name = unsafe {
        let mut grp = std::mem::zeroed::<libc::group>();
        let mut result = std::ptr::null_mut();
        let mut buf = vec![0u8; 1024];
        let res = libc::getgrgid_r(
            gid,
            &mut grp,
            buf.as_mut_ptr() as *mut libc::c_char,
            buf.len(),
            &mut result,
        );
        if res == 0 && !result.is_null() && !grp.gr_name.is_null() {
            std::ffi::CStr::from_ptr(grp.gr_name)
                .to_string_lossy()
                .to_string()
        } else {
            gid.to_string()
        }
    };
    cache.insert(gid, name.clone());
    name
}

pub fn list_local_directory(
    input_path: Option<&str>,
) -> Result<(String, Vec<FileEntry>), AppError> {
    let target = resolve_local_path(input_path)?;
    if !target.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "Le chemin '{}' n'est pas un répertoire",
            target.display()
        )));
    }

    let read_dir = std::fs::read_dir(&target).map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            AppError::PermissionDenied(format!(
                "Permission denied: cannot access '{}'",
                target.display()
            ))
        } else {
            AppError::from(e)
        }
    })?;
    let mut entries = Vec::new();

    #[cfg(unix)]
    let mut uid_cache = std::collections::HashMap::<u32, String>::new();
    #[cfg(unix)]
    let mut gid_cache = std::collections::HashMap::<u32, String>::new();

    for item in read_dir {
        let entry = match item {
            Ok(e) => e,
            Err(_) => continue,
        };

        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name == "." || file_name == ".." || file_name.is_empty() {
            continue;
        }

        let full_path = entry.path();
        let path_str = full_path.to_string_lossy().to_string();

        let symlink_meta = match std::fs::symlink_metadata(&full_path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_symlink = symlink_meta.file_type().is_symlink();
        let is_dir = if is_symlink {
            std::fs::metadata(&full_path)
                .map(|m| m.is_dir())
                .unwrap_or(false)
        } else {
            symlink_meta.is_dir()
        };
        let size = if is_dir { 0 } else { symlink_meta.len() };

        let modified_at = symlink_meta
            .modified()
            .ok()
            .map(|t| {
                let datetime: chrono::DateTime<chrono::Utc> = t.into();
                datetime.to_rfc3339()
            })
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

        #[cfg(unix)]
        let (permissions, owner, group) = {
            use std::os::unix::fs::MetadataExt;
            use std::os::unix::fs::PermissionsExt;
            let mode = symlink_meta.permissions().mode();
            let perm_str = format_unix_mode(mode, is_dir);
            let uid = symlink_meta.uid();
            let gid = symlink_meta.gid();
            let owner_name = resolve_uid(uid, &mut uid_cache);
            let group_name = resolve_gid(gid, &mut gid_cache);
            (Some(perm_str), Some(owner_name), Some(group_name))
        };

        #[cfg(not(unix))]
        let (permissions, owner, group) = {
            let perm_str = if symlink_meta.permissions().readonly() {
                if is_dir { "dr-xr-xr-x" } else { "-r--r--r--" }
            } else {
                if is_dir { "drwxr-xr-x" } else { "-rw-rw-rw-" }
            };
            (Some(perm_str.to_string()), None, None)
        };

        entries.push(FileEntry {
            name: file_name,
            path: path_str,
            is_dir,
            is_symlink,
            size,
            modified_at,
            permissions,
            owner,
            group,
            etag: None,
        });
    }

    let canonical_path = target.to_string_lossy().to_string();
    Ok((canonical_path, entries))
}

pub fn read_local_preview(path: &str, max_bytes: usize) -> Result<Vec<u8>, AppError> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(AppError::NotFound(format!("Fichier introuvable: {path}")));
    }
    if p.is_dir() {
        return Err(AppError::InvalidPath(
            "Impossible d'afficher un dossier comme fichier".into(),
        ));
    }

    let file = File::open(p).map_err(AppError::from)?;
    let mut buffer = Vec::new();
    file.take(max_bytes as u64)
        .read_to_end(&mut buffer)
        .map_err(AppError::from)?;

    Ok(buffer)
}

pub fn create_local_directory(path: &str) -> Result<(), AppError> {
    let p = Path::new(path);
    std::fs::create_dir_all(p).map_err(AppError::from)
}

pub fn delete_local_item(path: &str) -> Result<(), AppError> {
    let p = Path::new(path);
    let meta = std::fs::symlink_metadata(p).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound(format!("Fichier introuvable: {path}"))
        } else {
            AppError::from(e)
        }
    })?;

    if meta.is_dir() {
        std::fs::remove_dir_all(p).map_err(AppError::from)
    } else {
        std::fs::remove_file(p).map_err(AppError::from)
    }
}

pub fn rename_local_item(old_path: &str, new_path: &str) -> Result<(), AppError> {
    let old_p = Path::new(old_path);
    let new_p = Path::new(new_path);

    if std::fs::symlink_metadata(old_p).is_err() {
        return Err(AppError::NotFound(format!(
            "Fichier source introuvable: {old_path}"
        )));
    }

    if std::fs::symlink_metadata(new_p).is_ok() {
        return Err(AppError::InvalidPath(format!(
            "Un élément portant le nom '{}' existe déjà",
            new_p.display()
        )));
    }

    std::fs::rename(old_p, new_p).map_err(AppError::from)
}

#[cfg(unix)]
pub fn resolve_user_to_uid(user: &str) -> Result<u32, AppError> {
    let trimmed = user.trim();
    if let Ok(uid) = trimmed.parse::<u32>() {
        return Ok(uid);
    }
    let c_user = std::ffi::CString::new(trimmed)
        .map_err(|_| AppError::InvalidPath("Nom d'utilisateur invalide".into()))?;
    unsafe {
        let mut pwd = std::mem::zeroed::<libc::passwd>();
        let mut result = std::ptr::null_mut();
        let mut buf_size = 1024;
        loop {
            let mut buf = vec![0u8; buf_size];
            let res = libc::getpwnam_r(
                c_user.as_ptr(),
                &mut pwd,
                buf.as_mut_ptr() as *mut libc::c_char,
                buf.len(),
                &mut result,
            );
            if res == libc::ERANGE && buf_size < 1024 * 64 {
                buf_size *= 2;
                continue;
            }
            if res == 0 && !result.is_null() && !pwd.pw_name.is_null() {
                return Ok(pwd.pw_uid);
            } else {
                return Err(AppError::NotFound(format!(
                    "Utilisateur local '{trimmed}' introuvable"
                )));
            }
        }
    }
}

#[cfg(unix)]
pub fn resolve_group_to_gid(group: &str) -> Result<u32, AppError> {
    let trimmed = group.trim();
    if let Ok(gid) = trimmed.parse::<u32>() {
        return Ok(gid);
    }
    let c_group = std::ffi::CString::new(trimmed)
        .map_err(|_| AppError::InvalidPath("Nom de groupe invalide".into()))?;
    unsafe {
        let mut grp = std::mem::zeroed::<libc::group>();
        let mut result = std::ptr::null_mut();
        let mut buf_size = 1024;
        loop {
            let mut buf = vec![0u8; buf_size];
            let res = libc::getgrnam_r(
                c_group.as_ptr(),
                &mut grp,
                buf.as_mut_ptr() as *mut libc::c_char,
                buf.len(),
                &mut result,
            );
            if res == libc::ERANGE && buf_size < 1024 * 64 {
                buf_size *= 2;
                continue;
            }
            if res == 0 && !result.is_null() && !grp.gr_name.is_null() {
                return Ok(grp.gr_gid);
            } else {
                return Err(AppError::NotFound(format!(
                    "Groupe local '{trimmed}' introuvable"
                )));
            }
        }
    }
}

pub fn set_local_permissions(
    path: &str,
    mode: Option<u32>,
    owner: Option<&str>,
    group: Option<&str>,
    recursive: bool,
) -> Result<(), AppError> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(AppError::NotFound(format!("Fichier introuvable: {path}")));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let resolved_uid = if let Some(user_str) = owner {
            let trimmed = user_str.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(resolve_user_to_uid(trimmed)?)
            }
        } else {
            None
        };

        let resolved_gid = if let Some(group_str) = group {
            let trimmed = group_str.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(resolve_group_to_gid(trimmed)?)
            }
        } else {
            None
        };

        if recursive && p.is_dir() {
            let walk_res = crate::walk::walk_local(p)?;
            let mut sorted_entries = walk_res.entries;
            sorted_entries.sort_by_key(|a| std::cmp::Reverse(a.relative_path.len()));

            for entry in sorted_entries {
                if entry.is_symlink {
                    continue;
                }
                let child = p.join(&entry.relative_path);
                if let Ok(meta) = child.symlink_metadata() {
                    if meta.file_type().is_symlink() {
                        continue;
                    }
                }
                if let Some(m) = mode {
                    std::fs::set_permissions(&child, std::fs::Permissions::from_mode(m)).map_err(
                        |e| {
                            AppError::Io(format!(
                                "Échec de modification des permissions de '{}': {e}",
                                child.display()
                            ))
                        },
                    )?;
                }
                if resolved_uid.is_some() || resolved_gid.is_some() {
                    std::os::unix::fs::chown(&child, resolved_uid, resolved_gid).map_err(|e| {
                        if e.kind() == std::io::ErrorKind::PermissionDenied {
                            AppError::PermissionDenied(format!(
                                "Permission refusée pour changer le propriétaire de '{}' (privilèges administrateur / sudo requis)",
                                child.display()
                            ))
                        } else {
                            AppError::from(e)
                        }
                    })?;
                }
            }
        }

        if let Some(m) = mode {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(m))
                .map_err(AppError::from)?;
        }
        if resolved_uid.is_some() || resolved_gid.is_some() {
            std::os::unix::fs::chown(p, resolved_uid, resolved_gid).map_err(|e| {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    AppError::PermissionDenied(format!(
                        "Permission refusée pour changer le propriétaire de '{}' (privilèges administrateur / sudo requis)",
                        p.display()
                    ))
                } else {
                    AppError::from(e)
                }
            })?;
        }
        Ok(())
    }

    #[cfg(not(unix))]
    {
        let _ = (mode, owner, group, recursive);
        Err(AppError::Config(
            "La modification des permissions et propriétaires POSIX n'est pas supportée sur ce système".into(),
        ))
    }
}

#[cfg(unix)]
pub fn list_local_identities() -> (Vec<String>, Vec<String>) {
    let mut users = Vec::new();
    let mut groups = Vec::new();

    if let Ok(passwd) = std::fs::read_to_string("/etc/passwd") {
        let parsed = crate::sftp::client::parse_passwd(&passwd, "");
        users.extend(parsed.users.into_values());
    }
    if let Ok(group) = std::fs::read_to_string("/etc/group") {
        let parsed = crate::sftp::client::parse_group(&group);
        groups.extend(parsed.into_values());
    }

    users.sort();
    users.dedup();
    groups.sort();
    groups.dedup();
    (users, groups)
}

#[cfg(not(unix))]
pub fn list_local_identities() -> (Vec<String>, Vec<String>) {
    (Vec::new(), Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(1);

    fn create_test_dir() -> PathBuf {
        let count = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "orbit_test_{}_{}_{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
            count
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn test_resolve_local_path_home() {
        let home = resolve_local_path(None).unwrap();
        assert!(home.exists());
        assert!(home.is_dir());
    }

    #[test]
    fn test_list_local_directory() {
        let temp_dir = create_test_dir();

        // Create test files
        std::fs::write(temp_dir.join("file1.txt"), "hello world").unwrap();
        std::fs::create_dir(temp_dir.join("subdir")).unwrap();

        let (canonical, entries) = list_local_directory(Some(&temp_dir.to_string_lossy())).unwrap();
        assert_eq!(
            canonical,
            temp_dir.canonicalize().unwrap().to_string_lossy()
        );
        let user_entries: Vec<_> = entries.iter().filter(|e| e.name != ".DS_Store").collect();
        assert_eq!(user_entries.len(), 2);

        let file1 = user_entries.iter().find(|e| e.name == "file1.txt").unwrap();
        assert!(!file1.is_dir);
        assert_eq!(file1.size, 11);
        #[cfg(unix)]
        {
            assert!(file1.owner.is_some());
            assert!(file1.group.is_some());
            let owner = file1.owner.as_deref().unwrap();
            let group = file1.group.as_deref().unwrap();
            assert!(!owner.is_empty());
            assert!(!group.is_empty());
        }

        let subdir = user_entries.iter().find(|e| e.name == "subdir").unwrap();
        assert!(subdir.is_dir);
        assert_eq!(subdir.size, 0);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_read_local_preview() {
        let temp_dir = create_test_dir();
        let file_path = temp_dir.join("preview.txt");
        std::fs::write(&file_path, "Quick Look Local Preview Test").unwrap();

        let bytes = read_local_preview(&file_path.to_string_lossy(), 1024).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "Quick Look Local Preview Test"
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_create_rename_delete_local() {
        let temp_dir = create_test_dir();
        let sub = temp_dir.join("new_folder");

        // Create
        create_local_directory(&sub.to_string_lossy()).unwrap();
        assert!(sub.exists());

        // Rename
        let renamed = temp_dir.join("renamed_folder");
        rename_local_item(&sub.to_string_lossy(), &renamed.to_string_lossy()).unwrap();
        assert!(!sub.exists());
        assert!(renamed.exists());

        // Delete
        delete_local_item(&renamed.to_string_lossy()).unwrap();
        assert!(!renamed.exists());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_rename_rejects_existing_destination() {
        let temp_dir = create_test_dir();
        let file_a = temp_dir.join("file_a.txt");
        let file_b = temp_dir.join("file_b.txt");
        std::fs::write(&file_a, "A").unwrap();
        std::fs::write(&file_b, "B").unwrap();

        let res = rename_local_item(&file_a.to_string_lossy(), &file_b.to_string_lossy());
        assert!(res.is_err());
        assert_eq!(std::fs::read_to_string(&file_b).unwrap(), "B");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn test_symlink_delete() {
        let temp_dir = create_test_dir();
        let target = temp_dir.join("target.txt");
        let link = temp_dir.join("link.txt");
        std::fs::write(&target, "target content").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        // Deleting symlink should remove the link, not the target
        delete_local_item(&link.to_string_lossy()).unwrap();
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert!(target.exists());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_format_unix_mode() {
        let dir_mode = format_unix_mode(0o755, true);
        assert_eq!(dir_mode, "drwxr-xr-x");

        let file_mode = format_unix_mode(0o644, false);
        assert_eq!(file_mode, "-rw-r--r--");

        // Special bits: setuid, setgid, sticky
        assert_eq!(format_unix_mode(0o4755, false), "-rwsr-xr-x");
        assert_eq!(format_unix_mode(0o4644, false), "-rwSr--r--");
        assert_eq!(format_unix_mode(0o2755, false), "-rwxr-sr-x");
        assert_eq!(format_unix_mode(0o2744, false), "-rwxr-Sr--");
        assert_eq!(format_unix_mode(0o1755, true), "drwxr-xr-t");
        assert_eq!(format_unix_mode(0o1744, true), "drwxr--r-T");
    }

    #[cfg(unix)]
    #[test]
    fn test_set_local_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let temp_dir = create_test_dir();
        let file_path = temp_dir.join("perm_test.txt");
        std::fs::write(&file_path, "hello permissions").unwrap();

        set_local_permissions(&file_path.to_string_lossy(), Some(0o600), None, None, false)
            .unwrap();
        let meta = std::fs::metadata(&file_path).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);

        // Recursive test on folder
        let sub_dir = temp_dir.join("sub");
        std::fs::create_dir(&sub_dir).unwrap();
        let sub_file = sub_dir.join("sub_file.txt");
        std::fs::write(&sub_file, "nested").unwrap();

        set_local_permissions(&sub_dir.to_string_lossy(), Some(0o750), None, None, true).unwrap();
        let sub_dir_meta = std::fs::metadata(&sub_dir).unwrap();
        assert_eq!(sub_dir_meta.permissions().mode() & 0o777, 0o750);
        let sub_file_meta = std::fs::metadata(&sub_file).unwrap();
        assert_eq!(sub_file_meta.permissions().mode() & 0o777, 0o750);

        // Test user resolution
        let root_uid = resolve_user_to_uid("0").unwrap();
        assert_eq!(root_uid, 0);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn test_set_local_permissions_does_not_follow_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let temp_dir = create_test_dir();

        // Target file located outside the folder being chmod'd
        let external_target = temp_dir.join("external_secret.txt");
        std::fs::write(&external_target, "secret").unwrap();
        std::fs::set_permissions(&external_target, std::fs::Permissions::from_mode(0o600)).unwrap();

        // Folder containing a normal file and a symlink to external_target
        let folder = temp_dir.join("folder");
        std::fs::create_dir(&folder).unwrap();
        let symlink_path = folder.join("link_to_secret.txt");
        std::os::unix::fs::symlink(&external_target, &symlink_path).unwrap();

        let normal_child = folder.join("normal.txt");
        std::fs::write(&normal_child, "normal").unwrap();

        // Run recursive chmod on folder to 0o777
        set_local_permissions(&folder.to_string_lossy(), Some(0o777), None, None, true).unwrap();

        // Normal child must be updated
        let normal_meta = std::fs::metadata(&normal_child).unwrap();
        assert_eq!(normal_meta.permissions().mode() & 0o777, 0o777);

        // Security assertion: external target permissions must NOT be modified
        let target_meta = std::fs::metadata(&external_target).unwrap();
        assert_eq!(
            target_meta.permissions().mode() & 0o777,
            0o600,
            "Security assertion failed: recursive chmod followed symlink outside target directory!"
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
