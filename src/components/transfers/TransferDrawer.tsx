import React from 'react';
import { useOrbitStore } from '../../store/useOrbitStore';
import { formatBytes } from '../../lib/utils';
import { collapsedIndicatorLabel, isGroupSettled, summarizeGroup } from '../../lib/transferGroups';
import type { TransferGroup, TransferItem } from '../../types';
import {
  ArrowUpRight,
  ArrowDownLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Pause,
  Play,
  Square,
  Cloud,
  Server,
  Trash2,
  AlertTriangle,
  Folder,
  Loader2,
} from 'lucide-react';

const GroupRow: React.FC<{
  group: TransferGroup;
  files: TransferItem[];
  onCancel: () => void;
  onPause: () => void;
  onResume: () => void;
}> = ({
  group,
  files,
  onCancel,
  onPause,
  onResume,
}) => {
  const [showFailures, setShowFailures] = React.useState(false);
  const s = summarizeGroup(group, files);
  const failedFiles = s.filesFailed > 0 ? files.filter((f) => f.status === 'failed') : [];
  const progress =
    s.totalBytes > 0
      ? Math.min(100, Math.round((s.bytesTransferred / s.totalBytes) * 100))
      : s.status === 'completed'
      ? 100
      : 0;
  const canCancel = s.status === 'scanning' || s.status === 'queued' || s.status === 'transferring' || s.status === 'paused';

  return (
    <div className="p-2.5 rounded bg-surface-muted/50 border border-border-subtle flex flex-col gap-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {group.direction === 'upload' ? (
            <ArrowUpRight className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
          ) : (
            <ArrowDownLeft className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />
          )}
          <Folder className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
          <span className="font-medium text-zinc-200 truncate">{group.name}</span>
          {group.serverName && (
            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-mono text-zinc-400 bg-white/[0.05] border border-border-subtle flex-shrink-0">
              {group.serverType === 's3' ? (
                <Cloud className="w-3 h-3 text-amber-400/80" />
              ) : (
                <Server className="w-3 h-3 text-sky-400/80" />
              )}
              <span>{group.serverName}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="font-mono text-[11px] text-zinc-400">
            {s.status === 'scanning' && (
              <span className="flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Analyse du dossier…
              </span>
            )}
            {s.status === 'completed' && (
              <span className="flex items-center gap-1 text-emerald-400">
                <CheckCircle2 className="w-3 h-3" /> Terminé · {s.filesTotal} fichier{s.filesTotal > 1 ? 's' : ''}
              </span>
            )}
            {s.status === 'failed' && (
              <span className="flex items-center gap-1 text-red-400 font-medium" title={group.error}>
                <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                <span className="truncate max-w-[220px]">
                  {group.error
                    ? `Échec : ${group.error}`
                    : `${s.filesFailed} échec${s.filesFailed > 1 ? 's' : ''} sur ${s.filesTotal} fichiers`}
                </span>
              </span>
            )}
            {s.status === 'cancelled' && <span className="text-zinc-500 line-through">Arrêté</span>}
            {(s.status === 'transferring' || s.status === 'queued' || s.status === 'paused') && (
              <span className="flex items-center gap-1.5">
                <span>
                  {s.filesDone} / {s.filesTotal} fichiers
                </span>
                <span className="text-zinc-500">•</span>
                <span>{formatBytes(s.bytesTransferred)} / {formatBytes(s.totalBytes)}</span>
                <span className="text-zinc-500">•</span>
                <span className="text-white font-semibold">{progress}%</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 border-l border-border-subtle pl-2">
            {(s.status === 'transferring' || (s.status === 'queued' && !group.paused)) && (
              <button
                onClick={onPause}
                className="p-1 rounded hover:bg-amber-500/20 text-zinc-400 hover:text-amber-300 transition-colors"
                title="Mettre en pause le dossier"
              >
                <Pause className="w-3 h-3" />
              </button>
            )}
            {(s.status === 'paused' || group.paused) && (
              <button
                onClick={onResume}
                className="p-1 rounded hover:bg-emerald-500/20 text-zinc-400 hover:text-emerald-300 transition-colors"
                title="Reprendre le transfert du dossier"
              >
                <Play className="w-3 h-3" />
              </button>
            )}
            {canCancel && (
              <button
                onClick={onCancel}
                className="p-1 rounded hover:bg-red-500/20 text-zinc-400 hover:text-red-400 transition-colors"
                title="Arrêter le transfert du dossier"
              >
                <Square className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="w-full bg-black/40 h-1.5 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${
            s.status === 'completed'
              ? 'bg-emerald-500'
              : s.status === 'failed'
              ? 'bg-red-500'
              : s.status === 'cancelled' || s.status === 'scanning'
              ? 'bg-zinc-600'
              : 'bg-indigo-500'
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>

      {failedFiles.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            onClick={() => setShowFailures((v) => !v)}
            className="self-start flex items-center gap-1 text-[11px] text-red-400/90 hover:text-red-300 transition-colors"
          >
            {showFailures ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {failedFiles.length} fichier{failedFiles.length > 1 ? 's' : ''} en échec
          </button>
          {showFailures && (
            <ul className="max-h-24 overflow-y-auto pl-4 space-y-0.5 font-mono text-[11px]">
              {failedFiles.map((f) => (
                <li
                  key={f.id}
                  className="truncate text-zinc-400"
                  title={`${f.direction === 'upload' ? f.localPath : f.remotePath}${f.error ? `\n${f.error}` : ''}`}
                >
                  <span className="text-zinc-200">{f.fileName}</span>
                  {f.error && <span className="text-red-400/80"> : {f.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export const TransferDrawer: React.FC = () => {
  const {
    transfers,
    isTransferDrawerOpen,
    setTransferDrawerOpen,
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    clearCompletedTransfers,
    transferGroups,
    pauseTransferGroup,
    resumeTransferGroup,
    cancelTransferGroup,
  } = useOrbitStore();

  if (!isTransferDrawerOpen && transfers.length === 0 && transferGroups.length === 0) return null;

  // Indexed once per render: every progress event re-renders the drawer.
  const childrenByGroup = new Map<string, TransferItem[]>();
  for (const t of transfers) {
    if (!t.groupId) continue;
    const list = childrenByGroup.get(t.groupId);
    if (list) list.push(t);
    else childrenByGroup.set(t.groupId, [t]);
  }
  const noChildren: TransferItem[] = [];
  const childrenOf = (groupId: string) => childrenByGroup.get(groupId) ?? noChildren;
  const scanningCount = transferGroups.filter((g) => g.phase === 'scanning').length;

  const runningTransfers = transfers.filter((t) => t.status === 'transferring');
  const pendingTransfers = transfers.filter(
    (t) => t.status === 'transferring' || t.status === 'queued' || t.status === 'paused'
  );
  const queuedCount = transfers.filter((t) => t.status === 'queued').length;
  const totalSpeed = runningTransfers.reduce((acc, t) => acc + t.speedBps, 0);

  // Floating indicator when collapsed
  if (!isTransferDrawerOpen) {
    if (pendingTransfers.length === 0 && scanningCount === 0) return null;
    const firstActive = pendingTransfers[0] ?? transferGroups.find((g) => g.phase === 'scanning');
    return (
      <div
        onClick={() => setTransferDrawerOpen(true)}
        className="fixed bottom-3 right-6 z-40 bg-surface border border-border-light shadow-xl rounded-lg px-4 py-2.5 flex items-center gap-3 cursor-pointer hover:bg-surface-hover transition-all"
      >
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
        <div className="text-xs">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-white">
              {collapsedIndicatorLabel(runningTransfers.length, queuedCount, scanningCount)}
              {queuedCount > 0 && <span className="text-zinc-400 font-normal"> · {queuedCount} en attente</span>}
            </span>
            {firstActive?.serverName && (
              <span className="text-[10px] text-zinc-400 bg-white/5 border border-border-subtle px-1.5 py-0.2 rounded font-mono truncate max-w-[140px]">
                {firstActive.serverName}
              </span>
            )}
          </div>
          {runningTransfers.length > 0 && (
            <span className="text-zinc-400 font-mono text-[11px]">
              {formatBytes(totalSpeed)}/s
            </span>
          )}
        </div>
      </div>
    );
  }

  const hasFinishedTransfers =
    transfers.some((t) => !t.groupId && (t.status === 'completed' || t.status === 'cancelled' || t.status === 'failed')) ||
    transferGroups.some((g) => isGroupSettled(g, childrenOf(g.id)));

  return (
    <div className="border-t border-border-subtle bg-surface/95 backdrop-blur-xl flex flex-col z-30 shadow-2xl transition-all max-h-64">
      {/* Drawer Header */}
      <div className="h-9 px-4 flex items-center justify-between border-b border-border-subtle bg-surface-muted/60 select-none">
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-semibold text-white">Transferts de fichiers</span>
          <span className="text-[11px] font-mono text-zinc-400 bg-white/5 border border-border-subtle px-2 py-0.5 rounded">
            {formatBytes(totalSpeed)}/s
          </span>
          {queuedCount > 0 && (
            <span className="text-[11px] text-zinc-400">{queuedCount} en attente</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {hasFinishedTransfers && (
            <button
              onClick={clearCompletedTransfers}
              className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 px-2 py-0.5 rounded hover:bg-white/5 transition-colors"
              title="Effacer les transferts terminés ou arrêtés"
            >
              <Trash2 className="w-3 h-3" />
              <span>Nettoyer</span>
            </button>
          )}
          <button
            onClick={() => setTransferDrawerOpen(false)}
            className="p-1 rounded hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
            title="Réduire"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Transfers List */}
      <div className="overflow-y-auto p-2 space-y-2 max-h-52">
        {transferGroups.map((group) => (
          <GroupRow
            key={group.id}
            group={group}
            files={childrenOf(group.id)}
            onCancel={() => cancelTransferGroup(group.id)}
            onPause={() => pauseTransferGroup(group.id)}
            onResume={() => resumeTransferGroup(group.id)}
          />
        ))}
        {transfers.filter((tx) => !tx.groupId).map((tx) => {
          const progress = Math.min(100, Math.round((tx.bytesTransferred / (tx.totalBytes || 1)) * 100));

          return (
            <div
              key={tx.id}
              className="p-2.5 rounded bg-surface-muted/50 border border-border-subtle flex flex-col gap-2 text-xs"
            >
              {/* Top row: File info + Server Name badge */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {tx.direction === 'upload' ? (
                    <ArrowUpRight className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                  ) : (
                    <ArrowDownLeft className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />
                  )}
                  <span className="font-medium text-zinc-200 truncate">{tx.fileName}</span>

                  {/* Server Badge */}
                  {tx.serverName && (
                    <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-mono text-zinc-400 bg-white/[0.05] border border-border-subtle flex-shrink-0">
                      {tx.serverType === 's3' ? (
                        <Cloud className="w-3 h-3 text-amber-400/80" />
                      ) : (
                        <Server className="w-3 h-3 text-sky-400/80" />
                      )}
                      <span>{tx.serverName}</span>
                    </span>
                  )}
                </div>

                {/* Status / Metric + Control Buttons */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <div className="font-mono text-[11px] text-zinc-400">
                    {tx.status === 'completed' && (
                      <span className="flex items-center gap-1 text-emerald-400">
                        <CheckCircle2 className="w-3 h-3" /> Terminé
                      </span>
                    )}
                    {tx.status === 'failed' && (
                      <span
                        className="flex items-center gap-1 text-red-400 font-medium"
                        title={tx.error}
                      >
                        <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate max-w-[200px]">
                          Échec{tx.error ? ` : ${tx.error}` : ''}
                        </span>
                      </span>
                    )}
                    {tx.status === 'paused' && (
                      <span className="text-amber-400 font-medium">En pause</span>
                    )}
                    {tx.status === 'cancelled' && (
                      <span className="text-zinc-500 line-through">Arrêté</span>
                    )}
                    {tx.status === 'queued' && (
                      <span className="text-zinc-400">En attente</span>
                    )}
                    {tx.status === 'transferring' && (
                      <span className="flex items-center gap-1.5">
                        <span>{formatBytes(tx.bytesTransferred)} / {formatBytes(tx.totalBytes)}</span>
                        <span className="text-zinc-500">•</span>
                        <span className="text-white font-semibold">{progress}%</span>
                      </span>
                    )}
                  </div>

                  {/* Transfer Controls: Pause, Resume, Stop */}
                  <div className="flex items-center gap-1 border-l border-border-subtle pl-2">
                    {tx.status === 'transferring' && (
                      <button
                        onClick={() => pauseTransfer(tx.id)}
                        className="p-1 rounded hover:bg-amber-500/20 text-zinc-400 hover:text-amber-300 transition-colors"
                        title="Mettre en pause"
                      >
                        <Pause className="w-3 h-3" />
                      </button>
                    )}

                    {tx.status === 'paused' && (
                      <button
                        onClick={() => resumeTransfer(tx.id)}
                        className="p-1 rounded hover:bg-emerald-500/20 text-zinc-400 hover:text-emerald-300 transition-colors"
                        title="Reprendre"
                      >
                        <Play className="w-3 h-3" />
                      </button>
                    )}

                    {(tx.status === 'transferring' || tx.status === 'paused' || tx.status === 'queued') && (
                      <button
                        onClick={() => cancelTransfer(tx.id)}
                        className="p-1 rounded hover:bg-red-500/20 text-zinc-400 hover:text-red-400 transition-colors"
                        title="Arrêter le transfert"
                      >
                        <Square className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Progress Bar */}
              <div className="w-full bg-black/40 h-1.5 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    tx.status === 'completed'
                      ? 'bg-emerald-500'
                      : tx.status === 'failed'
                      ? 'bg-red-500'
                      : tx.status === 'paused'
                      ? 'bg-amber-500'
                      : tx.status === 'cancelled' || tx.status === 'queued'
                      ? 'bg-zinc-600'
                      : 'bg-indigo-500'
                  }`}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
