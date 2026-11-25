/**
 * Filesystem path validation and construction helpers for Orbit.
 */

export function isValidItemName(name: string): boolean {
  const clean = name.trim();
  if (!clean || clean === '.' || clean === '..') return false;
  return !clean.includes('/') && !clean.includes('\\');
}

export function buildNewFolderPath(parentPath: string, folderName: string): string | null {
  const cleanName = folderName.trim();
  if (!isValidItemName(cleanName) || !parentPath) return null;
  const separator = parentPath.includes('\\') ? '\\' : '/';
  return parentPath.endsWith(separator)
    ? `${parentPath}${cleanName}`
    : `${parentPath}${separator}${cleanName}`;
}

export function buildRenamePath(oldPath: string, newName: string): string | null {
  const cleanName = newName.trim();
  if (!isValidItemName(cleanName)) return null;
  const isWindows = oldPath.includes('\\');
  const separator = isWindows ? '\\' : '/';
  const lastIdx = Math.max(oldPath.lastIndexOf('/'), oldPath.lastIndexOf('\\'));
  if (lastIdx < 0) return null;
  let parentDir = oldPath.substring(0, lastIdx);
  if (!parentDir && oldPath.startsWith('/')) {
    parentDir = '/';
  } else if (isWindows && parentDir.endsWith(':')) {
    parentDir = `${parentDir}\\`;
  }
  const newPath = parentDir.endsWith(separator)
    ? `${parentDir}${cleanName}`
    : `${parentDir}${separator}${cleanName}`;
  return newPath === oldPath ? null : newPath;
}

export function canOpenTerminal(profile?: { type?: string } | null): boolean {
  return Boolean(profile && profile.type === 'sftp');
}

export function resolveTerminalTargetPath(remotePath?: string, currentPath = '/'): string {
  return remotePath ?? currentPath;
}

/**
 * Whether a local path uses Windows conventions. Local paths keep their platform style, and
 * only Windows paths use `\` without `/` (including extended-length `\\?\` ones).
 */
export function isWindowsLocalPath(path: string): boolean {
  return path.includes('\\') && !path.includes('/');
}

const WINDOWS_RESERVED_STEMS = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i;

/**
 * Turns a remote name into a valid Windows file name. Names that are legal on a Linux server
 * (`12:00.log`, `a?b`, `CON`, `notes.`) are invalid or misinterpreted by Windows: a `:` would
 * write into an NTFS alternate data stream instead of the file. Mirrors
 * `sanitize_local_file_name` in `src-tauri/src/local_edit.rs`.
 */
export function toWindowsSafeName(name: string): string {
  let out = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, '_');
  // Windows silently strips trailing dots and spaces.
  out = out.replace(/[. ]+$/, '');
  if (out === '' || out === '.' || out === '..') out = 'fichier';
  const stem = out.split('.')[0].trimEnd();
  if (WINDOWS_RESERVED_STEMS.test(stem)) out = `_${out}`;
  return out;
}
