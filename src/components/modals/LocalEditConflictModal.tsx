import React, { useEffect } from 'react';
import { GitCompare } from 'lucide-react';
import { useOrbitStore } from '../../store/useOrbitStore';
import { pendingConflict } from '../../lib/localEdits';

/** Asks what to do when a locally edited file also changed on the server. */
export const LocalEditConflictModal: React.FC = () => {
  const { localEdits, dismissedLocalEditConflicts, resolveLocalEdit, dismissLocalEditConflict, profiles } =
    useOrbitStore();
  const conflict = pendingConflict(localEdits, dismissedLocalEditConflicts);

  useEffect(() => {
    if (!conflict) return;
    // Capture phase: keeps background shortcuts from firing while the prompt is open.
    const onKeyDown = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissLocalEditConflict(conflict.id);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [conflict, dismissLocalEditConflict]);

  if (!conflict) return null;

  const profileName = profiles.find((p) => p.id === conflict.profile_id)?.name;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-[#161926] border border-amber-500/30 rounded-xl shadow-2xl p-5 text-zinc-200"
      >
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 flex-shrink-0">
            <GitCompare className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white">Conflit d'édition</h3>
            <p className="text-xs text-zinc-400 truncate font-mono mt-0.5" title={conflict.remote_path}>
              {profileName ? `${profileName} : ` : ''}
              {conflict.remote_path}
            </p>
          </div>
        </div>

        <p className="text-xs text-zinc-400 mb-4 bg-white/5 p-2.5 rounded-lg border border-white/5">
          {conflict.message || 'Le fichier a été modifié sur le serveur depuis son ouverture.'} Votre dernier
          enregistrement n'a pas été envoyé.
        </p>

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => dismissLocalEditConflict(conflict.id)}
            className="px-3 py-1.5 rounded-md hover:bg-white/10 text-xs text-zinc-400 hover:text-white transition-colors"
            title="Décider plus tard (Échap)"
          >
            Plus tard
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => resolveLocalEdit(conflict.id, 'reload')}
              className="px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 border border-border-subtle text-xs text-zinc-200 transition-colors"
              title="Abandonner vos modifications locales et récupérer la version du serveur"
            >
              Recharger le serveur
            </button>
            <button
              type="button"
              onClick={() => resolveLocalEdit(conflict.id, 'overwrite')}
              className="px-3.5 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium transition-colors shadow-sm shadow-amber-900/50"
              title="Remplacer la version du serveur par la vôtre"
            >
              Écraser
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
