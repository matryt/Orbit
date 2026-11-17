import React, { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { useOrbitStore } from '../../store/useOrbitStore';
import type { ConflictChoice } from '../../lib/transferConflicts';

export const TransferConflictModal: React.FC = () => {
  const { transferConflict, resolveTransferConflict } = useOrbitStore();
  const [applyToAll, setApplyToAll] = useState(false);

  // Each new prompt starts unchecked.
  useEffect(() => {
    setApplyToAll(false);
  }, [transferConflict]);

  useEffect(() => {
    if (!transferConflict) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        resolveTransferConflict(null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [transferConflict, resolveTransferConflict]);

  if (!transferConflict) return null;

  const { fileName, direction, destinationDir, otherConflicts } = transferConflict;
  const choose = (choice: ConflictChoice) =>
    resolveTransferConflict({ choice, applyToAll: applyToAll && otherConflicts > 0 });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-[#161926] border border-amber-500/30 rounded-xl shadow-2xl p-5 text-zinc-200"
      >
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 flex-shrink-0">
            <Copy className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white">Le fichier existe déjà</h3>
            <p className="text-xs text-zinc-400 truncate font-mono mt-0.5" title={fileName}>
              {fileName}
            </p>
          </div>
        </div>

        <p className="text-xs text-zinc-400 mb-4 bg-white/5 p-2.5 rounded-lg border border-white/5">
          Un élément portant ce nom existe déjà {direction === 'upload' ? 'sur le serveur' : 'en local'} dans{' '}
          <span className="font-mono text-zinc-300 break-all">{destinationDir}</span>.
        </p>

        {otherConflicts > 0 && (
          <label className="flex items-center gap-2 mb-4 text-xs text-zinc-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
              className="accent-amber-500"
            />
            Appliquer aux {otherConflicts} autre{otherConflicts > 1 ? 's' : ''} conflit{otherConflicts > 1 ? 's' : ''}
          </label>
        )}

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => resolveTransferConflict(null)}
            className="px-3 py-1.5 rounded-md hover:bg-white/10 text-xs text-zinc-400 hover:text-white transition-colors"
            title="Annuler tout le lot de transferts (Échap)"
          >
            Tout annuler
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => choose('skip')}
              className="px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 border border-border-subtle text-xs text-zinc-200 transition-colors"
            >
              Ignorer
            </button>
            <button
              type="button"
              onClick={() => choose('keepBoth')}
              className="px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 border border-border-subtle text-xs text-zinc-200 transition-colors"
            >
              Garder les deux
            </button>
            <button
              type="button"
              onClick={() => choose('replace')}
              className="px-3.5 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium transition-colors shadow-sm shadow-amber-900/50"
            >
              Remplacer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
