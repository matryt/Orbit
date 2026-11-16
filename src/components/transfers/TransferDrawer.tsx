import React from 'react';
import { useOrbitStore } from '../../store/useOrbitStore';
import { formatBytes } from '../../lib/utils';
import {
  ArrowUpRight,
  ArrowDownLeft,
  CheckCircle2,
  ChevronDown,
  Pause,
  Play,
  Square,
  Cloud,
  Server,
  Trash2,
  AlertTriangle,
} from 'lucide-react';

export const TransferDrawer: React.FC = () => {
  const {
    transfers,
    isTransferDrawerOpen,
    setTransferDrawerOpen,
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    clearCompletedTransfers,
  } = useOrbitStore();

  if (!isTransferDrawerOpen && transfers.length === 0) return null;

  const activeTransfers = transfers.filter((t) => t.status === 'transferring' || t.status === 'queued');
  const totalSpeed = activeTransfers.reduce((acc, t) => acc + t.speedBps, 0);

  // Floating indicator when collapsed
  if (!isTransferDrawerOpen) {
    if (activeTransfers.length === 0) return null;
    const firstActive = activeTransfers[0];
    return (
      <div
        onClick={() => setTransferDrawerOpen(true)}
        className="fixed bottom-3 right-6 z-40 bg-surface border border-border-light shadow-xl rounded-lg px-4 py-2.5 flex items-center gap-3 cursor-pointer hover:bg-surface-hover transition-all"
      >
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
        <div className="text-xs">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-white">{activeTransfers.length} transfert(s) en cours</span>
            {firstActive.serverName && (
              <span className="text-[10px] text-zinc-400 bg-white/5 border border-border-subtle px-1.5 py-0.2 rounded font-mono truncate max-w-[140px]">
                {firstActive.serverName}
              </span>
            )}
          </div>
          <span className="text-zinc-400 font-mono text-[11px]">
            {formatBytes(totalSpeed)}/s
          </span>
        </div>
      </div>
    );
  }

  const hasFinishedTransfers = transfers.some(
    (t) => t.status === 'completed' || t.status === 'cancelled' || t.status === 'failed'
  );

  return (
    <div className="border-t border-border-subtle bg-surface/95 backdrop-blur-xl flex flex-col z-30 shadow-2xl transition-all max-h-64">
      {/* Drawer Header */}
      <div className="h-9 px-4 flex items-center justify-between border-b border-border-subtle bg-surface-muted/60 select-none">
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-semibold text-white">Transferts de fichiers</span>
          <span className="text-[11px] font-mono text-zinc-400 bg-white/5 border border-border-subtle px-2 py-0.5 rounded">
            {formatBytes(totalSpeed)}/s
          </span>
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
        {transfers.map((tx) => {
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
                    {(tx.status === 'transferring' || tx.status === 'queued') && (
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

                    {(tx.status === 'transferring' || tx.status === 'paused') && (
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
                      : tx.status === 'cancelled'
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
