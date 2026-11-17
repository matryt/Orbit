import type { TransferItem } from '../types';

/** Nombre maximum de transferts exécutés simultanément. */
export const MAX_CONCURRENT_TRANSFERS = 3;

export type TransferStatus = TransferItem['status'];

/** Un transfert en pause libère son créneau : seuls les transferts actifs comptent. */
export function countRunning(transfers: Pick<TransferItem, 'status'>[]): number {
  return transfers.filter((t) => t.status === 'transferring').length;
}

/**
 * Retourne les identifiants des transferts en attente à démarrer, dans l'ordre FIFO.
 * La liste du store est ordonnée du plus récent au plus ancien : on la parcourt donc à l'envers.
 */
export function pickTransfersToStart(
  transfers: Pick<TransferItem, 'id' | 'status'>[],
  maxConcurrent: number = MAX_CONCURRENT_TRANSFERS
): string[] {
  const freeSlots = Math.max(0, maxConcurrent - countRunning(transfers));
  if (freeSlots === 0) return [];

  const ids: string[] = [];
  for (let i = transfers.length - 1; i >= 0 && ids.length < freeSlots; i--) {
    if (transfers[i].status === 'queued') ids.push(transfers[i].id);
  }
  return ids;
}

export function isFinishedStatus(status: TransferStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Fusionne un événement de progression du backend dans un transfert.
 * Le statut n'est piloté par le backend que pour la complétion : pause/reprise/annulation
 * sont des actions de l'utilisateur et ne doivent pas être écrasées par un événement en retard.
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
