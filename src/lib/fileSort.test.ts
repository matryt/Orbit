import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sortFiles, getDefaultDirection } from './fileSort.ts';
import type { SortColumn } from './fileSort.ts';
import type { FileEntry } from '../types/index.ts';

const mockFiles: FileEntry[] = [
  {
    name: 'zeta.txt',
    path: '/zeta.txt',
    is_dir: false,
    size: 500,
    modified_at: '2026-01-01T10:00:00Z',
    owner: 'alice',
    group: 'staff',
    permissions: '-rw-r--r--',
  },
  {
    name: 'beta-folder',
    path: '/beta-folder',
    is_dir: true,
    size: 0,
    modified_at: '2026-01-02T10:00:00Z',
    owner: 'bob',
    group: 'admin',
    permissions: 'drwxr-xr-x',
  },
  {
    name: 'alpha-folder',
    path: '/alpha-folder',
    is_dir: true,
    size: 0,
    modified_at: '2026-01-03T10:00:00Z',
    owner: 'alice',
    group: 'staff',
    permissions: 'drwxr-xr-x',
  },
  {
    name: 'file-10.txt',
    path: '/file-10.txt',
    is_dir: false,
    size: 10000,
    modified_at: '2026-01-04T10:00:00Z',
    owner: 'charlie',
    group: 'staff',
    permissions: '-rw-rw-r--',
  },
  {
    name: 'file-2.txt',
    path: '/file-2.txt',
    is_dir: false,
    size: 100,
    modified_at: '2026-01-05T10:00:00Z',
    owner: 'alice',
    group: 'admin',
    permissions: '-rwxr-xr-x',
  },
];

describe('sortFiles', () => {
  it('groups folders first by default', () => {
    const sorted = sortFiles(mockFiles, { column: 'name', direction: 'asc', foldersFirst: true });
    assert.strictEqual(sorted[0].name, 'alpha-folder');
    assert.strictEqual(sorted[1].name, 'beta-folder');
    assert.strictEqual(sorted[2].name, 'file-2.txt');
    assert.strictEqual(sorted[3].name, 'file-10.txt');
    assert.strictEqual(sorted[4].name, 'zeta.txt');
  });

  it('performs natural numeric sort on file names (file-2 before file-10)', () => {
    const sorted = sortFiles(mockFiles, { column: 'name', direction: 'asc', foldersFirst: false });
    const names = sorted.map((f) => f.name);
    assert.ok(names.indexOf('file-2.txt') < names.indexOf('file-10.txt'));
  });

  it('sorts descending by name', () => {
    const sorted = sortFiles(mockFiles, { column: 'name', direction: 'desc', foldersFirst: true });
    // Folders first: beta-folder then alpha-folder
    assert.strictEqual(sorted[0].name, 'beta-folder');
    assert.strictEqual(sorted[1].name, 'alpha-folder');
    // Files descending
    assert.strictEqual(sorted[2].name, 'zeta.txt');
    assert.strictEqual(sorted[3].name, 'file-10.txt');
    assert.strictEqual(sorted[4].name, 'file-2.txt');
  });

  it('sorts by size descending with folders kept on top', () => {
    const sorted = sortFiles(mockFiles, { column: 'size', direction: 'desc', foldersFirst: true });
    // Folders first
    assert.ok(sorted[0].is_dir);
    assert.ok(sorted[1].is_dir);
    // Files sorted by size desc: 10000 -> 500 -> 100
    assert.strictEqual(sorted[2].name, 'file-10.txt');
    assert.strictEqual(sorted[3].name, 'zeta.txt');
    assert.strictEqual(sorted[4].name, 'file-2.txt');
  });

  it('sorts by size ascending', () => {
    const sorted = sortFiles(mockFiles, { column: 'size', direction: 'asc', foldersFirst: true });
    assert.strictEqual(sorted[2].name, 'file-2.txt'); // 100
    assert.strictEqual(sorted[3].name, 'zeta.txt'); // 500
    assert.strictEqual(sorted[4].name, 'file-10.txt'); // 10000
  });

  it('sorts by mtime (date) descending (most recent first)', () => {
    const sorted = sortFiles(mockFiles, { column: 'mtime', direction: 'desc', foldersFirst: true });
    // Folders: Jan 3 before Jan 2
    assert.strictEqual(sorted[0].name, 'alpha-folder');
    assert.strictEqual(sorted[1].name, 'beta-folder');
    // Files: Jan 5 -> Jan 4 -> Jan 1
    assert.strictEqual(sorted[2].name, 'file-2.txt');
    assert.strictEqual(sorted[3].name, 'file-10.txt');
    assert.strictEqual(sorted[4].name, 'zeta.txt');
  });

  it('sorts by owner', () => {
    const sorted = sortFiles(mockFiles, { column: 'owner', direction: 'asc', foldersFirst: true });
    // Folders: alice:staff before bob:admin
    assert.strictEqual(sorted[0].name, 'alpha-folder');
    assert.strictEqual(sorted[1].name, 'beta-folder');
  });

  it('sorts by permissions', () => {
    const sorted = sortFiles(mockFiles, { column: 'permissions', direction: 'asc', foldersFirst: true });
    assert.ok(sorted[0].is_dir);
    assert.ok(sorted[1].is_dir);
  });
});

describe('getDefaultDirection', () => {
  it('defaults mtime and size to desc', () => {
    assert.strictEqual(getDefaultDirection('mtime'), 'desc');
    assert.strictEqual(getDefaultDirection('size'), 'desc');
  });

  it('defaults name, owner, and permissions to asc', () => {
    assert.strictEqual(getDefaultDirection('name'), 'asc');
    assert.strictEqual(getDefaultDirection('owner'), 'asc');
    assert.strictEqual(getDefaultDirection('permissions'), 'asc');
  });
});
