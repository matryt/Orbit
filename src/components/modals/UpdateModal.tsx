import React from 'react';
import { useOrbitStore } from '../../store/useOrbitStore';
import {
  Rocket,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  Download,
  X,
  Loader2,
  Calendar,
  Sparkles,
} from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';

export const UpdateModal: React.FC = () => {
  const {
    isUpdateModalOpen,
    setUpdateModalOpen,
    availableUpdate,
    isCheckingUpdate,
    updateCheckError,
    checkForUpdates,
  } = useOrbitStore();

  if (!isUpdateModalOpen) return null;

  const handleOpenLink = async (url: string) => {
    try {
      await openUrl(url);
    } catch {
      window.open(url, '_blank');
    }
  };

  const handleDownload = async () => {
    if (!availableUpdate) return;
    const url = availableUpdate.download_url || availableUpdate.release_url;
    await handleOpenLink(url);
    setUpdateModalOpen(false);
  };

  const formatDate = (isoString?: string | null) => {
    if (!isoString) return '';
    try {
      return new Date(isoString).toLocaleDateString('fr-FR', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch {
      return isoString;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-[#141722] border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] text-zinc-200"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between bg-surface/40">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <Rocket className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Mise à jour d'Orbit</h2>
              <p className="text-[11px] text-zinc-400">Vérification des versions GitHub</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setUpdateModalOpen(false)}
            className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1">
          {isCheckingUpdate ? (
            <div className="py-12 flex flex-col items-center justify-center gap-3 text-center">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
              <p className="text-sm text-zinc-300">Recherche de mise à jour sur GitHub...</p>
            </div>
          ) : updateCheckError ? (
            <div className="py-6 flex flex-col items-center justify-center gap-3 text-center">
              <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <h3 className="text-sm font-semibold text-white">Impossible de vérifier les mises à jour</h3>
              <p className="text-xs text-zinc-400 max-w-sm">{updateCheckError}</p>
              <button
                type="button"
                onClick={() => checkForUpdates(true)}
                className="mt-2 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs text-white font-medium transition-colors"
              >
                Réessayer
              </button>
            </div>
          ) : availableUpdate?.has_update ? (
            <div className="space-y-4">
              {/* Badge new release */}
              <div className="p-3.5 rounded-xl bg-gradient-to-r from-indigo-500/10 via-purple-500/10 to-transparent border border-indigo-500/20 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Sparkles className="w-5 h-5 text-indigo-400 flex-shrink-0" />
                  <div>
                    <div className="text-xs font-semibold text-white">
                      Nouvelle version disponible !
                    </div>
                    <div className="text-[11px] text-zinc-400">
                      Passez de{' '}
                      <span className="font-mono text-zinc-300">
                        v{availableUpdate.current_version}
                      </span>{' '}
                      à{' '}
                      <span className="font-mono text-indigo-300 font-medium">
                        {availableUpdate.latest_version}
                      </span>
                    </div>
                  </div>
                </div>
                {availableUpdate.published_at && (
                  <div className="flex items-center gap-1 text-[11px] text-zinc-400 font-mono">
                    <Calendar className="w-3.5 h-3.5 text-zinc-500" />
                    <span>{formatDate(availableUpdate.published_at)}</span>
                  </div>
                )}
              </div>

              {/* Release Notes */}
              <div>
                <div className="text-xs font-medium text-zinc-400 mb-1.5">
                  Notes de version ({availableUpdate.release_name})
                </div>
                <div className="p-3.5 rounded-xl bg-black/40 border border-white/5 text-xs text-zinc-300 font-mono whitespace-pre-wrap max-h-56 overflow-y-auto leading-relaxed">
                  {availableUpdate.release_notes || 'Aucune note de version spécifiée.'}
                </div>
              </div>

              {availableUpdate.asset_name && (
                <div className="text-[11px] text-zinc-500 flex items-center gap-1.5">
                  <Download className="w-3.5 h-3.5 text-zinc-400" />
                  <span>Fichier : {availableUpdate.asset_name}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="py-8 flex flex-col items-center justify-center gap-3 text-center">
              <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
                <CheckCircle className="w-6 h-6" />
              </div>
              <h3 className="text-sm font-semibold text-white">Orbit est à jour</h3>
              <p className="text-xs text-zinc-400">
                Vous utilisez actuellement la version la plus récente ({' '}
                <span className="font-mono text-emerald-400 font-medium">
                  v{availableUpdate?.current_version || '0.1.2'}
                </span>{' '}
                ).
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-white/10 flex items-center justify-between bg-surface/30">
          <div>
            {availableUpdate?.release_url && (
              <button
                type="button"
                onClick={() => handleOpenLink(availableUpdate.release_url)}
                className="text-xs text-zinc-400 hover:text-white flex items-center gap-1 transition-colors"
              >
                <span>Voir sur GitHub</span>
                <ExternalLink className="w-3 h-3" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setUpdateModalOpen(false)}
              className="px-3.5 py-1.5 rounded-lg hover:bg-white/10 text-xs text-zinc-300 hover:text-white transition-colors"
            >
              {availableUpdate?.has_update ? 'Plus tard' : 'Fermer'}
            </button>

            {availableUpdate?.has_update && (
              <button
                type="button"
                onClick={handleDownload}
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium flex items-center gap-1.5 shadow-lg shadow-indigo-600/20 transition-all"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Télécharger la mise à jour</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
