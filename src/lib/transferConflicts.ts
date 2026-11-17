/**
 * Helpers for detecting and resolving destination conflicts before transfers are enqueued.
 */
import type { TransferItem } from '../types';

export type TransferRequest = Pick<TransferItem, 'direction' | 'localPath' | 'remotePath' | 'fileName'>;

export interface ConflictPrompt {
  fileName: string;
  direction: TransferItem['direction'];
  destinationDir: string;
  /** Number of other conflicts still pending in the same batch. */
  otherConflicts: number;
}

export type ConflictChoice = 'replace' | 'skip' | 'keepBoth';

export interface ConflictDecision {
  choice: ConflictChoice;
  /** Apply the same choice to every remaining conflict of the batch. */
  applyToAll: boolean;
}

/** Splits a local or remote path into its parent directory and its last segment. */
export function splitPath(path: string): { dir: string; name: string } {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (idx < 0) return { dir: '', name: path };
  let dir = path.substring(0, idx);
  if (dir === '') dir = path[idx]; // root: "/file" -> "/"
  else if (/^[A-Za-z]:$/.test(dir)) dir = `${dir}\\`; // "C:\file" -> "C:\"
  return { dir, name: path.substring(idx + 1) };
}

/** Joins a directory and a name, reusing the separator style of the directory. */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/**
 * Set of names already present in a directory. Local filesystems on the supported platforms
 * (macOS APFS, Windows NTFS) are case-insensitive by default, remote ones are not.
 */
export class NameSet {
  private readonly names = new Set<string>();
  private readonly caseInsensitive: boolean;

  constructor(caseInsensitive: boolean, initial: Iterable<string> = []) {
    this.caseInsensitive = caseInsensitive;
    for (const n of initial) this.add(n);
  }

  private key(name: string): string {
    return this.caseInsensitive ? name.toLowerCase() : name;
  }

  has(name: string): boolean {
    return this.names.has(this.key(name));
  }

  add(name: string): void {
    this.names.add(this.key(name));
  }
}

/**
 * Returns `name` suffixed with " (n)" before its extension, using the first free n.
 * "report.pdf" -> "report (1).pdf", ".env" -> ".env (1)", "archive" -> "archive (1)".
 */
export function nextAvailableName(name: string, taken: NameSet): string {
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0; // a leading dot is a hidden file, not an extension
  const base = hasExt ? name.substring(0, dot) : name;
  const ext = hasExt ? name.substring(dot) : '';
  for (let n = 1; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export const destinationOf = (r: Pick<TransferRequest, 'direction' | 'localPath' | 'remotePath'>) =>
  r.direction === 'upload' ? r.remotePath : r.localPath;

export interface PlanDeps {
  /** Names already taken in a destination directory. */
  loadTaken: (direction: TransferRequest['direction'], dir: string) => Promise<NameSet>;
  /** Asks the user how to resolve one conflict; `null` cancels the batch. */
  ask: (prompt: ConflictPrompt) => Promise<ConflictDecision | null>;
}

/**
 * Resolves destination conflicts for a batch, asking the user when needed.
 * Returns the requests to enqueue (possibly renamed), or `null` if the batch was cancelled.
 */
export async function planTransferBatch(
  requests: TransferRequest[],
  deps: PlanDeps
): Promise<TransferRequest[] | null> {
  const takenByDir = new Map<string, NameSet>();
  const keyOf = (r: TransferRequest) => `${r.direction}:${splitPath(destinationOf(r)).dir}`;
  for (const r of requests) {
    const key = keyOf(r);
    if (!takenByDir.has(key)) {
      takenByDir.set(key, await deps.loadTaken(r.direction, splitPath(destinationOf(r)).dir));
    }
  }
  const conflicts = (r: TransferRequest) => takenByDir.get(keyOf(r))!.has(splitPath(destinationOf(r)).name);

  const planned: TransferRequest[] = [];
  let choiceForAll: ConflictChoice | null = null;

  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    const { dir, name } = splitPath(destinationOf(request));
    const taken = takenByDir.get(keyOf(request))!;

    if (!taken.has(name)) {
      taken.add(name);
      planned.push(request);
      continue;
    }

    let choice: ConflictChoice | null = choiceForAll;
    if (!choice) {
      const decision = await deps.ask({
        fileName: name,
        direction: request.direction,
        destinationDir: dir,
        otherConflicts: requests.slice(i + 1).filter(conflicts).length,
      });
      if (!decision) return null;
      choice = decision.choice;
      if (decision.applyToAll) choiceForAll = choice;
    }

    if (choice === 'skip') continue;
    if (choice === 'replace') {
      planned.push(request);
      continue;
    }

    const newName = nextAvailableName(name, taken);
    taken.add(newName);
    const newDest = joinPath(dir, newName);
    planned.push(
      request.direction === 'upload'
        ? { ...request, remotePath: newDest, fileName: newName }
        : { ...request, localPath: newDest, fileName: newName }
    );
  }
  return planned;
}
