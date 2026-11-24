import React, { useEffect, useState } from 'react';
import { useOrbitStore } from '../../store/useOrbitStore';
import { APP_VERSION } from '../../version';
import { isTauri } from '../../services/storageApi';
import { SnoozeDuration, isUpdateSnoozed, normalizeVersion } from '../../lib/updateSnooze';
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
  ChevronDown,
  RotateCw,
  BellOff,
} from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { type as getOsType } from '@tauri-apps/plugin-os';

type InstallPhase =
  | { kind: 'idle' }
  | { kind: 'downloading'; downloaded: number; total: number | null }
  | { kind: 'installing' }
  /** `version` is the release actually installed, which a later check may have superseded. */
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string };

// The check only fetches latest.json; the download timeout bounds the whole transfer,
// so it must leave room for slow connections.
const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

const SNOOZE_OPTIONS: { duration: SnoozeDuration; label: string }[] = [
  { duration: '1h', label: 'Dans 1 heure' },
  { duration: '24h', label: 'Dans 24 heures' },
  { duration: '7d', label: 'Dans 7 jours' },
  { duration: 'version', label: 'Ignorer cette version' },
];

const formatBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
};

const isWindows = () => {
  try {
    return getOsType() === 'windows';
  } catch {
    return false;
  }
};

export const UpdateModal: React.FC = () => {
  const {
    isUpdateModalOpen,
    setUpdateModalOpen,
    availableUpdate,
    isCheckingUpdate,
    updateCheckError,
    checkForUpdates,
    dismissUpdate,
    snoozeUpdate,
    updateSnooze,
    clearUpdateSnooze,
    transfers,
    setInstallingUpdate,
  } = useOrbitStore();

  const [phase, setPhase] = useState<InstallPhase>({ kind: 'idle' });
  const [isSnoozeMenuOpen, setSnoozeMenuOpen] = useState(false);

  const isBusy = phase.kind === 'downloading' || phase.kind === 'installing';

  // Suspend background checks while installing so they cannot replace the progress view.
  useEffect(() => {
    setInstallingUpdate(isBusy);
  }, [isBusy, setInstallingUpdate]);

  // Reset transient UI each time the prompt reopens, unless an install already finished.
  useEffect(() => {
    if (!isUpdateModalOpen) {
      setSnoozeMenuOpen(false);
      setPhase((p) => (p.kind === 'ready' ? p : { kind: 'idle' }));
    }
  }, [isUpdateModalOpen]);

  if (!isUpdateModalOpen) return null;

  // Cancelled transfers may still be stopping in the backend (`inFlight`): count them too.
  const activeTransferCount = transfers.filter(
    (t) => t.status === 'queued' || t.status === 'transferring' || t.status === 'paused' || t.inFlight,
  ).length;
  // A newer release found after an install must not be presented as the installed one.
  const installedVersion = phase.kind === 'ready' ? phase.version : null;
  const newerThanInstalled =
    installedVersion !== null &&
    !!availableUpdate?.has_update &&
    normalizeVersion(availableUpdate.latest_version) !== installedVersion;
  const snoozedForThisVersion =
    !!availableUpdate?.has_update &&
    isUpdateSnoozed(updateSnooze, availableUpdate.latest_version, Date.now());

  const handleOpenLink = async (url: string) => {
    try {
      await openUrl(url);
    } catch {
      window.open(url, '_blank');
    }
  };

  // Fallback path: open the installer in the browser, as before in-app updates existed.
  const handleDownload = async () => {
    if (!availableUpdate) return;
    const url = availableUpdate.download_url || availableUpdate.release_url;
    await handleOpenLink(url);
    // Record the dismissal so hourly checks do not reopen the prompt for this release.
    dismissUpdate();
  };

  const handleInstall = async () => {
    if (!availableUpdate || isBusy) return;
    if (!isTauri()) {
      await handleDownload();
      return;
    }

    setSnoozeMenuOpen(false);
    setPhase({ kind: 'downloading', downloaded: 0, total: null });
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check({ timeout: CHECK_TIMEOUT_MS });
      if (!update) {
        // GitHub lists a newer release but its signed updater manifest is missing.
        setPhase({
          kind: 'error',
          message: "Cette version ne propose pas encore de mise à jour intégrée. Téléchargez-la manuellement.",
        });
        return;
      }

      let downloaded = 0;
      let total: number | null = null;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? null;
            setPhase({ kind: 'downloading', downloaded: 0, total });
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            setPhase({ kind: 'downloading', downloaded, total });
            break;
          case 'Finished':
            setPhase({ kind: 'installing' });
            break;
        }
      }, { timeout: DOWNLOAD_TIMEOUT_MS });
      setPhase({ kind: 'ready', version: normalizeVersion(update.version) });
    } catch (err: unknown) {
      console.warn('In-app update failed:', err);
      const message = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      setPhase({ kind: 'error', message: message || "L'installation de la mise à jour a échoué." });
    }
  };

  const handleRelaunch = async () => {
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (err: unknown) {
      console.warn('Relaunch failed:', err);
      setPhase({ kind: 'error', message: 'Redémarrage impossible. Relancez Orbit manuellement.' });
    }
  };

  const handleClose = () => {
    if (isBusy) return;
    dismissUpdate();
  };

  const handleSnooze = (duration: SnoozeDuration) => {
    setSnoozeMenuOpen(false);
    snoozeUpdate(duration);
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
            onClick={handleClose}
            disabled={isBusy}
            className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1">
          {isCheckingUpdate && phase.kind === 'idle' ? (
            <div className="py-12 flex flex-col items-center justify-center gap-3 text-center">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
              <p className="text-sm text-zinc-300">Recherche de mise à jour sur GitHub...</p>
            </div>
          ) : updateCheckError && phase.kind === 'idle' ? (
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
          ) : availableUpdate && (availableUpdate.has_update || phase.kind !== 'idle') ? (
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

              {phase.kind === 'downloading' && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-zinc-400">
                    <span>Téléchargement de la mise à jour…</span>
                    <span className="font-mono">
                      {formatBytes(phase.downloaded)}
                      {phase.total ? ` / ${formatBytes(phase.total)}` : ''}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className={`h-full bg-indigo-500 transition-all ${phase.total ? '' : 'w-1/3 animate-pulse'}`}
                      style={phase.total ? { width: `${Math.min(100, (phase.downloaded / phase.total) * 100)}%` } : undefined}
                    />
                  </div>
                </div>
              )}

              {phase.kind === 'installing' && (
                <div className="flex items-center gap-2 text-xs text-zinc-300">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                  <span>Installation en cours…</span>
                </div>
              )}

              {phase.kind === 'ready' && (
                <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2 text-xs text-emerald-300">
                  <CheckCircle className="w-4 h-4 flex-shrink-0" />
                  <span>
                    Orbit <span className="font-mono">v{phase.version}</span> est installée. Redémarrez Orbit pour
                    l'appliquer.
                    {newerThanInstalled && (
                      <span className="block mt-1 text-emerald-300/70">
                        Une version plus récente ({availableUpdate.latest_version}) est sortie depuis : elle vous sera
                        proposée après le redémarrage.
                      </span>
                    )}
                  </span>
                </div>
              )}

              {phase.kind === 'error' && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-2 text-xs text-red-300">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span className="break-words">{phase.message}</span>
                </div>
              )}

              {activeTransferCount > 0 && (phase.kind === 'ready' || (phase.kind === 'idle' && isWindows())) && (
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-2 text-xs text-amber-300">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    {activeTransferCount} transfert{activeTransferCount > 1 ? 's' : ''} en cours ou en attente
                    {activeTransferCount > 1 ? ' seront interrompus' : ' sera interrompu'}
                    {phase.kind === 'ready' ? ' au redémarrage.' : " : Orbit se fermera pendant l'installation."}
                  </span>
                </div>
              )}

              {snoozedForThisVersion && phase.kind === 'idle' && updateSnooze && (
                <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-500">
                  <span className="flex items-center gap-1.5">
                    <BellOff className="w-3.5 h-3.5" />
                    {updateSnooze.until === 'never'
                      ? 'Rappels désactivés pour cette version.'
                      : `Rappels désactivés jusqu'au ${new Date(updateSnooze.until).toLocaleString('fr-FR', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}.`}
                  </span>
                  <button
                    type="button"
                    onClick={clearUpdateSnooze}
                    className="text-zinc-400 hover:text-white underline-offset-2 hover:underline transition-colors"
                  >
                    Réactiver
                  </button>
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
                  v{availableUpdate?.current_version || APP_VERSION}
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
            {phase.kind === 'ready' ? (
              <>
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-3.5 py-1.5 rounded-lg hover:bg-white/10 text-xs text-zinc-300 hover:text-white transition-colors"
                >
                  Plus tard
                </button>
                <button
                  type="button"
                  onClick={handleRelaunch}
                  className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium flex items-center gap-1.5 shadow-lg shadow-indigo-600/20 transition-all"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                  <span>Redémarrer maintenant</span>
                </button>
              </>
            ) : !availableUpdate?.has_update && phase.kind === 'idle' ? (
              <button
                type="button"
                onClick={() => setUpdateModalOpen(false)}
                className="px-3.5 py-1.5 rounded-lg hover:bg-white/10 text-xs text-zinc-300 hover:text-white transition-colors"
              >
                Fermer
              </button>
            ) : (
              <>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setSnoozeMenuOpen((open) => !open)}
                    disabled={isBusy}
                    aria-haspopup="menu"
                    aria-expanded={isSnoozeMenuOpen}
                    className="px-3 py-1.5 rounded-lg hover:bg-white/10 text-xs text-zinc-300 hover:text-white flex items-center gap-1 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                  >
                    <span>Plus tard</span>
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                  {isSnoozeMenuOpen && (
                    <>
                      {/* Invisible backdrop closing the menu on outside click */}
                      <div className="fixed inset-0 z-10" onClick={() => setSnoozeMenuOpen(false)} />
                      <div
                        role="menu"
                        className="absolute right-0 bottom-full mb-1.5 z-20 w-48 py-1 rounded-xl bg-[#1b1f2d] border border-white/10 shadow-2xl"
                      >
                        {SNOOZE_OPTIONS.map(({ duration, label }) => (
                          <button
                            key={duration}
                            type="button"
                            role="menuitem"
                            onClick={() => handleSnooze(duration)}
                            className={`w-full text-left px-3 py-1.5 text-xs hover:bg-white/10 transition-colors ${
                              duration === 'version' ? 'text-zinc-400 border-t border-white/5 mt-1 pt-2' : 'text-zinc-200'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {phase.kind === 'error' ? (
                  <button
                    type="button"
                    onClick={handleDownload}
                    className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium flex items-center gap-1.5 shadow-lg shadow-indigo-600/20 transition-all"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Télécharger manuellement</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleInstall}
                    disabled={isBusy}
                    className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium flex items-center gap-1.5 shadow-lg shadow-indigo-600/20 transition-all disabled:opacity-60 disabled:pointer-events-none"
                  >
                    {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                    <span>{isBusy ? 'Mise à jour…' : 'Mettre à jour'}</span>
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
