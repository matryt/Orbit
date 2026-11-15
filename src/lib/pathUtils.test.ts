import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isValidItemName, buildNewFolderPath, buildRenamePath } from './pathUtils.ts';

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
