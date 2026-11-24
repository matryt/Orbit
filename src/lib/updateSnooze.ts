/**
 * "Remind me later" logic for update prompts.
 *
 * A snooze is bound to the release version it was created for: as soon as a newer release
 * is published the snooze no longer applies, even when it was "skip this version".
 * Only automatic prompts honor it; an explicit "check for updates" always shows the result.
 */

export type SnoozeDuration = '1h' | '24h' | '7d' | 'version';

export interface UpdateSnooze {
  /** Normalized release version the snooze applies to (no leading "v"). */
  version: string;
  /** Epoch milliseconds until which prompts stay silent, or 'never' to skip this release. */
  until: number | 'never';
}

export const UPDATE_SNOOZE_STORAGE_KEY = 'orbit_update_snooze';

const HOUR_MS = 60 * 60 * 1000;

const DURATION_MS: Record<Exclude<SnoozeDuration, 'version'>, number> = {
  '1h': HOUR_MS,
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
};

/** Strips whitespace and a leading "v"/"V" so "v0.5.0" and "0.5.0" compare equal. */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^[vV]/, '');
}

export function createSnooze(version: string, duration: SnoozeDuration, now: number): UpdateSnooze {
  return {
    version: normalizeVersion(version),
    until: duration === 'version' ? 'never' : now + DURATION_MS[duration],
  };
}

/** True when automatic prompts for `version` must stay silent at time `now`. */
export function isUpdateSnoozed(snooze: UpdateSnooze | null, version: string, now: number): boolean {
  if (!snooze || snooze.version !== normalizeVersion(version)) return false;
  return snooze.until === 'never' || now < snooze.until;
}

/** Parses a persisted snooze, returning null for anything malformed. */
export function parseSnooze(raw: string | null): UpdateSnooze | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { version, until } = value as Record<string, unknown>;
    if (typeof version !== 'string' || version.trim() === '') return null;
    if (until !== 'never' && (typeof until !== 'number' || !Number.isFinite(until))) return null;
    return { version: normalizeVersion(version), until: until as number | 'never' };
  } catch {
    return null;
  }
}

type SnoozeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): SnoozeStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// Persistence is best-effort: losing a snooze only means the prompt shows up again.
export function loadSnooze(storage: SnoozeStorage | null = defaultStorage()): UpdateSnooze | null {
  try {
    return parseSnooze(storage?.getItem(UPDATE_SNOOZE_STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

export function saveSnooze(snooze: UpdateSnooze, storage: SnoozeStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(UPDATE_SNOOZE_STORAGE_KEY, JSON.stringify(snooze));
  } catch {
    // Ignore quota / disabled storage errors.
  }
}

export function clearSnooze(storage: SnoozeStorage | null = defaultStorage()): void {
  try {
    storage?.removeItem(UPDATE_SNOOZE_STORAGE_KEY);
  } catch {
    // Ignore disabled storage errors.
  }
}
