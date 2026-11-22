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
