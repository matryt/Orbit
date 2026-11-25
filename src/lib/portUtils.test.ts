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

    it('handles leading zeroes cleanly', () => {
      assert.strictEqual(parsePortInput('022'), 22);
      assert.strictEqual(parsePortInput('0080'), 80);
    });

    it('caps ports exceeding 65535 to 65535', () => {
      assert.strictEqual(parsePortInput('70000'), 65535);
      assert.strictEqual(parsePortInput('999999'), 65535);
    });

    it('returns empty string for negative or non-decimal numbers', () => {
      assert.strictEqual(parsePortInput('-1'), '');
      assert.strictEqual(parsePortInput('abc'), '');
      assert.strictEqual(parsePortInput('22abc'), '');
    });

    it('rejects floating-point numbers without silent truncation', () => {
      assert.strictEqual(parsePortInput('22.5'), '');
      assert.strictEqual(parsePortInput('.22'), '');
      assert.strictEqual(parsePortInput('0.0'), '');
    });

    it('rejects scientific notation numbers without partial parsing', () => {
      assert.strictEqual(parsePortInput('2e3'), '');
      assert.strictEqual(parsePortInput('1e4'), '');
      assert.strictEqual(parsePortInput('2E3'), '');
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
      assert.strictEqual(resolvePort('-5'), 22);
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

    it('falls back to defaultPort for floating-point inputs', () => {
      assert.strictEqual(resolvePort(22.5), 22);
      assert.strictEqual(resolvePort('22.5'), 22);
    });

    it('falls back to defaultPort for scientific notation strings', () => {
      assert.strictEqual(resolvePort('2e3'), 22);
    });
  });

  describe('security and injection resilience', () => {
    const maliciousInputs = [
      '22; rm -rf /',
      '22 && whoami',
      '22 | cat /etc/passwd',
      '22\nsh -i',
      '22\r\n',
      "22' OR '1'='1",
      '22" OR "1"="1',
      '`id`',
      '$(whoami)',
      '../../../../etc/shadow',
      '<script>alert(1)</script>',
      '0x16',
      '0b10110',
      'NaN',
      'Infinity',
      '-Infinity',
      '9999999999999999999999999999999999999999',
    ];

    it('parsePortInput rejects all injection strings or caps extreme integer strings', () => {
      for (const input of maliciousInputs) {
        const result = parsePortInput(input);
        if (typeof result === 'number') {
          assert.ok(result >= 0 && result <= 65535, `Expected port to be within 0..65535 but got ${result} for ${input}`);
        } else {
          assert.strictEqual(result, '', `Expected empty string for malicious input "${input}"`);
        }
      }
    });

    it('resolvePort safely sanitizes all malicious inputs to defaultPort or valid port', () => {
      for (const input of maliciousInputs) {
        const resolved = resolvePort(input, 22);
        assert.ok(Number.isInteger(resolved), `Expected integer port for "${input}"`);
        assert.ok(resolved >= 1 && resolved <= 65535, `Expected safe port 1..65535 for "${input}", got ${resolved}`);
      }
    });
  });
});
