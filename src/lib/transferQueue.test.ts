import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyProgress, generateTransferId, pickTransfersToStart } from './transferQueue.ts';
import type { TransferItem } from '../types/index.ts';

const item = (id: string, status: TransferItem['status']): TransferItem => ({
  id,
  fileName: id,
  remotePath: `/${id}`,
  localPath: `/tmp/${id}`,
  direction: 'upload',
  bytesTransferred: 0,
  totalBytes: 100,
  speedBps: 0,
  status,
});

test('starts the oldest queued transfers first (list is newest-first)', () => {
  const transfers = [item('c', 'queued'), item('b', 'queued'), item('a', 'queued')];
  assert.deepEqual(pickTransfersToStart(transfers, 2), ['a', 'b']);
});

test('respects running transfers when computing free slots', () => {
  const transfers = [item('d', 'queued'), item('c', 'queued'), item('b', 'transferring'), item('a', 'transferring')];
  assert.deepEqual(pickTransfersToStart(transfers, 3), ['c']);
});

test('paused transfers keep their slot', () => {
  const transfers = [item('b', 'queued'), item('a', 'paused')];
  assert.deepEqual(pickTransfersToStart(transfers, 1), []);
  assert.deepEqual(pickTransfersToStart(transfers, 2), ['b']);
});

test('skips queued transfers belonging to paused groups', () => {
  const transfers = [
    { ...item('c', 'queued'), groupId: 'g-active' },
    { ...item('b', 'queued'), groupId: 'g-paused' },
    { ...item('a', 'queued'), groupId: 'g-paused' },
  ];
  const paused = new Set(['g-paused']);
  assert.deepEqual(pickTransfersToStart(transfers, 2, paused), ['c']);
});

test('returns nothing when the queue is full', () => {
  const transfers = [item('b', 'queued'), item('a', 'transferring')];
  assert.deepEqual(pickTransfersToStart(transfers, 1), []);
});

test('ignores finished and cancelled transfers', () => {
  const transfers = [item('c', 'cancelled'), item('b', 'failed'), item('a', 'completed')];
  assert.deepEqual(pickTransfersToStart(transfers, 3), []);
});

test('applyProgress keeps a user-set paused status and zeroes speed', () => {
  const next = applyProgress(item('a', 'paused'), {
    bytes_transferred: 40,
    total_bytes: 100,
    speed_bps: 999,
    status: 'transferring',
  });
  assert.equal(next.status, 'paused');
  assert.equal(next.speedBps, 0);
  assert.equal(next.bytesTransferred, 40);
});

test('applyProgress marks completion', () => {
  const next = applyProgress(item('a', 'transferring'), {
    bytes_transferred: 100,
    total_bytes: 100,
    speed_bps: 0,
    status: 'completed',
  });
  assert.equal(next.status, 'completed');
});

test('applyProgress ignores late events on cancelled transfers', () => {
  const tx = item('a', 'cancelled');
  const next = applyProgress(tx, { bytes_transferred: 50, total_bytes: 100, speed_bps: 10, status: 'transferring' });
  assert.equal(next, tx);
});

test('generateTransferId is unique within the same millisecond', () => {
  const ids = new Set(Array.from({ length: 50 }, () => generateTransferId()));
  assert.equal(ids.size, 50);
});

test('never starts two writers on the same destination', () => {
  const running = { ...item('a', 'transferring'), remotePath: '/same.txt', profileId: 'p1' };
  const queued = { ...item('b', 'queued'), remotePath: '/same.txt', profileId: 'p1' };
  const other = { ...item('c', 'queued'), profileId: 'p1' };
  assert.deepEqual(pickTransfersToStart([other, queued, running], 3), ['c']);
});

test('only one of two queued transfers to the same destination starts', () => {
  const first = { ...item('a', 'queued'), remotePath: '/same.txt' };
  const second = { ...item('b', 'queued'), remotePath: '/same.txt' };
  assert.deepEqual(pickTransfersToStart([second, first], 3), ['a']);
});

test('same remote path on different profiles is not a collision', () => {
  const a = { ...item('a', 'transferring'), remotePath: '/same.txt', profileId: 'p1' };
  const b = { ...item('b', 'queued'), remotePath: '/same.txt', profileId: 'p2' };
  assert.deepEqual(pickTransfersToStart([b, a], 3), ['b']);
});

test('local destinations ignore separator style', () => {
  const running = { ...item('a', 'transferring'), direction: 'download' as const, localPath: 'C:\\Downloads\\a.txt' };
  const queued = { ...item('b', 'queued'), direction: 'download' as const, localPath: 'C:\\Downloads/a.txt' };
  assert.deepEqual(pickTransfersToStart([queued, running], 3), []);
});

test('a cancelled transfer still stopping keeps its destination reserved', () => {
  const stopping = { ...item('a', 'cancelled'), remotePath: '/same.txt', inFlight: true };
  const queued = { ...item('b', 'queued'), remotePath: '/same.txt' };
  assert.deepEqual(pickTransfersToStart([queued, stopping], 3), []);
  assert.deepEqual(pickTransfersToStart([queued, { ...stopping, inFlight: false }], 3), ['b']);
});

test('transfers cancelled upon session disconnect are never scheduled', () => {
  // Simulate queue where profile 'p1' was disconnected: queued/paused items become cancelled
  const disconnectedTx1 = { ...item('tx1', 'cancelled'), profileId: 'p1' };
  const disconnectedTx2 = { ...item('tx2', 'cancelled'), profileId: 'p1' };
  const otherSessionTx = { ...item('tx3', 'queued'), profileId: 'p2' };

  const scheduled = pickTransfersToStart([otherSessionTx, disconnectedTx2, disconnectedTx1], 3);
  assert.deepEqual(scheduled, ['tx3']);
});
