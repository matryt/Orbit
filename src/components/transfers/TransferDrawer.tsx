import React from 'react';
import { useOrbitStore } from '../../store/useOrbitStore';
import { formatBytes } from '../../lib/utils';
import { ArrowUpRight, ArrowDownLeft, CheckCircle2, ChevronDown } from 'lucide-react';

export const TransferDrawer: React.FC = () => {
  const { transfers, isTransferDrawerOpen, setTransferDrawerOpen } = useOrbitStore();

  if (!isTransferDrawerOpen && transfers.length === 0) return null;

  const activeTransfers = transfers.filter((t) => t.status === 'transferring' || t.status === 'queued');
  const totalSpeed = activeTransfers.reduce((acc, t) => acc + t.speedBps, 0);

  if (!isTransferDrawerOpen) {
    if (activeTransfers.length === 0) return null;
    return (
      <div
        onClick={() => setTransferDrawerOpen(true)}
        className="fixed bottom-3 right-6 z-40 bg-surface border border-border-light shadow-xl rounded-lg px-4 py-2.5 flex items-center gap-3 cursor-pointer hover:bg-surface-hover transition-all"
      >
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
        <div className="text-xs">
          <span className="font-semibold text-white">{activeTransfers.length} transfert(s) en cours</span>
          <span className="text-zinc-400 ml-2 font-mono text-[11px]">
            {formatBytes(totalSpeed)}/s
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-border-subtle bg-surface/95 backdrop-blur-xl flex flex-col z-30 shadow-2xl transition-all max-h-56">
      {/* Drawer Header */}
      <div className="h-9 px-4 flex items-center justify-between border-b border-border-subtle bg-surface-muted/60 select-none">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-white">Transferts de fichiers</span>
          <span className="text-[11px] font-mono text-zinc-400 bg-white/5 px-2 py-0.5 rounded">
            {formatBytes(totalSpeed)}/s
          </span>
        </div>
        <div className="flex items-center gap-1">
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
      <div className="overflow-y-auto p-2 space-y-1.5 max-h-44">
        {transfers.map((tx) => {
          const progress = Math.min(100, Math.round((tx.bytesTransferred / (tx.totalBytes || 1)) * 100));
          return (
            <div
              key={tx.id}
              className="p-2 rounded bg-surface-muted/40 border border-border-subtle flex flex-col gap-1.5 text-xs"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  {tx.direction === 'upload' ? (
                    <ArrowUpRight className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                  ) : (
                    <ArrowDownLeft className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />
                  )}
                  <span className="font-medium text-zinc-200 truncate">{tx.fileName}</span>
                </div>

                <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-400 flex-shrink-0">
                  {tx.status === 'completed' ? (
                    <span className="flex items-center gap-1 text-emerald-400">
                      <CheckCircle2 className="w-3 h-3" /> Terminé
                    </span>
                  ) : (
                    <>
                      <span>{formatBytes(tx.bytesTransferred)} / {formatBytes(tx.totalBytes)}</span>
                      <span className="text-zinc-500">•</span>
                      <span className="text-white">{progress}%</span>
                    </>
                  )}
                </div>
              </div>

              {/* Progress Bar */}
              <div className="w-full bg-black/40 h-1.5 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    tx.status === 'completed'
                      ? 'bg-emerald-500'
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
