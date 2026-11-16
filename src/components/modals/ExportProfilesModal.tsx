import React, { useState } from 'react';
import { useOrbitStore } from '../../store/useOrbitStore';
import { X, Copy, Check, Download, Shield } from 'lucide-react';

export const ExportProfilesModal: React.FC = () => {
  const { isExportModalOpen, setExportModalOpen, profiles } = useOrbitStore();
  const [copied, setCopied] = useState(false);

  if (!isExportModalOpen) return null;

  // Sanitized profiles: no secret keys or passwords
  const sanitizedProfiles = profiles.map(({ id, name, type, endpoint, bucket, region, host, port, username, isFavorite }) => ({
    id,
    name,
    type,
    ...(type === 's3' ? { endpoint, bucket, region } : { host, port, username }),
    isFavorite,
  }));

  const jsonString = JSON.stringify(sanitizedProfiles, null, 2);

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'orbit-connections.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-lg bg-surface border border-border-light rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="h-12 px-5 border-b border-border-subtle flex items-center justify-between bg-surface-muted/60 select-none flex-shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-white">Exporter les Profils</h2>
            <span className="flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full font-medium">
              <Shield className="w-3 h-3" /> Sans secrets
            </span>
          </div>
          <button
            onClick={() => setExportModalOpen(false)}
            className="p-1.5 rounded-md hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-3 overflow-y-auto flex-1">
          <p className="text-xs text-zinc-400">
            Ce fichier JSON contient les métadonnées de vos favoris serveurs. Conformément à la spécification, les clés secrètes et mots de passe sont exclus pour permettre un partage sécurisé.
          </p>
          <div className="relative">
            <pre className="max-h-64 overflow-auto p-3 rounded-lg bg-black/50 border border-border-subtle text-[11px] font-mono text-zinc-300 leading-relaxed select-text">
              <code>{jsonString}</code>
            </pre>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-border-subtle bg-surface-muted/40 flex items-center justify-end gap-2 flex-shrink-0">
          <button
            onClick={handleCopy}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-white/5 hover:bg-white/10 text-zinc-200 border border-border-subtle transition-all flex items-center gap-1.5"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'Copié !' : 'Copier JSON'}</span>
          </button>
          <button
            onClick={handleDownload}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white shadow-md transition-all flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Télécharger .json</span>
          </button>
        </div>
      </div>
    </div>
  );
};

