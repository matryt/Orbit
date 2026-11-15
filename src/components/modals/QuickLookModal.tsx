import React, { useEffect, useState } from 'react';
import { useOrbitStore } from '../../store/useOrbitStore';
import { FileIcon } from '../explorer/FileIcon';
import { formatBytes, formatDate } from '../../lib/utils';
import { storageApi } from '../../services/storageApi';
import { X, Copy, Loader2, Folder } from 'lucide-react';

export const QuickLookModal: React.FC = () => {
  const { quickLookFile, setQuickLookFile, activeProfileId, activePane } = useOrbitStore();
  const [content, setContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (e.code === 'Space' && quickLookFile)) {
        e.preventDefault();
        setQuickLookFile(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [quickLookFile, setQuickLookFile]);

  useEffect(() => {
    if (!quickLookFile) {
      setContent('');
      return;
    }

    if (quickLookFile.is_dir) {
      setContent(`Dossier : ${quickLookFile.name}\nChemin complet : ${quickLookFile.path}\nAttributs : ${quickLookFile.permissions || 'drwxr-xr-x'}`);
      return;
    }

    let isCancelled = false;
    setIsLoading(true);

    const readPromise =
      activePane === 'local'
        ? storageApi.readLocalPreview(quickLookFile.path)
        : storageApi.readPreview(activeProfileId, quickLookFile.path);

    readPromise
      .then((res) => {
        if (!isCancelled) {
          setContent(res);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (!isCancelled) {
          const errMsg = typeof err === 'string' ? err : err?.message || JSON.stringify(err);
          setContent(`// Erreur de lecture de l'aperçu:\n// ${errMsg}`);
          setIsLoading(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [quickLookFile, activeProfileId]);

  if (!quickLookFile) return null;

  const isImage = /\.(png|jpe?g|svg|webp|gif)$/i.test(quickLookFile.name);

  return (
    <div
      onClick={() => setQuickLookFile(null)}
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md flex items-center justify-center p-6 animate-in fade-in duration-150"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-[#11131a] border border-border-light rounded-xl shadow-2xl flex flex-col overflow-hidden max-h-[80vh]"
      >
        {/* Header */}
        <div className="h-12 px-4 border-b border-border-subtle flex items-center justify-between bg-surface-muted/60 select-none">
          <div className="flex items-center gap-2.5 min-w-0">
            <FileIcon name={quickLookFile.name} isDir={quickLookFile.is_dir} className="w-5 h-5" />
            <div className="min-w-0">
              <h3 className="text-xs font-semibold text-white truncate leading-tight">
                {quickLookFile.name}
              </h3>
              <p className="text-[10px] text-zinc-500 font-mono">
                {quickLookFile.is_dir ? 'Dossier' : formatBytes(quickLookFile.size)} • {formatDate(quickLookFile.modified_at)}
                {quickLookFile.owner && ` • ${quickLookFile.owner}${quickLookFile.group ? `:${quickLookFile.group}` : ''}`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {!quickLookFile.is_dir && !isImage && (
              <button
                onClick={() => {
                  navigator.clipboard.writeText(content);
                }}
                className="p-1.5 rounded-md hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
                title="Copier le contenu"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={() => setQuickLookFile(null)}
              className="p-1.5 rounded-md hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
              title="Fermer (Échap ou Espace)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content Preview */}
        <div className="flex-1 overflow-auto p-4 bg-[#0a0b0f] font-mono text-xs text-zinc-300">
            {
              isLoading?(
            <div className = "h-48 flex items-center justify-center gap-2 text-zinc-400" >
              <Loader2 className="w-4 h-4 animate-spin text-sky-400" />
              <span>Chargement du flux d'aperçu...</span>
            </div>
        ) : quickLookFile.is_dir ? (
        <div className="flex flex-col items-center justify-center p-8 bg-black/30 rounded-lg border border-border-subtle">
          <Folder className="w-12 h-12 text-amber-400 fill-amber-400/20 mb-3" />
          <p className="text-zinc-200 text-sm font-sans font-medium">{quickLookFile.name}</p>
          <span className="text-[11px] text-zinc-500 font-mono mt-1">{quickLookFile.path}</span>
        </div>
        ) : isImage ? (
        <div className="flex flex-col items-center justify-center p-8 bg-black/30 rounded-lg border border-border-subtle">
          <div className="w-32 h-32 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 font-sans mb-3">
            <FileIcon name={quickLookFile.name} isDir={false} className="w-12 h-12" />
          </div>
          <p className="text-zinc-400 text-xs font-sans">{quickLookFile.name}</p>
          <span className="text-[11px] text-zinc-600 mt-1">Aperçu image (max 2 Mo)</span>
        </div>
        ) : (
        <pre className="whitespace-pre-wrap leading-relaxed select-text font-mono text-[12px] text-zinc-300">
          <code>{content}</code>
        </pre>
          )}
      </div>

      {/* Footer info */}
      <div className="h-8 px-4 border-t border-border-subtle bg-surface-muted/40 flex items-center justify-between text-[11px] text-zinc-500 font-mono select-none">
        <span className="truncate">{quickLookFile.path}</span>
        <span>Appuyez sur Espace pour fermer</span>
      </div>
    </div>
    </div >
  );
};
