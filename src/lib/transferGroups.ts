import type { TransferGroup, TransferItem, WalkEntry } from '../types';
import { joinPath } from './transferConflicts.ts';
import type { TransferRequest } from './transferConflicts.ts';
import { isFinishedStatus } from './transferQueue.ts';

export type GroupStatus =
  | 'scanning'
  | 'queued'
  | 'transferring'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface GroupSummary {
  status: GroupStatus;
  filesTotal: number;
  filesDone: number;
  filesFailed: number;
  bytesTransferred: number;
  totalBytes: number;
  speedBps: number;
}

/** Aggregates the files of a folder transfer into a single drawer row. */
export function summarizeGroup(
  group: Pick<TransferGroup, 'phase'>,
  children: Pick<TransferItem, 'status' | 'bytesTransferred' | 'totalBytes' | 'speedBps'>[]
): GroupSummary {
  const count = (s: TransferItem['status']) => children.filter((c) => c.status === s).length;
  const filesDone = count('completed');
  const filesFailed = count('failed');
  const summary: Omit<GroupSummary, 'status'> = {
    filesTotal: children.length,
    filesDone,
    filesFailed,
    bytesTransferred: children.reduce(
      (acc, c) => acc + (c.status === 'completed' ? Math.max(c.bytesTransferred, c.totalBytes) : c.bytesTransferred),
      0
    ),
    totalBytes: children.reduce((acc, c) => acc + c.totalBytes, 0),
    speedBps: children.filter((c) => c.status === 'transferring').reduce((acc, c) => acc + c.speedBps, 0),
  };

  let status: GroupStatus;
  if (group.phase === 'scanning') status = 'scanning';
  else if (group.phase === 'failed') status = 'failed';
  else if (count('transferring') > 0) status = 'transferring';
  else if (count('queued') > 0) status = group.phase === 'cancelled' ? 'cancelled' : 'queued';
  else if (count('paused') > 0) status = 'paused';
  else if (group.phase === 'cancelled' || count('cancelled') > 0) status = 'cancelled';
  else if (filesFailed > 0) status = 'failed';
  else status = 'completed';

  return { ...summary, status };
}

/** True once nothing in the group is running or waiting (safe to clear from the drawer). */
export function isGroupSettled(
  group: Pick<TransferGroup, 'phase'>,
  children: Pick<TransferItem, 'status' | 'inFlight'>[]
): boolean {
  if (group.phase === 'scanning') return false;
  return children.every((c) => isFinishedStatus(c.status) && !c.inFlight);
}

/**
 * Which listing shows the destination of a finished transfer, if it is on screen: the remote
 * one only while its profile is still active, the local one only in dual-pane mode.
 */
export function listingToRefresh(
  direction: TransferItem['direction'],
  profileId: string | null | undefined,
  view: { activeProfileId: string; isDualPane: boolean }
): 'remote' | 'local' | null {
  if (direction === 'upload') return view.activeProfileId === profileId ? 'remote' : null;
  return view.isDualPane ? 'local' : null;
}

/** Whether a folder transfer must go through the conflict planner before being enqueued. */
export function needsConflictPlanning(direction: TransferItem['direction'], destExists: boolean): boolean {
  // An existing folder can hold conflicting files. A download into a new folder can still
  // collide with itself: remote names differing only by case land on the same local file.
  return destExists || direction === 'download';
}

/** Main label of the collapsed transfer indicator. */
export function collapsedIndicatorLabel(running: number, queued: number, scanning: number): string {
  // Only folder scans in progress: "0 transfert(s) en cours" would look like an idle queue.
  if (running === 0 && queued === 0 && scanning > 0) {
    return `Analyse de ${scanning} dossier${scanning > 1 ? 's' : ''}…`;
  }
  return `${running} transfert(s) en cours`;
}

type SettledTransfer = Pick<TransferItem, 'id' | 'groupId' | 'status'>;

/**
 * Whether the listing should be refreshed once `tx` has settled (`tx.status` is final).
 * `transfers` is the queue after that update.
 */
export function shouldRefreshAfterSettle(tx: SettledTransfer, transfers: SettledTransfer[]): boolean {
  if (tx.groupId === undefined) return tx.status === 'completed';
  // Inside a folder transfer, refresh once when its last file settles (whatever its outcome)
  // rather than per file, provided at least one file of the folder made it.
  const siblings = transfers.filter((t) => t.groupId === tx.groupId && t.id !== tx.id);
  if (siblings.some((t) => !isFinishedStatus(t.status))) return false;
  return tx.status === 'completed' || siblings.some((t) => t.status === 'completed');
}

const lastSegment =(relative: string) => relative.substring(relative.lastIndexOf('/') + 1);

/**
 * Destination of the folder itself (`destDir/name`), or `null` when `name` is not a plain
 * folder name.
 */
export function folderDestination(
  direction: TransferItem['direction'],
  destDir: string,
  name: string
): string | null {
  const remoteDest = direction === 'upload';
  // Names can come from the server (e.g. an S3 prefix `../`): `..` or a separator would make
  // the transfer write outside `destDir`. Backslash is a separator on Windows destinations.
  const unsafe =
    name === '' || name === '.' || name === '..' || name.includes('/') || (!remoteDest && name.includes('\\'));
  return unsafe ? null : joinPath(destDir, name, remoteDest);
}

/**
 * Walk entries that are a file and a directory at the same destination path. S3 allows a key
 * `index` next to keys under `index/`; such a folder cannot be reproduced, so it is rejected
 * before anything is created. Downloads compare case-insensitively (local disks, see NameSet).
 */
export function findFileDirCollisions(direction: TransferItem['direction'], entries: WalkEntry[]): string[] {
  const norm = (p: string) => (direction === 'download' ? p.toLowerCase() : p);
  const dirs = new Set(entries.filter((e) => e.is_dir).map((e) => norm(e.relative_path)));
  return entries.filter((e) => !e.is_dir && dirs.has(norm(e.relative_path))).map((e) => e.relative_path);
}

/**
 * Builds the per-file transfer requests and the directories to create for a folder transfer.
 * `sourceRoot` / `destRoot` are the folder itself on each side; walk entries are relative to
 * `sourceRoot`. Remote paths always use `/`, local ones keep their platform style.
 */
export function planFolderTransfer(
  direction: TransferItem['direction'],
  sourceRoot: string,
  destRoot: string,
  entries: WalkEntry[],
  groupId: string
): { dirsToCreate: string[]; requests: (TransferRequest & { groupId: string; totalBytes: number })[] } {
  const remoteDest = direction === 'upload';
  const join = (root: string, relative: string, remote: boolean) => {
    if (remote) return joinPath(root, relative, true);
    // Walk entries use `/`. Below a Windows root, and notably an extended-length `\\?\` one
    // where `/` is not a separator, every segment must be joined with `\`.
    const windowsRoot = root.includes('\\') && !root.includes('/');
    return joinPath(root, windowsRoot ? relative.split('/').join('\\') : relative);
  };

  const dirsToCreate = [
    destRoot,
    ...entries
      .filter((e) => e.is_dir)
      .map((e) => e.relative_path)
      // Parents before children.
      .sort((a, b) => a.split('/').length - b.split('/').length)
      .map((rel) => join(destRoot, rel, remoteDest)),
  ];

  const requests = entries
    .filter((e) => !e.is_dir)
    .map((e) => {
      const src = join(sourceRoot, e.relative_path, !remoteDest);
      const dest = join(destRoot, e.relative_path, remoteDest);
      return {
        direction,
        localPath: remoteDest ? src : dest,
        remotePath: remoteDest ? dest : src,
        fileName: lastSegment(e.relative_path),
        groupId,
        totalBytes: e.size,
      };
    });

  return { dirsToCreate, requests };
}
