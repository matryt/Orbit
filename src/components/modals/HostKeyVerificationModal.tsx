import React, { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { HostKeyPromptRequest, HostKeyDecision } from '../../types';
import { storageApi, isTauri } from '../../services/storageApi';
import { ShieldCheck, ShieldAlert, Copy, Check, X, AlertTriangle, KeyRound, AlertCircle } from 'lucide-react';

export const HostKeyVerificationModal: React.FC = () => {
  const [prompts, setPrompts] = useState<HostKeyPromptRequest[]>([]);
  const [copied, setCopied] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const currentPrompt = prompts[0] || null;

  useEffect(() => {
    if (!isTauri()) return;

    let unlistenPrompt: (() => void) | undefined;
    let unlistenExpired: (() => void) | undefined;

    // Buffer initial pending prompts in case connection started before listener attached
    storageApi
      .getPendingHostKeyPrompts()
      .then((pending) => {
        if (pending && pending.length > 0) {
          setPrompts((prev) => {
            const existingIds = new Set(prev.map((p) => p.request_id));
            const newPrompts = pending.filter((p) => !existingIds.has(p.request_id));
            return [...prev, ...newPrompts];
          });
        }
      })
      .catch((err) => {
        console.error('Failed to get pending host key prompts:', err);
      });

    listen<HostKeyPromptRequest>('ssh:host-key-prompt', (event) => {
      setPrompts((prev) => {
        if (prev.some((p) => p.request_id === event.payload.request_id)) {
          return prev;
        }
        return [...prev, event.payload];
      });
      setCopied(false);
      setSubmitError(null);
    }).then((cleanup) => {
      unlistenPrompt = cleanup;
    });

    listen<{ request_id: string }>('ssh:host-key-expired', (event) => {
      setPrompts((prev) => prev.filter((p) => p.request_id !== event.payload.request_id));
    }).then((cleanup) => {
      unlistenExpired = cleanup;
    });

    return () => {
      if (unlistenPrompt) unlistenPrompt();
      if (unlistenExpired) unlistenExpired();
    };
  }, []);

  // Escape key handler to reject the active prompt
  useEffect(() => {
    if (!currentPrompt) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleDecision('reject');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentPrompt, isSubmitting]);

  const handleDecision = async (decision: HostKeyDecision) => {
    if (!currentPrompt || isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const delivered = await storageApi.respondHostKeyPrompt(currentPrompt.request_id, decision);
      if (delivered) {
        // Enlève uniquement la requête dont la décision a abouti
        setPrompts((prev) => prev.filter((p) => p.request_id !== currentPrompt.request_id));
        setCopied(false);
      } else {
        setSubmitError("La requête a expiré ou n'a pas pu être délivrée. Veuillez réessayer.");
      }
    } catch (err: any) {
      console.error('Failed to respond to host key prompt:', err);
      setSubmitError(
        err?.message || "Échec de l'envoi de la décision. La fenêtre reste ouverte pour vous permettre de réessayer."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCopyFingerprint = () => {
    if (!currentPrompt?.fingerprint) return;
    navigator.clipboard.writeText(currentPrompt.fingerprint);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!currentPrompt) return null;

  const isNew = currentPrompt.is_new;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-150"
      onClick={() => handleDecision('reject')}
    >
      <div
        className={`w-full max-w-xl bg-[#11131a] border rounded-2xl shadow-2xl flex flex-col overflow-hidden max-h-[90vh] ${
          isNew ? 'border-sky-500/30' : 'border-rose-500/40'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className={`px-6 py-5 border-b flex items-start gap-4 ${
            isNew
              ? 'bg-sky-950/20 border-sky-500/20'
              : 'bg-rose-950/30 border-rose-500/20'
          }`}
        >
          <div
            className={`p-3 rounded-xl border flex-shrink-0 ${
              isNew
                ? 'bg-sky-500/10 border-sky-500/30 text-sky-400'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-400 animate-pulse'
            }`}
          >
            {isNew ? (
              <ShieldCheck className="w-7 h-7" />
            ) : (
              <ShieldAlert className="w-7 h-7" />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className={`text-[11px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-full border ${
                    isNew
                      ? 'bg-sky-500/10 text-sky-400 border-sky-500/30'
                      : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                  }`}
                >
                  {isNew ? 'Nouvel hôte SSH détecté' : 'Alerte de sécurité critique'}
                </span>
                {prompts.length > 1 && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-white/10 text-zinc-300">
                    1 sur {prompts.length}
                  </span>
                )}
              </div>
              <button
                disabled={isSubmitting}
                onClick={() => handleDecision('reject')}
                className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
                title="Refuser et fermer (Échap)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <h3 className="text-base font-semibold text-white mt-1.5 leading-snug">
              {isNew
                ? "L'authenticité de cet hôte ne peut être établie"
                : "La clé d'hôte a changé (Possible attaque MITM) !"}
            </h3>

            <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
              {isNew
                ? "Ce serveur n'est pas encore enregistré dans votre fichier known_hosts. Vérifiez l'empreinte avant d'envoyer vos identifiants."
                : `La clé présentée par le serveur diffère de celle enregistrée à la ligne ${
                    currentPrompt.changed_line ?? 'inconnue'
                  } dans ~/.ssh/known_hosts. Quelqu'un tente peut-être d'intercepter votre connexion ou la machine a été réinstallée.`}
            </p>
          </div>
        </div>

        {/* Server & Fingerprint Card */}
        <div className="p-6 space-y-4 overflow-y-auto">
          {submitError && (
            <div className="flex items-center gap-2 p-3 bg-rose-950/40 border border-rose-500/30 rounded-xl text-xs text-rose-300">
              <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0" />
              <p className="flex-1">{submitError}</p>
            </div>
          )}

          <div className="bg-[#0a0b0f] border border-border-subtle rounded-xl p-4 space-y-3 font-mono text-xs">
            <div className="flex items-center justify-between pb-2.5 border-b border-border-subtle/60">
              <span className="text-zinc-500 font-sans font-medium text-[11px]">Serveur distant</span>
              <span className="text-zinc-200 font-semibold font-mono">
                {currentPrompt.host}:{currentPrompt.port}
              </span>
            </div>

            <div className="flex items-center justify-between pb-2.5 border-b border-border-subtle/60">
              <span className="text-zinc-500 font-sans font-medium text-[11px]">Algorithme de clé</span>
              <span className="text-sky-400 font-mono font-medium flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5" />
                {currentPrompt.key_type}
              </span>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-zinc-500 font-sans font-medium text-[11px]">
                  Empreinte SHA-256
                </span>
                <button
                  type="button"
                  onClick={handleCopyFingerprint}
                  className="inline-flex items-center gap-1 text-[11px] font-sans text-sky-400 hover:text-sky-300 transition-colors"
                >
                  {copied ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span className="text-emerald-400 font-medium">Copié</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Copier</span>
                    </>
                  )}
                </button>
              </div>

              <div className="p-2.5 bg-black/50 border border-border-subtle rounded-lg text-emerald-400 select-all break-all leading-relaxed text-[11px]">
                {currentPrompt.fingerprint}
              </div>
            </div>
          </div>

          {!isNew && (
            <div className="flex items-start gap-2.5 p-3.5 bg-rose-950/20 border border-rose-500/20 rounded-xl text-xs text-rose-300">
              <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                Si vous ne savez pas précisément pourquoi cette clé a changé,{' '}
                <strong className="text-rose-200 font-semibold">annulez immédiatement la connexion</strong> et
                contactez l'administrateur de ce serveur.
              </p>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 bg-surface-muted/40 border-t border-border-subtle flex flex-col sm:flex-row items-center justify-end gap-2.5">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => handleDecision('reject')}
            className={`w-full sm:w-auto px-4 py-2 text-xs font-medium rounded-lg transition-colors ${
              !isNew
                ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-600/20'
                : 'text-zinc-400 hover:text-white hover:bg-white/5 border border-border-subtle'
            }`}
          >
            {!isNew ? 'Annuler la connexion (Recommandé)' : 'Refuser et annuler'}
          </button>

          {isNew && (
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => handleDecision('accept_once')}
              className="w-full sm:w-auto px-4 py-2 text-xs font-medium rounded-lg text-zinc-300 hover:text-white bg-zinc-800/80 hover:bg-zinc-700/80 border border-border-light transition-colors"
            >
              Cette session uniquement
            </button>
          )}

          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => handleDecision('accept_and_remember')}
            className={`w-full sm:w-auto px-4 py-2 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
              isNew
                ? 'bg-sky-500 hover:bg-sky-400 text-white shadow-lg shadow-sky-500/20 font-semibold'
                : 'bg-amber-600 hover:bg-amber-500 text-white border border-amber-500/30'
            }`}
          >
            {isNew
              ? 'Toujours approuver et mémoriser'
              : "Remplacer l'ancienne clé et continuer"}
          </button>
        </div>
      </div>
    </div>
  );
};
