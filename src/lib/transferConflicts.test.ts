import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NameSet, joinPath, nextAvailableName, planTransferBatch, splitPath } from './transferConflicts.ts';
import type { ConflictDecision, ConflictPrompt, TransferRequest } from './transferConflicts.ts';

describe('splitPath', () => {
  it('splits posix paths', () => {
    assert.deepEqual(splitPath('/home/user/file.txt'), { dir: '/home/user', name: 'file.txt' });
  });
  it('keeps the root directory', () => {
    assert.deepEqual(splitPath('/file.txt'), { dir: '/', name: 'file.txt' });
  });
  it('splits windows paths and keeps the drive root', () => {
    assert.deepEqual(splitPath('C:\\Users\\me\\a.txt'), { dir: 'C:\\Users\\me', name: 'a.txt' });
    assert.deepEqual(splitPath('C:\\a.txt'), { dir: 'C:\\', name: 'a.txt' });
  });
});

describe('remote paths', () => {
  it('only split remote paths on slashes', () => {
    assert.deepEqual(splitPath('/srv/report\\final.txt', true), { dir: '/srv', name: 'report\\final.txt' });
  });
  it('never turns a remote drive-like prefix into a backslash root', () => {
    assert.deepEqual(splitPath('C:/file.txt', true), { dir: 'C:', name: 'file.txt' });
    assert.deepEqual(splitPath('/C:/file.txt', true), { dir: '/C:', name: 'file.txt' });
  });
  it('join remote paths with a slash', () => {
    assert.equal(joinPath('/srv', 'a (1).txt', true), '/srv/a (1).txt');
  });
});

describe('joinPath', () => {
  it('joins with the directory separator', () => {
    assert.equal(joinPath('/home/user', 'a.txt'), '/home/user/a.txt');
    assert.equal(joinPath('/', 'a.txt'), '/a.txt');
    assert.equal(joinPath('C:\\Users', 'a.txt'), 'C:\\Users\\a.txt');
  });
});

describe('nextAvailableName', () => {
  it('inserts the counter before the extension', () => {
    assert.equal(nextAvailableName('report.pdf', new NameSet(false, ['report.pdf'])), 'report (1).pdf');
  });
  it('skips counters already taken', () => {
    const taken = new NameSet(false, ['a.txt', 'a (1).txt', 'a (2).txt']);
    assert.equal(nextAvailableName('a.txt', taken), 'a (3).txt');
  });
  it('treats a leading dot as part of the name', () => {
    assert.equal(nextAvailableName('.env', new NameSet(false, ['.env'])), '.env (1)');
  });
  it('handles names without extension', () => {
    assert.equal(nextAvailableName('Makefile', new NameSet(false, ['Makefile'])), 'Makefile (1)');
  });
});

describe('NameSet', () => {
  it('is case-insensitive when asked', () => {
    const set = new NameSet(true, ['File.TXT']);
    assert.ok(set.has('file.txt'));
  });
  it('is case-sensitive by default for remote listings', () => {
    const set = new NameSet(false, ['File.TXT']);
    assert.ok(!set.has('file.txt'));
  });
});

describe('planTransferBatch', () => {
  const up = (name: string, dir = '/srv'): TransferRequest => ({
    direction: 'upload',
    localPath: `/local/${name}`,
    remotePath: `${dir}/${name}`,
    fileName: name,
  });

  const deps = (existing: string[], answers: (ConflictDecision | null)[]) => {
    const prompts: ConflictPrompt[] = [];
    return {
      prompts,
      deps: {
        loadTaken: async (direction: TransferRequest['direction']) => new NameSet(direction === 'download', existing),
        ask: async (p: ConflictPrompt) => {
          prompts.push(p);
          return answers.shift() ?? null;
        },
      },
    };
  };

  const down = (relative: string): TransferRequest => ({
    direction: 'download',
    localPath: `/dst/${relative}`,
    remotePath: `/srv/${relative}`,
    fileName: relative.substring(relative.lastIndexOf('/') + 1),
  });

  it('detects downloads whose names differ only by case (case-insensitive local disk)', async () => {
    const { deps: d, prompts } = deps([], [{ choice: 'keepBoth', applyToAll: false }]);
    const res = await planTransferBatch([down('Readme.txt'), down('README.txt')], d);
    assert.equal(prompts.length, 1);
    assert.deepEqual(res?.map((r) => r.localPath), ['/dst/Readme.txt', '/dst/README (1).txt']);
  });

  it('detects downloads whose parent folders differ only by case', async () => {
    const { deps: d, prompts } = deps([], [{ choice: 'skip', applyToAll: false }]);
    const res = await planTransferBatch([down('A/x.txt'), down('a/x.txt')], d);
    assert.equal(prompts.length, 1);
    assert.deepEqual(res?.map((r) => r.localPath), ['/dst/A/x.txt']);
  });

  it('loads existing files across distinct case spellings of destination directories', async () => {
    const existingByDir = new Map<string, string[]>([
      ['/dst/A', []],
      ['/dst/a', ['x.txt']],
    ]);
    const prompts: ConflictPrompt[] = [];
    const d: PlanDeps = {
      loadTaken: async (_dirMode, dir) => new NameSet(true, existingByDir.get(dir) ?? []),
      ask: async (p) => {
        prompts.push(p);
        return { choice: 'skip', applyToAll: false };
      },
    };
    const res = await planTransferBatch([down('A/y.txt'), down('a/x.txt')], d);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].fileName, 'x.txt');
    assert.deepEqual(res?.map((r) => r.localPath), ['/dst/A/y.txt']);
  });

  it('keeps uploads whose parent folders differ only by case apart (case-sensitive remote)', async () => {
    const { deps: d, prompts } = deps([], []);
    const res = await planTransferBatch([up('x.txt', '/srv/A'), up('x.txt', '/srv/a')], d);
    assert.equal(prompts.length, 0);
    assert.equal(res?.length, 2);
  });

  it('passes through requests without conflicts and never asks', async () => {
    const { deps: d, prompts } = deps([], []);
    const res = await planTransferBatch([up('a.txt'), up('b.txt')], d);
    assert.deepEqual(res?.map((r) => r.remotePath), ['/srv/a.txt', '/srv/b.txt']);
    assert.equal(prompts.length, 0);
  });

  it('applies replace / skip / keepBoth per conflict', async () => {
    const { deps: d } = deps(['a.txt', 'b.txt', 'c.txt'], [
      { choice: 'replace', applyToAll: false },
      { choice: 'skip', applyToAll: false },
      { choice: 'keepBoth', applyToAll: false },
    ]);
    const res = await planTransferBatch([up('a.txt'), up('b.txt'), up('c.txt')], d);
    assert.deepEqual(res?.map((r) => r.remotePath), ['/srv/a.txt', '/srv/c (1).txt']);
    assert.equal(res?.[1].fileName, 'c (1).txt');
  });

  it('asks once and reuses the choice when applyToAll is set', async () => {
    const { deps: d, prompts } = deps(['a.txt', 'b.txt'], [{ choice: 'skip', applyToAll: true }]);
    const res = await planTransferBatch([up('a.txt'), up('new.txt'), up('b.txt')], d);
    assert.deepEqual(res?.map((r) => r.fileName), ['new.txt']);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].otherConflicts, 1);
  });

  it('detects duplicates inside the same batch', async () => {
    const { deps: d, prompts } = deps([], [{ choice: 'keepBoth', applyToAll: false }]);
    const res = await planTransferBatch([up('a.txt'), up('a.txt')], d);
    assert.deepEqual(res?.map((r) => r.remotePath), ['/srv/a.txt', '/srv/a (1).txt']);
    assert.equal(prompts.length, 1);
  });

  it('counts later intra-batch collisions in otherConflicts', async () => {
    const { deps: d, prompts } = deps(['a.txt'], [
      { choice: 'replace', applyToAll: false },
      { choice: 'replace', applyToAll: false },
    ]);
    await planTransferBatch([up('a.txt'), up('b.txt'), up('b.txt')], d);
    assert.equal(prompts[0].otherConflicts, 1);
  });

  it('keeps backslashes in remote names when renaming', async () => {
    const { deps: d } = deps(['x\\y.txt'], [{ choice: 'keepBoth', applyToAll: false }]);
    const res = await planTransferBatch([up('x\\y.txt')], d);
    assert.equal(res?.[0].remotePath, '/srv/x\\y (1).txt');
  });

  it('returns null when the batch is cancelled', async () => {
    const { deps: d } = deps(['a.txt'], [null]);
    assert.equal(await planTransferBatch([up('new.txt'), up('a.txt')], d), null);
  });

  it('renames the local path for downloads', async () => {
    const { deps: d } = deps(['a.txt'], [{ choice: 'keepBoth', applyToAll: false }]);
    const res = await planTransferBatch(
      [{ direction: 'download', localPath: '/home/me/a.txt', remotePath: '/srv/a.txt', fileName: 'a.txt' }],
      d
    );
    assert.equal(res?.[0].localPath, '/home/me/a (1).txt');
    assert.equal(res?.[0].remotePath, '/srv/a.txt');
  });
});
