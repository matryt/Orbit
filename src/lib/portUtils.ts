/**
 * Utility functions for parsing, validating, and resolving network port inputs.
 */

/**
 * Parses user input from a port input field.
 * Returns '' when the input is empty or invalid, allowing the user to clear the input
 * without being stuck with a 0.
 */
export function parsePortInput(value: string): number | '' {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const parsed = parseInt(trimmed, 10);
  if (isNaN(parsed) || parsed < 0) return '';
  if (parsed > 65535) return 65535;
  return parsed;
}

/**
 * Resolves a port to a valid integer between 1 and 65535.
 * Falls back to defaultPort if empty, 0, NaN, or out of bounds.
 */
export function resolvePort(value: number | string | undefined | null, defaultPort = 22): number {
  if (value === '' || value === undefined || value === null) {
    return defaultPort;
  }
  const num = typeof value === 'number' ? value : parseInt(String(value).trim(), 10);
  if (isNaN(num) || num <= 0 || num > 65535) {
    return defaultPort;
  }
  return num;
}
