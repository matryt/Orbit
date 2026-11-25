import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isValidItemName, buildNewFolderPath, buildRenamePath, isWindowsLocalPath, toWindowsSafeName } from './pathUtils.ts';

describe('isValidItemName', () => {
  it('accepts normal file and folder names', () => {
    assert.equal(isValidItemName('documents'), true);
    assert.equal(isValidItemName('file.txt'), true);
    assert.equal(isValidItemName('my-cool_folder (1)'), true);
  });

  it('rejects empty or whitespace names', () => {
    assert.equal(isValidItemName(''), false);
    assert.equal(isValidItemName('   '), false);
  });

  it('rejects path traversal dot components', () => {
    assert.equal(isValidItemName('.'), false);
    assert.equal(isValidItemName('..'), false);
    assert.equal(isValidItemName(' .. '), false);
  });

  it('rejects Unix and Windows path separators', () => {
    assert.equal(isValidItemName('folder/sub'), false);
    assert.equal(isValidItemName('/absolute'), false);
    assert.equal(isValidItemName('folder\\sub'), false);
    assert.equal(isValidItemName('..\\escape'), false);
    assert.equal(isValidItemName('../escape'), false);
  });
});

describe('buildNewFolderPath', () => {
  it('builds standard Unix folder path', () => {
    assert.equal(buildNewFolderPath('/home/user', 'projects'), '/home/user/projects');
    assert.equal(buildNewFolderPath('/home/user/', 'projects'), '/home/user/projects');
  });

  it('builds Unix root folder path', () => {
    assert.equal(buildNewFolderPath('/', 'data'), '/data');
  });

  it('builds Windows folder path', () => {
    assert.equal(buildNewFolderPath('C:\\Users\\admin', 'docs'), 'C:\\Users\\admin\\docs');
    assert.equal(buildNewFolderPath('C:\\Users\\admin\\', 'docs'), 'C:\\Users\\admin\\docs');
    assert.equal(buildNewFolderPath('C:\\', 'docs'), 'C:\\docs');
  });

  it('returns null on invalid folder names', () => {
    assert.equal(buildNewFolderPath('/home/user', '../hack'), null);
    assert.equal(buildNewFolderPath('/home/user', 'foo/bar'), null);
    assert.equal(buildNewFolderPath('/home/user', ''), null);
  });
});

describe('buildRenamePath', () => {
  it('renames item in standard Unix directory', () => {
    assert.equal(buildRenamePath('/home/user/old.txt', 'new.txt'), '/home/user/new.txt');
  });

  it('renames item at Unix root directory preserving leading slash', () => {
    assert.equal(buildRenamePath('/old.txt', 'new.txt'), '/new.txt');
    assert.equal(buildRenamePath('/test', 'renamed'), '/renamed');
  });

  it('renames item in Windows directory', () => {
    assert.equal(buildRenamePath('C:\\Users\\admin\\old.txt', 'new.txt'), 'C:\\Users\\admin\\new.txt');
  });

  it('renames item at Windows root preserving drive prefix', () => {
    assert.equal(buildRenamePath('C:\\old.txt', 'new.txt'), 'C:\\new.txt');
  });

  it('returns null if new name is identical', () => {
    assert.equal(buildRenamePath('/home/user/file.txt', 'file.txt'), null);
  });

  it('returns null on invalid name or path escape', () => {
    assert.equal(buildRenamePath('/home/user/file.txt', '../escaped.txt'), null);
    assert.equal(buildRenamePath('/home/user/file.txt', 'sub/file.txt'), null);
    assert.equal(buildRenamePath('/home/user/file.txt', '..'), null);
  });
});

describe('isWindowsLocalPath', () => {
  it('detects Windows paths, including extended-length ones', () => {
    assert.equal(isWindowsLocalPath('C:\\Users\\me'), true);
    assert.equal(isWindowsLocalPath('C:\\'), true);
    assert.equal(isWindowsLocalPath('\\\\?\\C:\\very\\long'), true);
    assert.equal(isWindowsLocalPath('/Users/me'), false);
    assert.equal(isWindowsLocalPath('/Users/me/a\\b'), false);
  });
});

describe('toWindowsSafeName', () => {
  it('keeps names that are already valid', () => {
    for (const name of ['report.pdf', '.env', 'café ☕.md', 'a b (1).txt', 'console.log', 'COM10']) {
      assert.equal(toWindowsSafeName(name), name);
    }
  });

  it('replaces characters that Windows rejects or reinterprets', () => {
    // `:` would otherwise write into an NTFS alternate data stream.
    assert.equal(toWindowsSafeName('12:00.log'), '12_00.log');
    assert.equal(toWindowsSafeName('payload.bat:hidden'), 'payload.bat_hidden');
    assert.equal(toWindowsSafeName('a<b>c"d|e?f*g'), 'a_b_c_d_e_f_g');
    assert.equal(toWindowsSafeName('tab\there\u0000'), 'tab_here_');
  });

  it('strips trailing dots and spaces', () => {
    assert.equal(toWindowsSafeName('notes.'), 'notes');
    assert.equal(toWindowsSafeName('draft . '), 'draft');
    assert.equal(toWindowsSafeName('...'), 'fichier');
    assert.equal(toWindowsSafeName(''), 'fichier');
  });

  it('prefixes reserved device names, with or without extension', () => {
    assert.equal(toWindowsSafeName('CON'), '_CON');
    assert.equal(toWindowsSafeName('nul.txt'), '_nul.txt');
    assert.equal(toWindowsSafeName('Com1.log'), '_Com1.log');
    assert.equal(toWindowsSafeName('LPT9'), '_LPT9');
  });

  it('is idempotent', () => {
    for (const name of ['12:00.log', 'CON', 'notes.', 'a?b']) {
      const once = toWindowsSafeName(name);
      assert.equal(toWindowsSafeName(once), once);
    }
  });
});
