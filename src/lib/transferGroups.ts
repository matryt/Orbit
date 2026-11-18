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

const lastSegment = (relative: string) => relative.substring(relative.lastIndexOf('/') + 1);

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
  const join = (root: string, relative: string, remote: boolean) =>
    remote ? joinPath(root, relative, true) : joinPath(root, relative);

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
