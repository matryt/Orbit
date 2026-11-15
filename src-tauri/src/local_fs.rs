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

    if path_buf.exists() {
        path_buf.canonicalize().map_err(AppError::from)
    } else {
        Err(AppError::NotFound(format!(
            "Le dossier local '{}' n'existe pas",
            path_buf.display()
        )))
    }
}

pub fn format_unix_mode(mode: u32, is_dir: bool) -> String {
    let prefix = if is_dir { 'd' } else { '-' };
    let r_usr = if mode & 0o400 != 0 { 'r' } else { '-' };
    let w_usr = if mode & 0o200 != 0 { 'w' } else { '-' };
    let x_usr = if mode & 0o100 != 0 { 'x' } else { '-' };
    let r_grp = if mode & 0o040 != 0 { 'r' } else { '-' };
    let w_grp = if mode & 0o020 != 0 { 'w' } else { '-' };
    let x_grp = if mode & 0o010 != 0 { 'x' } else { '-' };
    let r_oth = if mode & 0o004 != 0 { 'r' } else { '-' };
    let w_oth = if mode & 0o002 != 0 { 'w' } else { '-' };
    let x_oth = if mode & 0o001 != 0 { 'x' } else { '-' };
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

    let read_dir = std::fs::read_dir(&target).map_err(AppError::from)?;
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
    }
}
