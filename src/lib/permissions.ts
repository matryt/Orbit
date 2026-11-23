export interface PermissionClassBits {
  read: boolean;
  write: boolean;
  execute: boolean;
}

export interface PermissionMatrix {
  user: PermissionClassBits;
  group: PermissionClassBits;
  others: PermissionClassBits;
}

export const DEFAULT_FILE_MODE = 0o644;
export const DEFAULT_DIR_MODE = 0o755;

/**
 * Converts a PermissionMatrix to a numeric Unix mode (e.g. 0o755 = 493).
 */
export function bitsToMode(matrix: PermissionMatrix): number {
  let mode = 0;
  if (matrix.user.read) mode |= 0o400;
  if (matrix.user.write) mode |= 0o200;
  if (matrix.user.execute) mode |= 0o100;

  if (matrix.group.read) mode |= 0o040;
  if (matrix.group.write) mode |= 0o020;
  if (matrix.group.execute) mode |= 0o010;

  if (matrix.others.read) mode |= 0o004;
  if (matrix.others.write) mode |= 0o002;
  if (matrix.others.execute) mode |= 0o001;

  return mode;
}

/**
 * Extracts a PermissionMatrix from a numeric Unix mode.
 */
export function modeToBits(mode: number): PermissionMatrix {
  const m = mode & 0o777;
  return {
    user: {
      read: (m & 0o400) !== 0,
      write: (m & 0o200) !== 0,
      execute: (m & 0o100) !== 0,
    },
    group: {
      read: (m & 0o040) !== 0,
      write: (m & 0o020) !== 0,
      execute: (m & 0o010) !== 0,
    },
    others: {
      read: (m & 0o004) !== 0,
      write: (m & 0o002) !== 0,
      execute: (m & 0o001) !== 0,
    },
  };
}

/**
 * Formats a mode as a 4-digit octal string (e.g. "0755", "0644").
 */
export function modeToOctal(mode: number): string {
  const m = mode & 0o777;
  return `0${m.toString(8).padStart(3, '0')}`;
}

/**
 * Parses an octal string (e.g. "755", "0755", "644") into a numeric mode.
 * Returns null if the input is not a valid 3- or 4-digit octal string.
 */
export function octalToMode(octalStr: string): number | null {
  const trimmed = octalStr.trim();
  if (!/^(0?[0-7]{3})$/.test(trimmed)) {
    return null;
  }
  const parsed = parseInt(trimmed, 8);
  if (isNaN(parsed) || parsed < 0 || parsed > 0o777) {
    return null;
  }
  return parsed;
}

/**
 * Formats a numeric mode as a 10-character symbolic string (e.g. "-rwxr-xr-x", "drwxr-xr-x").
 */
export function modeToSymbolic(mode: number, isDir = false): string {
  const m = mode & 0o777;
  const prefix = isDir ? 'd' : '-';
  const r_usr = m & 0o400 ? 'r' : '-';
  const w_usr = m & 0o200 ? 'w' : '-';
  const x_usr = m & 0o100 ? 'x' : '-';
  const r_grp = m & 0o040 ? 'r' : '-';
  const w_grp = m & 0o020 ? 'w' : '-';
  const x_grp = m & 0o010 ? 'x' : '-';
  const r_oth = m & 0o004 ? 'r' : '-';
  const w_oth = m & 0o002 ? 'w' : '-';
  const x_oth = m & 0o001 ? 'x' : '-';

  return `${prefix}${r_usr}${w_usr}${x_usr}${r_grp}${w_grp}${x_grp}${r_oth}${w_oth}${x_oth}`;
}

/**
 * Parses a permission string (e.g. "drwxr-xr-x", "-rw-r--r--", or "rwxr-xr-x") into a numeric mode.
 * Falls back to 0o755 for directories and 0o644 for files if missing or invalid.
 */
export function parsePermissionsString(permStr?: string, isDir = false): number {
  if (!permStr || typeof permStr !== 'string') {
    return isDir ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE;
  }

  // Take the last 9 characters to ignore optional leading file-type character (e.g. 'd', '-', 'l')
  const clean = permStr.trim();
  if (clean.length < 9) {
    return isDir ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE;
  }

  const s = clean.slice(-9);
  let mode = 0;
  if (s[0] === 'r') mode |= 0o400;
  if (s[1] === 'w') mode |= 0o200;
  if (s[2] === 'x' || s[2] === 's' || s[2] === 'S') mode |= 0o100;

  if (s[3] === 'r') mode |= 0o040;
  if (s[4] === 'w') mode |= 0o020;
  if (s[5] === 'x' || s[5] === 's' || s[5] === 'S') mode |= 0o010;

  if (s[6] === 'r') mode |= 0o004;
  if (s[7] === 'w') mode |= 0o002;
  if (s[8] === 'x' || s[8] === 't' || s[8] === 'T') mode |= 0o001;

  return mode;
}
