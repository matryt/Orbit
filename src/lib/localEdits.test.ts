import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LocalEditInfo } from '../types/index.ts';
import {
  closeSessionsWarning,
  pendingConflict,
  remoteParentDir,
  removeLocalEdit,
  shouldRefreshAfterSync,
  unsyncedLocalEdits,
  upsertLocalEdit,
} from './localEdits.ts';

function edit(overrides: Partial<LocalEditInfo> = {}): LocalEditInfo {
  return {
    id: 'e1',
    profile_id: 'p1',
    remote_path: '/etc/nginx/nginx.conf',
    file_name: 'nginx.conf',
    status: 'synced',
    message: null,
    last_synced_at: null,
    ...overrides,
  };
}

describe('local edits', () => {
  it('upserts in place and appends new sessions', () => {
    const list = [edit(), edit({ id: 'e2' })];
    const updated = upsertLocalEdit(list, edit({ status: 'uploading' }));
    assert.deepEqual(updated.map((e) => [e.id, e.status]), [['e1', 'uploading'], ['e2', 'synced']]);
    assert.equal(list[0].status, 'synced', 'input list is not mutated');
    assert.equal(upsertLocalEdit(list, edit({ id: 'e3' })).length, 3);
  });

  it('removes sessions by id', () => {
    assert.deepEqual(removeLocalEdit([edit(), edit({ id: 'e2' })], 'e1').map((e) => e.id), ['e2']);
  });

  it('lists unsynced sessions, optionally for one profile', () => {
    const list = [
      edit({ id: 'a', status: 'conflict' }),
      edit({ id: 'b', status: 'error', profile_id: 'p2' }),
      edit({ id: 'c' }),
      edit({ id: 'd', status: 'uploading' }),
    ];
    assert.deepEqual(unsyncedLocalEdits(list).map((e) => e.id), ['a', 'b', 'd']);
    assert.deepEqual(unsyncedLocalEdits(list, 'p2').map((e) => e.id), ['b']);
  });

  it('returns the first conflict that was not postponed', () => {
    const list = [edit({ id: 'a', status: 'conflict' }), edit({ id: 'b', status: 'conflict' })];
    assert.equal(pendingConflict(list, [])?.id, 'a');
    assert.equal(pendingConflict(list, ['a'])?.id, 'b');
    assert.equal(pendingConflict(list, ['a', 'b']), null);
    assert.equal(pendingConflict([edit()], []), null);
  });

  it('computes the parent directory of remote paths', () => {
    assert.equal(remoteParentDir('/etc/nginx/nginx.conf'), '/etc/nginx');
    assert.equal(remoteParentDir('/file.txt'), '/');
    assert.equal(remoteParentDir('file.txt'), '/');
  });

  it('refreshes the listing only after an upload in the visible directory', () => {
    const uploading = edit({ status: 'uploading' });
    const synced = edit({ status: 'synced' });
    assert.equal(shouldRefreshAfterSync(uploading, synced, 'p1', '/etc/nginx'), true);
    assert.equal(shouldRefreshAfterSync(uploading, synced, 'p1', '/etc/nginx/'), true);
    assert.equal(shouldRefreshAfterSync(uploading, synced, 'p1', '/etc'), false);
    assert.equal(shouldRefreshAfterSync(uploading, synced, 'p2', '/etc/nginx'), false);
    assert.equal(shouldRefreshAfterSync(synced, synced, 'p1', '/etc/nginx'), false);
    assert.equal(shouldRefreshAfterSync(undefined, synced, 'p1', '/etc/nginx'), false);
  });

  it('builds a close warning only when sessions exist', () => {
    assert.equal(closeSessionsWarning([]), null);
    const single = closeSessionsWarning([edit()]);
    assert.ok(single?.startsWith('1 fichier est'));
    assert.ok(!single?.includes('⚠️'));
    const withLoss = closeSessionsWarning([edit(), edit({ id: 'b', status: 'error' })]);
    assert.ok(withLoss?.startsWith('2 fichiers sont'));
    assert.ok(withLoss?.includes('1 fichier a des modifications non envoyées'));
  });
});
