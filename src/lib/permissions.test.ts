import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bitsToMode,
  modeToBits,
  modeToOctal,
  octalToMode,
  modeToSymbolic,
  parsePermissionsString,
  DEFAULT_DIR_MODE,
  DEFAULT_FILE_MODE,
} from './permissions.ts';

describe('permissions utilities', () => {
  it('converts bits to mode and back', () => {
    const mode755 = 0o755;
    const bits755 = modeToBits(mode755);
    assert.deepEqual(bits755, {
      user: { read: true, write: true, execute: true },
      group: { read: true, write: false, execute: true },
      others: { read: true, write: false, execute: true },
    });
    assert.equal(bitsToMode(bits755), mode755);

    const mode644 = 0o644;
    const bits644 = modeToBits(mode644);
    assert.deepEqual(bits644, {
      user: { read: true, write: true, execute: false },
      group: { read: true, write: false, execute: false },
      others: { read: true, write: false, execute: false },
    });
    assert.equal(bitsToMode(bits644), mode644);

    const mode700 = 0o700;
    assert.equal(bitsToMode(modeToBits(mode700)), mode700);

    const mode000 = 0o000;
    assert.equal(bitsToMode(modeToBits(mode000)), mode000);

    const mode777 = 0o777;
    assert.equal(bitsToMode(modeToBits(mode777)), mode777);
  });

  it('formats mode to octal string', () => {
    assert.equal(modeToOctal(0o755), '0755');
    assert.equal(modeToOctal(0o644), '0644');
    assert.equal(modeToOctal(0o700), '0700');
    assert.equal(modeToOctal(0o000), '0000');
    assert.equal(modeToOctal(0o777), '0777');
    assert.equal(modeToOctal(0o4755), '4755');
    assert.equal(modeToOctal(0o1777), '1777');
  });

  it('parses octal strings into numeric mode', () => {
    assert.equal(octalToMode('755'), 0o755);
    assert.equal(octalToMode('0755'), 0o755);
    assert.equal(octalToMode('644'), 0o644);
    assert.equal(octalToMode('0644'), 0o644);
    assert.equal(octalToMode('000'), 0o000);
    assert.equal(octalToMode('0000'), 0o000);
    assert.equal(octalToMode('1777'), 0o1777);
    assert.equal(octalToMode('4755'), 0o4755);

    // Invalid octal inputs
    assert.equal(octalToMode(''), null);
    assert.equal(octalToMode('789'), null);
    assert.equal(octalToMode('abc'), null);
    assert.equal(octalToMode('075555'), null);
    assert.equal(octalToMode('75'), null);
  });

  it('formats mode to symbolic string', () => {
    assert.equal(modeToSymbolic(0o755, true), 'drwxr-xr-x');
    assert.equal(modeToSymbolic(0o755, false), '-rwxr-xr-x');
    assert.equal(modeToSymbolic(0o644, false), '-rw-r--r--');
    assert.equal(modeToSymbolic(0o700, true), 'drwx------');
    assert.equal(modeToSymbolic(0o000, false), '----------');

    // Special bits
    assert.equal(modeToSymbolic(0o4755, false), '-rwsr-xr-x');
    assert.equal(modeToSymbolic(0o4644, false), '-rwSr--r--');
    assert.equal(modeToSymbolic(0o2755, false), '-rwxr-sr-x');
    assert.equal(modeToSymbolic(0o2744, false), '-rwxr-Sr--');
    assert.equal(modeToSymbolic(0o1755, true), 'drwxr-xr-t');
    assert.equal(modeToSymbolic(0o1744, true), 'drwxr--r-T');
  });

  it('parses symbolic permission strings', () => {
    // 10-char format
    assert.equal(parsePermissionsString('drwxr-xr-x', true), 0o755);
    assert.equal(parsePermissionsString('-rw-r--r--', false), 0o644);
    assert.equal(parsePermissionsString('-rwxrwxrwx', false), 0o777);
    assert.equal(parsePermissionsString('----------', false), 0o000);

    // 9-char format (common from SFTP)
    assert.equal(parsePermissionsString('rwxr-xr-x', true), 0o755);
    assert.equal(parsePermissionsString('rw-r--r--', false), 0o644);

    // Special bits: setuid, setgid, sticky
    // Uppercase S/T means special bit is set but execute is NOT set
    assert.equal(parsePermissionsString('-rwSr--r--', false), 0o4644);
    assert.equal(parsePermissionsString('-rw-r-Sr--', false), 0o2644);
    assert.equal(parsePermissionsString('-rw-r--r-T', false), 0o1644);
    // Lowercase s/t means special bit IS set and execute IS set
    assert.equal(parsePermissionsString('-rwsr--r--', false), 0o4744);
    assert.equal(parsePermissionsString('-rwxr-sr-x', false), 0o2755);
    assert.equal(parsePermissionsString('-rwxr-xr-t', false), 0o1755);

    // Fallbacks and invalid inputs
    assert.equal(parsePermissionsString(undefined, true), DEFAULT_DIR_MODE);
    assert.equal(parsePermissionsString(undefined, false), DEFAULT_FILE_MODE);
    assert.equal(parsePermissionsString('invalid', true), DEFAULT_DIR_MODE);
    assert.equal(parsePermissionsString('invalid!!', false), DEFAULT_FILE_MODE);
  });
});
