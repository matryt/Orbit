//! Recursive directory walks used by folder transfers.
//!
//! A walk returns a flat list of entries relative to the walked root, with `/` as separator
//! on every platform. Symbolic links to directories are never followed, so a walk always
//! terminates.

use std::collections::VecDeque;
use std::path::Path;

use serde::Serialize;

use crate::error::AppError;
use crate::provider::StorageProvider;

/// Upper bound on the number of entries a single walk may return.
pub const MAX_WALK_ENTRIES: usize = 100_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WalkEntry {
    /// Path relative to the walked root, `/`-separated (e.g. `photos/2024/a.jpg`).
    pub relative_path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalWalkResult {
    /// False when the walked path is a file: `entries` is then empty.
    pub is_dir: bool,
    pub entries: Vec<WalkEntry>,
}

pub(crate) fn too_many_entries() -> AppError {
    AppError::InvalidPath(format!(
        "Le dossier contient plus de {MAX_WALK_ENTRIES} éléments, transfert refusé."
    ))
}

/// True when every `/`-separated segment is a plain name. Remote names come from the server
/// and end up in local paths on download: `..`, `.`, empty segments and backslashes (a
/// separator on Windows) would let an entry escape the destination directory.
pub fn is_safe_relative_path(relative: &str) -> bool {
    !relative.is_empty()
        && !relative.contains('\\')
        && relative
            .split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

fn join_relative(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

pub fn join_remote(root: &str, relative: &str) -> String {
    if relative.is_empty() {
        root.to_string()
    } else if root.ends_with('/') {
        format!("{root}{relative}")
    } else {
        format!("{root}/{relative}")
    }
}

/// Generic remote walk: breadth-first traversal built on `list_dir`.
pub async fn walk_remote<P: StorageProvider + ?Sized>(
    provider: &P,
    root: &str,
) -> Result<Vec<WalkEntry>, AppError> {
    let mut entries = Vec::new();
    let mut pending = VecDeque::from([String::new()]);

    while let Some(relative_dir) = pending.pop_front() {
        let listing = provider.list_dir(&join_remote(root, &relative_dir)).await?;
        for item in listing {
            let relative_path = join_relative(&relative_dir, &item.name);
            if !is_safe_relative_path(&relative_path) {
                continue;
            }
            if item.is_dir {
                pending.push_back(relative_path.clone());
            }
            entries.push(WalkEntry {
                relative_path,
                is_dir: item.is_dir,
                is_symlink: item.is_symlink,
                size: if item.is_dir { 0 } else { item.size },
            });
            if entries.len() > MAX_WALK_ENTRIES {
                return Err(too_many_entries());
            }
        }
    }
    Ok(entries)
}

/// Walks a local path. Symlinked directories are skipped; symlinked files are included.
pub fn walk_local(root: &Path) -> Result<LocalWalkResult, AppError> {
    let meta = std::fs::metadata(root).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound(format!("Chemin introuvable : {}", root.display()))
        } else {
            AppError::from(e)
        }
    })?;
    if !meta.is_dir() {
        return Ok(LocalWalkResult {
            is_dir: false,
            entries: Vec::new(),
        });
    }

    let mut entries = Vec::new();
    let mut pending = VecDeque::from([String::new()]);

    while let Some(relative_dir) = pending.pop_front() {
        let dir = if relative_dir.is_empty() {
            root.to_path_buf()
        } else {
            root.join(&relative_dir)
        };
        for item in std::fs::read_dir(&dir)? {
            let item = item?;
            let name = item.file_name().to_string_lossy().into_owned();
            let file_type = item.file_type()?;
            let relative_path = join_relative(&relative_dir, &name);

            let is_symlink = file_type.is_symlink();
            let (is_dir, size) = if is_symlink {
                match std::fs::metadata(item.path()) {
                    Ok(target) if target.is_file() => (false, target.len()),
                    // Symlinked directories (possible loops) and special files are skipped.
                    Ok(_) => continue,
                    // Dangling link: there is nothing to transfer.
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    // Any other error (e.g. permission denied on the target) would make the
                    // upload silently incomplete: report it instead.
                    Err(e) => {
                        return Err(AppError::Io(format!(
                            "Lien symbolique illisible « {} » : {}",
                            relative_path, e
                        )));
                    }
                }
            } else if file_type.is_dir() {
                (true, 0)
            } else if file_type.is_file() {
                (false, item.metadata()?.len())
            } else {
                // Sockets, FIFOs, devices: not transferable.
                continue;
            };

            if is_dir {
                pending.push_back(relative_path.clone());
            }
            entries.push(WalkEntry {
                relative_path,
                is_dir,
                is_symlink,
                size,
            });
            if entries.len() > MAX_WALK_ENTRIES {
                return Err(too_many_entries());
            }
        }
    }
    Ok(LocalWalkResult {
        is_dir: true,
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("orbit-walk-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sorted(mut entries: Vec<WalkEntry>) -> Vec<WalkEntry> {
        entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        entries
    }

    #[test]
    fn walks_nested_directories_with_relative_paths() {
        let root = scratch_dir("nested");
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::create_dir_all(root.join("empty")).unwrap();
        std::fs::write(root.join("top.txt"), b"12345").unwrap();
        std::fs::write(root.join("a/b/deep.txt"), b"xy").unwrap();

        let result = walk_local(&root).unwrap();
        assert!(result.is_dir);
        assert_eq!(
            sorted(result.entries),
            vec![
                WalkEntry {
                    relative_path: "a".into(),
                    is_dir: true,
                    is_symlink: false,
                    size: 0
                },
                WalkEntry {
                    relative_path: "a/b".into(),
                    is_dir: true,
                    is_symlink: false,
                    size: 0
                },
                WalkEntry {
                    relative_path: "a/b/deep.txt".into(),
                    is_dir: false,
                    is_symlink: false,
                    size: 2
                },
                WalkEntry {
                    relative_path: "empty".into(),
                    is_dir: true,
                    is_symlink: false,
                    size: 0
                },
                WalkEntry {
                    relative_path: "top.txt".into(),
                    is_dir: false,
                    is_symlink: false,
                    size: 5
                },
            ]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reports_files_as_not_directories() {
        let root = scratch_dir("file");
        let file = root.join("f.txt");
        std::fs::write(&file, b"x").unwrap();
        let result = walk_local(&file).unwrap();
        assert!(!result.is_dir);
        assert!(result.entries.is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinked_directories() {
        let root = scratch_dir("symlink");
        std::fs::create_dir_all(root.join("real")).unwrap();
        std::fs::write(root.join("real/f.txt"), b"x").unwrap();
        // A loop back to the root must not be followed.
        std::os::unix::fs::symlink(&root, root.join("real/loop")).unwrap();

        let result = walk_local(&root).unwrap();
        let paths: Vec<_> = sorted(result.entries)
            .into_iter()
            .map(|e| e.relative_path)
            .collect();
        assert_eq!(paths, vec!["real", "real/f.txt"]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn skips_dangling_symlinks() {
        let root = scratch_dir("dangling");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("f.txt"), b"x").unwrap();
        std::os::unix::fs::symlink(root.join("missing"), root.join("broken")).unwrap();

        let result = walk_local(&root).unwrap();
        let paths: Vec<_> = result
            .entries
            .into_iter()
            .map(|e| e.relative_path)
            .collect();
        assert_eq!(paths, vec!["f.txt"]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn reports_symlinks_whose_target_cannot_be_read() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch_dir("unreadable-link");
        std::fs::create_dir_all(root.join("locked")).unwrap();
        std::fs::write(root.join("locked/secret.txt"), b"x").unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::os::unix::fs::symlink(root.join("locked/secret.txt"), root.join("src/link")).unwrap();
        // Without search permission on `locked`, stat on the link target fails with EACCES.
        std::fs::set_permissions(root.join("locked"), std::fs::Permissions::from_mode(0o000))
            .unwrap();

        let result = walk_local(&root.join("src"));
        std::fs::set_permissions(root.join("locked"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        // Root (effective uid 0) ignores permission bits: the target is then readable and the walk succeeds.
        let is_root = unsafe { libc::geteuid() == 0 };
        if !is_root {
            assert!(result.is_err());
        }
    }

    #[test]
    fn rejects_unsafe_relative_paths() {
        for bad in ["", "..", "a/../b", "./a", "a//b", "a\\b", "a/"] {
            assert!(!is_safe_relative_path(bad), "{bad:?} should be rejected");
        }
        for ok in [
            "a",
            "a/b.txt",
            ".env",
            "dir/.hidden",
            "a b/c (1).txt",
            "logs/12:00.log",
        ] {
            assert!(is_safe_relative_path(ok), "{ok:?} should be accepted");
        }
    }

    #[test]
    fn join_remote_handles_root_and_trailing_slash() {
        assert_eq!(join_remote("/", "a"), "/a");
        assert_eq!(join_remote("/srv", "a/b"), "/srv/a/b");
        assert_eq!(join_remote("/srv", ""), "/srv");
    }
}
