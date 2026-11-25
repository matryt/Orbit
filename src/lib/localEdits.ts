import type { LocalEditInfo } from '../types/index.ts';

/** Inserts or replaces a session, keeping the original order. */
export function upsertLocalEdit(list: LocalEditInfo[], info: LocalEditInfo): LocalEditInfo[] {
  const index = list.findIndex((e) => e.id === info.id);
  if (index === -1) return [...list, info];
  const next = list.slice();
  next[index] = info;
  return next;
}

export function removeLocalEdit(list: LocalEditInfo[], id: string): LocalEditInfo[] {
  return list.filter((e) => e.id !== id);
}

/** Sessions whose latest local content has not reached the server. */
export function unsyncedLocalEdits(list: LocalEditInfo[], profileId?: string): LocalEditInfo[] {
  return list.filter((e) => e.status !== 'synced' && (profileId === undefined || e.profile_id === profileId));
}

/** First conflict the user has not postponed, if any. */
export function pendingConflict(list: LocalEditInfo[], dismissedIds: string[]): LocalEditInfo | null {
  return list.find((e) => e.status === 'conflict' && !dismissedIds.includes(e.id)) ?? null;
}

/** Parent directory of a remote file path (`/` for top-level files). */
export function remoteParentDir(remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => (p.replace(/\/+$/, '') || '/');
  return norm(a) === norm(b);
}

/**
 * True when an upload just completed for a file shown in the current remote listing,
 * which therefore needs a refresh (size and date changed).
 */
export function shouldRefreshAfterSync(
  previous: LocalEditInfo | undefined,
  next: LocalEditInfo,
  activeProfileId: string,
  currentPath: string
): boolean {
  return (
    previous?.status === 'uploading' &&
    next.status === 'synced' &&
    next.profile_id === activeProfileId &&
    sameDir(remoteParentDir(next.remote_path), currentPath)
  );
}

/** Confirmation text before closing sessions, or `null` when nothing would be lost. */
export function closeSessionsWarning(edits: LocalEditInfo[]): string | null {
  if (edits.length === 0) return null;
  const unsynced = unsyncedLocalEdits(edits).length;
  const plural = edits.length > 1;
  let text = `${edits.length} fichier${plural ? 's' : ''} ${plural ? 'sont' : 'est'} en cours d'édition locale. ` +
    `Les enregistrements faits après la fermeture ne seront plus envoyés au serveur, et la copie locale sera supprimée.`;
  if (unsynced > 0) {
    text += `\n\n⚠️ ${unsynced} fichier${unsynced > 1 ? 's ont' : ' a'} des modifications non envoyées (conflit ou erreur) qui seront perdues.`;
  }
  return text;
}
