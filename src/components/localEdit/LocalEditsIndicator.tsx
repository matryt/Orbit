import React, { useEffect, useRef, useState } from 'react';
import { CloudAlert, CloudCheck, CloudUpload, FilePen, Loader2, RotateCw, X } from 'lucide-react';
import { useOrbitStore } from '../../store/useOrbitStore';
import { unsyncedLocalEdits } from '../../lib/localEdits';
import type { LocalEditInfo } from '../../types';
import { formatDate } from '../../lib/utils';
import { ask } from '@tauri-apps/plugin-dialog';

const STATUS_LABEL: Record<LocalEditInfo['status'], string> = {
  synced: 'Synchronisé',
  uploading: 'Envoi…',
  conflict: 'Conflit',
  error: 'Erreur',
};

function StatusIcon({ status }: { status: LocalEditInfo['status'] }) {
  switch (status) {
    case 'synced':
      return <CloudCheck className="w-3.5 h-3.5 text-emerald-400" />;
    case 'uploading':
      return <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin" />;
    case 'conflict':
      return <CloudAlert className="w-3.5 h-3.5 text-amber-400" />;
    case 'error':
      return <CloudAlert className="w-3.5 h-3.5 text-red-400" />;
  }
}

/** Header pill listing the files opened in a local editor. */
export const LocalEditsIndicator: React.FC = () => {
  const { localEdits, profiles, openLocalEdit, resolveLocalEdit, closeLocalEdit, activeProfileId } = useOrbitStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  if (localEdits.length === 0) return null;

  const problems = unsyncedLocalEdits(localEdits).filter((e) => e.status !== 'uploading').length;
  const uploading = localEdits.some((e) => e.status === 'uploading');
  const pillClass = problems > 0
    ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
    : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium transition-colors hover:brightness-125 ${pillClass}`}
        title="Fichiers en édition locale"
      >
        {uploading ? <CloudUpload className="w-3 h-3 animate-pulse" /> : <FilePen className="w-3 h-3" />}
        <span className="font-mono">{localEdits.length}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-50 w-80 bg-[#141722]/95 backdrop-blur-xl border border-white/10 rounded-lg shadow-2xl py-1 text-xs text-zinc-300">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
            Édition locale — envoi à chaque enregistrement
          </div>
          {localEdits.map((edit) => {
            const profileName = profiles.find((p) => p.id === edit.profile_id)?.name ?? edit.profile_id;
            const canReopen = edit.profile_id === activeProfileId;
            return (
              <div key={edit.id} className="px-3 py-2 border-t border-white/5">
                <div className="flex items-center gap-2 min-w-0">
                  <StatusIcon status={edit.status} />
                  <span className="truncate font-medium text-zinc-200" title={edit.remote_path}>
                    {edit.file_name}
                  </span>
                  <span className="ml-auto text-[10px] text-zinc-500 flex-shrink-0">{STATUS_LABEL[edit.status]}</span>
                </div>
                <div className="mt-0.5 text-[10px] text-zinc-500 truncate font-mono" title={`${profileName} : ${edit.remote_path}`}>
                  {profileName} : {edit.remote_path}
                </div>
                {edit.message && (
                  <div className={`mt-1 text-[11px] ${edit.status === 'synced' ? 'text-zinc-400' : 'text-amber-300'}`}>
                    {edit.message}
                  </div>
                )}
                {edit.last_synced_at && edit.status === 'synced' && !edit.message && (
                  <div className="mt-0.5 text-[10px] text-zinc-500">Dernier envoi : {formatDate(edit.last_synced_at)}</div>
                )}
                <div className="mt-1.5 flex items-center gap-1.5">
                  {canReopen && (
                    <button
                      type="button"
                      onClick={() => openLocalEdit(edit.remote_path)}
                      className="flex items-center gap-1 px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 transition-colors"
                    >
                      <FilePen className="w-3 h-3" /> Rouvrir
                    </button>
                  )}
                  {edit.status === 'error' && (
                    <button
                      type="button"
                      onClick={() => resolveLocalEdit(edit.id, 'retry')}
                      className="flex items-center gap-1 px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 transition-colors"
                    >
                      <RotateCw className="w-3 h-3" /> Réessayer
                    </button>
                  )}
                  {edit.status === 'conflict' && (
                    <>
                      <button
                        type="button"
                        onClick={() => resolveLocalEdit(edit.id, 'reload')}
                        className="px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 transition-colors"
                      >
                        Recharger
                      </button>
                      <button
                        type="button"
                        onClick={() => resolveLocalEdit(edit.id, 'overwrite')}
                        className="px-2 py-0.5 rounded bg-amber-600/80 hover:bg-amber-500 text-white transition-colors"
                      >
                        Écraser
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={async () => {
                      if (
                        edit.status !== 'synced' &&
                        !(await ask('Les modifications non envoyées de ce fichier seront perdues. Terminer quand même ?', {
                          title: 'Terminer l\'édition locale',
                          kind: 'warning',
                          okLabel: 'Terminer',
                          cancelLabel: 'Annuler',
                        }))
                      ) {
                        return;
                      }
                      closeLocalEdit(edit.id);
                    }}
                    className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
                    title="Arrêter la synchronisation et supprimer la copie locale"
                  >
                    <X className="w-3 h-3" /> Terminer
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
