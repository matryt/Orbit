import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePortInput, resolvePort } from './portUtils.ts';

describe('portUtils', () => {
  describe('parsePortInput', () => {
    it('returns empty string when input is empty or whitespace', () => {
      assert.strictEqual(parsePortInput(''), '');
      assert.strictEqual(parsePortInput('   '), '');
    });

    it('parses valid positive port numbers', () => {
      assert.strictEqual(parsePortInput('22'), 22);
      assert.strictEqual(parsePortInput('80'), 80);
      assert.strictEqual(parsePortInput('8080'), 8080);
      assert.strictEqual(parsePortInput('65535'), 65535);
    });

    it('allows 0 so the user can type or delete without stuck values', () => {
      assert.strictEqual(parsePortInput('0'), 0);
    });

    it('caps ports exceeding 65535 to 65535', () => {
      assert.strictEqual(parsePortInput('70000'), 65535);
      assert.strictEqual(parsePortInput('999999'), 65535);
    });

    it('returns empty string for negative or invalid numbers', () => {
      assert.strictEqual(parsePortInput('-1'), '');
      assert.strictEqual(parsePortInput('abc'), '');
    });
  });

  describe('resolvePort', () => {
    it('returns defaultPort when input is empty string, null, or undefined', () => {
      assert.strictEqual(resolvePort(''), 22);
      assert.strictEqual(resolvePort(undefined), 22);
      assert.strictEqual(resolvePort(null), 22);
      assert.strictEqual(resolvePort('', 8080), 8080);
    });

    it('returns defaultPort when input is 0 or negative', () => {
      assert.strictEqual(resolvePort(0), 22);
      assert.strictEqual(resolvePort('0'), 22);
      assert.strictEqual(resolvePort(-5), 22);
    });

    it('returns valid port numbers unchanged', () => {
      assert.strictEqual(resolvePort(22), 22);
      assert.strictEqual(resolvePort('2222'), 2222);
      assert.strictEqual(resolvePort(1080, 8080), 1080);
    });

    it('falls back to defaultPort when port is out of range (> 65535)', () => {
      assert.strictEqual(resolvePort(70000), 22);
      assert.strictEqual(resolvePort('99999'), 22);
    });
  });
});
