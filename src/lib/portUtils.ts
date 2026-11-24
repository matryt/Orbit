/**
 * Utility functions for parsing, validating, and resolving network port inputs.
 */

/**
 * Parses user input from a port input field.
 * Returns '' when the input is empty or invalid, allowing the user to clear the input
 * without being stuck with a 0.
 * Rejects non-decimal inputs (floating points, scientific notation, command injections).
 */
export function parsePortInput(value: string): number | '' {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (!/^\d+$/.test(trimmed)) return '';
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) return '';
  if (parsed > 65535) return 65535;
  return parsed;
}

/**
 * Resolves a port to a valid integer between 1 and 65535.
 * Falls back to defaultPort if empty, 0, NaN, floating point, or out of bounds.
 */
export function resolvePort(value: number | string | undefined | null, defaultPort = 22): number {
  if (value === '' || value === undefined || value === null) {
    return defaultPort;
  }
  let num: number;
  if (typeof value === 'number') {
    num = value;
  } else {
    const str = String(value).trim();
    if (!/^\d+$/.test(str)) {
      return defaultPort;
    }
    num = Number(str);
  }
  if (!Number.isInteger(num) || num <= 0 || num > 65535) {
    return defaultPort;
  }
  return num;
}
