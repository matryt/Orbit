import type { TransferItem } from '../types';

/** Maximum number of transfers running at the same time. */
export const MAX_CONCURRENT_TRANSFERS = 3;

export type TransferStatus = TransferItem['status'];

/**
 * Number of occupied slots. A paused transfer keeps its slot: on the Rust side it still holds
 * its resources (SFTP handle, S3 stream), and resuming it must never exceed the limit.
 */
export function countRunning(transfers: Pick<TransferItem, 'status'>[]): number {
  return transfers.filter((t) => t.status === 'transferring' || t.status === 'paused').length;
}

type SchedulableTransfer = Pick<TransferItem, 'id' | 'status' | 'direction' | 'remotePath' | 'localPath'> &
  Partial<Pick<TransferItem, 'profileId' | 'inFlight'>>;

/**
 * Identifies the file a transfer writes. Local paths are compared case-insensitively
 * (APFS / NTFS defaults) and with `\\` and `/` treated alike (Windows accepts both);
 * remote paths are kept as-is and scoped to their profile.
 */
export function destinationKey(tx: SchedulableTransfer): string {
  return tx.direction === 'upload'
    ? `up:${tx.profileId ?? ''}:${tx.remotePath}`
    : `down:${tx.localPath.replace(/\\/g, '/').toLowerCase()}`;
}

/** A destination is busy while a transfer is active on it or its backend call has not returned. */
const holdsDestination = (t: SchedulableTransfer) =>
  t.inFlight === true || t.status === 'transferring' || t.status === 'paused';

/**
 * Returns the ids of queued transfers to start, in FIFO order.
 * The store list is ordered newest first, so it is walked backwards.
 * A queued transfer whose destination is held by another transfer (active, or cancelled but
 * still stopping on the backend) waits for it: there is never more than one writer per destination.
 */
export function pickTransfersToStart(
  transfers: SchedulableTransfer[],
  maxConcurrent: number = MAX_CONCURRENT_TRANSFERS
): string[] {
  let freeSlots = Math.max(0, maxConcurrent - countRunning(transfers));
  if (freeSlots === 0) return [];

  const busy = new Set(transfers.filter(holdsDestination).map(destinationKey));
  const ids: string[] = [];
  for (let i = transfers.length - 1; i >= 0 && freeSlots > 0; i--) {
    const tx = transfers[i];
    if (tx.status !== 'queued') continue;
    const key = destinationKey(tx);
    if (busy.has(key)) continue;
    busy.add(key);
    ids.push(tx.id);
    freeSlots--;
  }
  return ids;
}

export function isFinishedStatus(status: TransferStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Merges a backend progress event into a transfer.
 * The backend only drives the status for completion: pause/resume/cancel are user actions
 * and must not be overwritten by a late event.
 */
export function applyProgress<T extends TransferItem>(
  tx: T,
  p: { bytes_transferred: number; total_bytes: number; speed_bps: number; status: string }
): T {
  if (isFinishedStatus(tx.status)) return tx;
  return {
    ...tx,
    bytesTransferred: p.bytes_transferred,
    totalBytes: p.total_bytes,
    speedBps: tx.status === 'paused' || p.status === 'paused' ? 0 : p.speed_bps,
    status: p.status === 'completed' ? 'completed' : tx.status,
  };
}

let transferCounter = 0;

export function generateTransferId(): string {
  transferCounter += 1;
  return `tx-${Date.now().toString(36)}-${transferCounter}`;
}
