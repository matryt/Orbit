import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isGroupSettled, planFolderTransfer, summarizeGroup } from './transferGroups.ts';
import type { TransferItem, WalkEntry } from '../types/index.ts';

const child = (status: TransferItem['status'], bytes = 0, total = 100, speed = 0) => ({
  status,
  bytesTransferred: bytes,
  totalBytes: total,
  speedBps: speed,
});

describe('summarizeGroup', () => {
  it('reports scanning before files are known', () => {
    assert.equal(summarizeGroup({ phase: 'scanning' }, []).status, 'scanning');
  });

  it('aggregates progress and only counts speed of running files', () => {
    const s = summarizeGroup({ phase: 'ready' }, [
      child('completed', 100, 100, 50),
      child('transferring', 40, 100, 10),
      child('queued', 0, 100),
    ]);
    assert.equal(s.status, 'transferring');
    assert.equal(s.filesDone, 1);
    assert.equal(s.filesTotal, 3);
    assert.equal(s.bytesTransferred, 140);
    assert.equal(s.totalBytes, 300);
    assert.equal(s.speedBps, 10);
  });

  it('is completed when every file completed', () => {
    assert.equal(summarizeGroup({ phase: 'ready' }, [child('completed'), child('completed')]).status, 'completed');
  });

  it('is failed when a file failed and nothing else is pending', () => {
    const s = summarizeGroup({ phase: 'ready' }, [child('completed'), child('failed')]);
    assert.equal(s.status, 'failed');
    assert.equal(s.filesFailed, 1);
  });

  it('is cancelled once the group was cancelled and nothing runs', () => {
    assert.equal(summarizeGroup({ phase: 'cancelled' }, [child('completed'), child('cancelled')]).status, 'cancelled');
  });

  it('counts a completed file as fully transferred even without a final progress event', () => {
    assert.equal(summarizeGroup({ phase: 'ready' }, [child('completed', 0, 100)]).bytesTransferred, 100);
  });
});

describe('isGroupSettled', () => {
  it('waits for scanning and in-flight files', () => {
    assert.equal(isGroupSettled({ phase: 'scanning' }, []), false);
    assert.equal(isGroupSettled({ phase: 'ready' }, [{ status: 'cancelled', inFlight: true }]), false);
    assert.equal(isGroupSettled({ phase: 'ready' }, [{ status: 'cancelled', inFlight: false }]), true);
  });
});

describe('planFolderTransfer', () => {
  const entries: WalkEntry[] = [
    { relative_path: 'a/b', is_dir: true, size: 0 },
    { relative_path: 'a', is_dir: true, size: 0 },
    { relative_path: 'top.txt', is_dir: false, size: 5 },
    { relative_path: 'a/b/deep.txt', is_dir: false, size: 2 },
  ];

  it('plans an upload: remote dirs parents-first, file requests with sizes', () => {
    const plan = planFolderTransfer('upload', '/Users/me/site', '/srv/site', entries, 'g1');
    assert.deepEqual(plan.dirsToCreate, ['/srv/site', '/srv/site/a', '/srv/site/a/b']);
    assert.deepEqual(plan.requests, [
      { direction: 'upload', localPath: '/Users/me/site/top.txt', remotePath: '/srv/site/top.txt', fileName: 'top.txt', groupId: 'g1', totalBytes: 5 },
      { direction: 'upload', localPath: '/Users/me/site/a/b/deep.txt', remotePath: '/srv/site/a/b/deep.txt', fileName: 'deep.txt', groupId: 'g1', totalBytes: 2 },
    ]);
  });

  it('plans a download into a local folder', () => {
    const plan = planFolderTransfer('download', '/srv/site', '/Users/me/site', entries, 'g1');
    assert.equal(plan.dirsToCreate[0], '/Users/me/site');
    assert.equal(plan.requests[1].localPath, '/Users/me/site/a/b/deep.txt');
    assert.equal(plan.requests[1].remotePath, '/srv/site/a/b/deep.txt');
  });

  it('includes empty directories', () => {
    const plan = planFolderTransfer('upload', '/l', '/r', [{ relative_path: 'empty', is_dir: true, size: 0 }], 'g');
    assert.deepEqual(plan.dirsToCreate, ['/r', '/r/empty']);
    assert.equal(plan.requests.length, 0);
  });
});
