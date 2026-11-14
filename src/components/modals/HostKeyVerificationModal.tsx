import React, { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { HostKeyPromptRequest, HostKeyDecision } from '../../types';
import { storageApi, isTauri } from '../../services/storageApi';
import { ShieldCheck, ShieldAlert, Copy, Check, X, AlertTriangle, KeyRound } from 'lucide-react';

export const HostKeyVerificationModal: React.FC = () => {
  const [prompt, setPrompt] = useState<HostKeyPromptRequest | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (!isTauri()) return;

    let unlistenFn: (() => void) | undefined;

    listen<HostKeyPromptRequest>('ssh:host-key-prompt', (event) => {
      setPrompt(event.payload);
      setCopied(false);
      setIsSubmitting(false);
    }).then((cleanup) => {
      unlistenFn = cleanup;
    });

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, []);

  const handleDecision = async (decision: HostKeyDecision) => {
    if (!prompt || isSubmitting) return;
    setIsSubmitting(true);

    try {
      await storageApi.respondHostKeyPrompt(prompt.request_id, decision);
    } catch (err) {
      console.error('Failed to respond to host key prompt:', err);
    } finally {
      setIsSubmitting(false);
      setPrompt(null);
    }
  };

  const handleCopyFingerprint = () => {
    if (!prompt?.fingerprint) return;
    navigator.clipboard.writeText(prompt.fingerprint);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!prompt) return null;

  const isNew = prompt.is_new;

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
              <span
                className={`text-[11px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-full border ${
                  isNew
                    ? 'bg-sky-500/10 text-sky-400 border-sky-500/30'
                    : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                }`}
              >
                {isNew ? 'Nouvel hôte SSH détecté' : 'Alerte de sécurité critique'}
              </span>
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
                    prompt.changed_line ?? 'inconnue'
                  } dans ~/.ssh/known_hosts. Quelqu'un tente peut-être d'intercepter votre connexion ou la machine a été réinstallée.`}
            </p>
          </div>
        </div>

        {/* Server & Fingerprint Card */}
        <div className="p-6 space-y-4 overflow-y-auto">
          <div className="bg-[#0a0b0f] border border-border-subtle rounded-xl p-4 space-y-3 font-mono text-xs">
            <div className="flex items-center justify-between pb-2.5 border-b border-border-subtle/60">
              <span className="text-zinc-500 font-sans font-medium text-[11px]">Serveur distant</span>
              <span className="text-zinc-200 font-semibold font-mono">
                {prompt.host}:{prompt.port}
              </span>
            </div>

            <div className="flex items-center justify-between pb-2.5 border-b border-border-subtle/60">
              <span className="text-zinc-500 font-sans font-medium text-[11px]">Algorithme de clé</span>
              <span className="text-sky-400 font-mono font-medium flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5" />
                {prompt.key_type}
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
                {prompt.fingerprint}
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
