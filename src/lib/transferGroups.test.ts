import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collapsedIndicatorLabel, findFileDirCollisions, folderDestination, isGroupSettled, needsConflictPlanning, listingToRefresh, shouldRefreshAfterSettle, planFolderTransfer, summarizeGroup } from './transferGroups.ts';
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

  it('reports paused when group.paused is true', () => {
    const s = summarizeGroup({ phase: 'ready', paused: true }, [
      child('paused', 40, 100),
      child('queued', 0, 100),
    ]);
    assert.equal(s.status, 'paused');
  });

  it('reports paused when files are paused and none are transferring', () => {
    const s = summarizeGroup({ phase: 'ready' }, [
      child('paused', 40, 100),
      child('queued', 0, 100),
    ]);
    assert.equal(s.status, 'paused');
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

describe('folderDestination', () => {
  it('joins the folder name to the destination directory', () => {
    assert.equal(folderDestination('upload', '/srv', 'site'), '/srv/site');
    assert.equal(folderDestination('download', '/Users/me', 'site'), '/Users/me/site');
    assert.equal(folderDestination('download', 'C:\\Users\\me', 'site'), 'C:\\Users\\me\\site');
  });

  it('rejects names that would escape the destination directory', () => {
    for (const bad of ['', '.', '..', 'a/b', '../x']) {
      assert.equal(folderDestination('download', '/Users/me', bad), null, `download ${JSON.stringify(bad)}`);
      assert.equal(folderDestination('upload', '/srv', bad), null, `upload ${JSON.stringify(bad)}`);
    }
    // A backslash is a separator on a Windows destination.
    assert.equal(folderDestination('download', 'C:\\Users\\me', '..\\x'), null);
  });

  it('accepts dotted names that stay inside the destination', () => {
    assert.equal(folderDestination('download', '/Users/me', '.config'), '/Users/me/.config');
    assert.equal(folderDestination('download', '/Users/me', 'v1..2'), '/Users/me/v1..2');
  });
});

describe('shouldRefreshAfterSettle', () => {
  const tx = (id: string, status: TransferItem['status'], groupId?: string) => ({ id, status, groupId });

  it('refreshes after a standalone file only when it completed', () => {
    assert.equal(shouldRefreshAfterSettle(tx('a', 'completed'), [tx('a', 'completed')]), true);
    assert.equal(shouldRefreshAfterSettle(tx('a', 'failed'), [tx('a', 'failed')]), false);
    assert.equal(shouldRefreshAfterSettle(tx('a', 'cancelled'), [tx('a', 'cancelled')]), false);
  });

  it('waits for the last file of a folder', () => {
    const queue = [tx('a', 'completed', 'g'), tx('b', 'transferring', 'g')];
    assert.equal(shouldRefreshAfterSettle(queue[0], queue), false);
  });

  it('refreshes when the last file of a folder completes', () => {
    const queue = [tx('a', 'completed', 'g'), tx('b', 'completed', 'g')];
    assert.equal(shouldRefreshAfterSettle(queue[1], queue), true);
  });

  it('refreshes when the last file fails or is cancelled but an earlier one completed', () => {
    for (const last of ['failed', 'cancelled'] as const) {
      const queue = [tx('a', 'completed', 'g'), tx('b', last, 'g')];
      assert.equal(shouldRefreshAfterSettle(queue[1], queue), true, last);
    }
  });

  it('does not refresh when no file of the folder completed', () => {
    const queue = [tx('a', 'failed', 'g'), tx('b', 'cancelled', 'g')];
    assert.equal(shouldRefreshAfterSettle(queue[1], queue), false);
  });

  it('ignores files of other folders', () => {
    const queue = [tx('a', 'completed', 'other'), tx('b', 'failed', 'g')];
    assert.equal(shouldRefreshAfterSettle(queue[1], queue), false);
  });
});

describe('listingToRefresh', () => {
  it('refreshes the remote listing after an upload to the active profile', () => {
    assert.equal(listingToRefresh('upload', 'p1', { activeProfileId: 'p1', isDualPane: false }), 'remote');
  });

  it('does not refresh another profile than the one uploaded to', () => {
    assert.equal(listingToRefresh('upload', 'p1', { activeProfileId: 'p2', isDualPane: true }), null);
  });

  it('refreshes the local listing after a download only in dual-pane mode', () => {
    assert.equal(listingToRefresh('download', 'p1', { activeProfileId: 'p2', isDualPane: true }), 'local');
    assert.equal(listingToRefresh('download', 'p1', { activeProfileId: 'p1', isDualPane: false }), null);
  });
});

describe('collapsedIndicatorLabel', () => {
  it('counts running transfers', () => {
    assert.equal(collapsedIndicatorLabel(2, 3, 1), '2 transfert(s) en cours');
    assert.equal(collapsedIndicatorLabel(0, 3, 0), '0 transfert(s) en cours');
  });

  it('reports folder scans when nothing is transferring or queued', () => {
    assert.equal(collapsedIndicatorLabel(0, 0, 1), 'Analyse de 1 dossier…');
    assert.equal(collapsedIndicatorLabel(0, 0, 2), 'Analyse de 2 dossiers…');
  });
});

describe('needsConflictPlanning', () => {
  it('plans whenever the destination folder already exists', () => {
    assert.equal(needsConflictPlanning('upload', true), true);
    assert.equal(needsConflictPlanning('download', true), true);
  });

  it('plans downloads into a new folder: remote names may differ only by case', () => {
    assert.equal(needsConflictPlanning('download', false), true);
  });

  it('skips planning uploads into a new folder: remote names are case-sensitive', () => {
    assert.equal(needsConflictPlanning('upload', false), false);
  });
});

describe('planFolderTransfer on Windows local paths', () => {
  const entries: WalkEntry[] = [
    { relative_path: 'a', is_dir: true, size: 0 },
    { relative_path: 'a/b', is_dir: true, size: 0 },
    { relative_path: 'a/b/deep.txt', is_dir: false, size: 2 },
  ];
  // Canonical local paths on Windows use the extended-length prefix, where `/` is not a separator.
  const winRoot = '\\\\?\\C:\\Users\\me\\site';

  it('uses backslashes below a Windows download destination', () => {
    const plan = planFolderTransfer('download', '/srv/site', winRoot, entries, 'g');
    assert.deepEqual(plan.dirsToCreate, [winRoot, `${winRoot}\\a`, `${winRoot}\\a\\b`]);
    assert.equal(plan.requests[0].localPath, `${winRoot}\\a\\b\\deep.txt`);
    assert.equal(plan.requests[0].remotePath, '/srv/site/a/b/deep.txt');
  });

  it('uses backslashes below a Windows upload source and slashes on the remote side', () => {
    const plan = planFolderTransfer('upload', winRoot, '/srv/site', entries, 'g');
    assert.equal(plan.requests[0].localPath, `${winRoot}\\a\\b\\deep.txt`);
    assert.equal(plan.requests[0].remotePath, '/srv/site/a/b/deep.txt');
    assert.deepEqual(plan.dirsToCreate, ['/srv/site', '/srv/site/a', '/srv/site/a/b']);
  });
});

describe('findFileDirCollisions', () => {
  const entries: WalkEntry[] = [
    { relative_path: 'Index', is_dir: true, size: 0 },
    { relative_path: 'Index/a.txt', is_dir: false, size: 1 },
    { relative_path: 'index', is_dir: false, size: 1 },
    { relative_path: 'other.txt', is_dir: false, size: 1 },
  ];

  it('ignores names differing by case on remote destinations', () => {
    assert.deepEqual(findFileDirCollisions('upload', entries), []);
  });

  it('detects a file and a directory at the same local path, case-insensitively', () => {
    assert.deepEqual(findFileDirCollisions('download', entries), ['index']);
  });

  it('detects an exact collision in both directions', () => {
    const exact: WalkEntry[] = [
      { relative_path: 'a/b', is_dir: true, size: 0 },
      { relative_path: 'a/b', is_dir: false, size: 3 },
    ];
    assert.deepEqual(findFileDirCollisions('upload', exact), ['a/b']);
    assert.deepEqual(findFileDirCollisions('download', exact), ['a/b']);
  });
});
