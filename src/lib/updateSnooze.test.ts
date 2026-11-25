import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  UPDATE_SNOOZE_STORAGE_KEY,
  clearSnooze,
  createSnooze,
  isUpdateSnoozed,
  loadSnooze,
  normalizeVersion,
  parseSnooze,
  saveSnooze,
} from './updateSnooze.ts';

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('updateSnooze', () => {
  describe('normalizeVersion', () => {
    it('strips a leading v and whitespace', () => {
      assert.strictEqual(normalizeVersion('v0.5.0'), '0.5.0');
      assert.strictEqual(normalizeVersion(' V1.2.3 '), '1.2.3');
      assert.strictEqual(normalizeVersion('0.5.0'), '0.5.0');
    });
  });

  describe('createSnooze', () => {
    it('computes the deadline relative to now', () => {
      assert.deepStrictEqual(createSnooze('v0.5.0', '1h', NOW), { version: '0.5.0', until: NOW + HOUR });
      assert.deepStrictEqual(createSnooze('0.5.0', '24h', NOW), { version: '0.5.0', until: NOW + 24 * HOUR });
      assert.deepStrictEqual(createSnooze('0.5.0', '7d', NOW), { version: '0.5.0', until: NOW + 7 * 24 * HOUR });
    });

    it('skips the release forever with "version"', () => {
      assert.deepStrictEqual(createSnooze('v0.5.0', 'version', NOW), { version: '0.5.0', until: 'never' });
    });
  });

  describe('isUpdateSnoozed', () => {
    it('is false without a snooze', () => {
      assert.strictEqual(isUpdateSnoozed(null, 'v0.5.0', NOW), false);
    });

    it('silences the same version until the deadline', () => {
      const snooze = createSnooze('v0.5.0', '1h', NOW);
      assert.strictEqual(isUpdateSnoozed(snooze, 'v0.5.0', NOW), true);
      assert.strictEqual(isUpdateSnoozed(snooze, '0.5.0', NOW + HOUR - 1), true);
    });

    it('expires exactly at the deadline', () => {
      const snooze = createSnooze('v0.5.0', '24h', NOW);
      assert.strictEqual(isUpdateSnoozed(snooze, 'v0.5.0', NOW + 24 * HOUR), false);
    });

    it('never expires for a skipped version', () => {
      const snooze = createSnooze('v0.5.0', 'version', NOW);
      assert.strictEqual(isUpdateSnoozed(snooze, 'v0.5.0', NOW + 365 * 24 * HOUR), true);
    });

    it('does not apply to a newer release, even when the old one was skipped', () => {
      assert.strictEqual(isUpdateSnoozed(createSnooze('v0.5.0', 'version', NOW), 'v0.5.1', NOW), false);
      assert.strictEqual(isUpdateSnoozed(createSnooze('v0.5.0', '7d', NOW), 'v0.6.0', NOW), false);
    });
  });

  describe('parseSnooze', () => {
    it('round-trips valid values', () => {
      assert.deepStrictEqual(parseSnooze('{"version":"v0.5.0","until":123}'), { version: '0.5.0', until: 123 });
      assert.deepStrictEqual(parseSnooze('{"version":"0.5.0","until":"never"}'), { version: '0.5.0', until: 'never' });
    });

    it('rejects missing, corrupted or malformed values', () => {
      assert.strictEqual(parseSnooze(null), null);
      assert.strictEqual(parseSnooze(''), null);
      assert.strictEqual(parseSnooze('not json'), null);
      assert.strictEqual(parseSnooze('null'), null);
      assert.strictEqual(parseSnooze('42'), null);
      assert.strictEqual(parseSnooze('{"until":123}'), null);
      assert.strictEqual(parseSnooze('{"version":"","until":123}'), null);
      assert.strictEqual(parseSnooze('{"version":"0.5.0"}'), null);
      assert.strictEqual(parseSnooze('{"version":"0.5.0","until":"later"}'), null);
      assert.strictEqual(parseSnooze('{"version":"0.5.0","until":"123"}'), null);
    });
  });

  describe('persistence', () => {
    it('saves, loads and clears through the given storage', () => {
      const storage = memoryStorage();
      const snooze = createSnooze('v0.5.0', '24h', NOW);
      saveSnooze(snooze, storage);
      assert.ok(storage.data.has(UPDATE_SNOOZE_STORAGE_KEY));
      assert.deepStrictEqual(loadSnooze(storage), snooze);
      clearSnooze(storage);
      assert.strictEqual(loadSnooze(storage), null);
    });

    it('survives unavailable or throwing storage', () => {
      const throwing = {
        getItem: () => { throw new Error('denied'); },
        setItem: () => { throw new Error('denied'); },
        removeItem: () => { throw new Error('denied'); },
      };
      assert.strictEqual(loadSnooze(throwing), null);
      assert.doesNotThrow(() => saveSnooze(createSnooze('0.5.0', '1h', NOW), throwing));
      assert.doesNotThrow(() => clearSnooze(throwing));
      assert.strictEqual(loadSnooze(null), null);
    });
  });
});
