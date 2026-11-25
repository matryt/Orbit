import React, { useState, useEffect } from 'react';
import { useOrbitStore } from '../../store/useOrbitStore';
import { storageApi } from '../../services/storageApi';
import {
  X,
  Check,
  Upload,
  FileText,
  AlertTriangle,
  FolderOpen,
  Route,
  Terminal,
} from 'lucide-react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import type { ConnectionProfile } from '../../types';
import { parseAndValidateProfilesJson } from '../../lib/profileImport';

type ImportTab = 'ssh' | 'json';

export const ImportProfilesModal: React.FC = () => {
  const { isImportModalOpen, setImportModalOpen, importProfiles, profiles: existingProfiles } = useOrbitStore();

  const [activeTab, setActiveTab] = useState<ImportTab>('ssh');
  const [sshConfigPath, setSshConfigPath] = useState<string>('~/.ssh/config');
  const [isLoadingSsh, setIsLoadingSsh] = useState<boolean>(false);
  const [sshError, setSshError] = useState<string | null>(null);
  const [detectedSshProfiles, setDetectedSshProfiles] = useState<ConnectionProfile[]>([]);
  const [sshWarnings, setSshWarnings] = useState<string[]>([]);
  const [selectedProfileIds, setSelectedProfileIds] = useState<Set<string>>(new Set());

  // JSON Tab states
  const [jsonInput, setJsonInput] = useState<string>('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [jsonWarnings, setJsonWarnings] = useState<string[]>([]);
  const [parsedJsonProfiles, setParsedJsonProfiles] = useState<ConnectionProfile[]>([]);

  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [importSuccessMessage, setImportSuccessMessage] = useState<string | null>(null);

  // Automatically load ~/.ssh/config when the modal opens on the SSH tab
  useEffect(() => {
    if (isImportModalOpen && activeTab === 'ssh' && detectedSshProfiles.length === 0 && !sshError) {
      loadSshConfig('~/.ssh/config');
    }
  }, [isImportModalOpen, activeTab]);

  if (!isImportModalOpen) return null;

  const loadSshConfig = async (path: string) => {
    setIsLoadingSsh(true);
    setSshError(null);
    setSshWarnings([]);
    try {
      const res = await storageApi.readSshConfig(path === '~/.ssh/config' ? undefined : path);
      setDetectedSshProfiles(res.profiles);
      setSshWarnings(res.warnings);
      // Select all detected profiles by default
      setSelectedProfileIds(new Set(res.profiles.map((p) => p.id)));
      if (res.profiles.length === 0 && res.warnings.length === 0) {
        setSshError('Aucun profil hôte valide trouvé dans ce fichier de configuration.');
      }
    } catch (err: any) {
      setDetectedSshProfiles([]);
      setSelectedProfileIds(new Set());
      setSshError(err.message || 'Erreur lors de la lecture du fichier .ssh/config');
    } finally {
      setIsLoadingSsh(false);
    }
  };

  const handleBrowseSshFile = async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: 'Sélectionner un fichier de configuration SSH',
      });
      if (selected && typeof selected === 'string') {
        setSshConfigPath(selected);
        loadSshConfig(selected);
      }
    } catch (err) {
      console.error('Erreur sélection fichier:', err);
    }
  };

  const handleBrowseJsonFile = async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: 'Sélectionner un fichier de profils JSON Orbit',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (selected && typeof selected === 'string') {
        const content = await (window as any).__TAURI__?.fs?.readTextFile(selected);
        if (content) {
          setJsonInput(content);
          handleJsonChange(content);
        }
      }
    } catch (err) {
      console.error('Erreur sélection JSON:', err);
    }
  };

  const handleJsonChange = (content: string) => {
    setJsonInput(content);
    setJsonError(null);
    setJsonWarnings([]);
    if (!content.trim()) {
      setParsedJsonProfiles([]);
      return;
    }
    const { profiles, warnings } = parseAndValidateProfilesJson(content, existingProfiles);
    setParsedJsonProfiles(profiles);
    setJsonWarnings(warnings);
    if (profiles.length === 0 && warnings.length > 0) {
      setJsonError(warnings[0]);
    }
  };

  const toggleSelectProfile = (id: string) => {
    setSelectedProfileIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllSsh = () => {
    if (selectedProfileIds.size === detectedSshProfiles.length) {
      setSelectedProfileIds(new Set());
    } else {
      setSelectedProfileIds(new Set(detectedSshProfiles.map((p) => p.id)));
    }
  };

  const handleExecuteImport = async () => {
    setIsImporting(true);
    setImportSuccessMessage(null);
    try {
      const rawProfilesToImport =
        activeTab === 'ssh'
          ? detectedSshProfiles.filter((p) => selectedProfileIds.has(p.id))
          : parsedJsonProfiles;

      if (rawProfilesToImport.length === 0) return;

      const existingIds = new Set(existingProfiles.map((p) => p.id));
      const importedIds = new Set(rawProfilesToImport.map((p) => p.id));

      const profilesToImport = rawProfilesToImport.map((p) => {
        if (p.bastion?.profileId && !importedIds.has(p.bastion.profileId) && !existingIds.has(p.bastion.profileId)) {
          return {
            ...p,
            bastion: {
              ...p.bastion,
              profileId: undefined,
            },
          };
        }
        return p;
      });

      const count = await importProfiles(profilesToImport);
      setImportSuccessMessage(`${count} profil(s) importé(s) avec succès !`);
      setTimeout(() => {
        setImportModalOpen(false);
        setImportSuccessMessage(null);
      }, 1200);
    } catch (err: any) {
      alert(`Erreur d'importation : ${err.message || 'Erreur inconnue'}`);
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-2xl bg-surface border border-border-light rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="h-12 px-5 border-b border-border-subtle flex items-center justify-between bg-surface-muted/60 select-none flex-shrink-0">
          <div className="flex items-center gap-2">
            <Upload className="w-4 h-4 text-indigo-400" />
            <h2 className="text-sm font-semibold text-white">Importer des Profils</h2>
          </div>
          <button
            onClick={() => setImportModalOpen(false)}
            className="p-1.5 rounded-md hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Selection */}
        <div className="flex items-center gap-1 px-5 pt-3 border-b border-border-subtle bg-surface-muted/30">
          <button
            type="button"
            onClick={() => setActiveTab('ssh')}
            className={`flex items-center gap-2 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'ssh'
                ? 'border-indigo-500 text-white'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>OpenSSH (.ssh/config)</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('json')}
            className={`flex items-center gap-2 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'json'
                ? 'border-indigo-500 text-white'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Fichier JSON Orbit</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {activeTab === 'ssh' && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-300">Chemin du fichier de configuration SSH</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={sshConfigPath}
                    onChange={(e) => setSshConfigPath(e.target.value)}
                    placeholder="~/.ssh/config"
                    className="flex-1 bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={handleBrowseSshFile}
                    className="px-3 py-1.5 rounded-md text-xs font-medium bg-white/5 hover:bg-white/10 text-zinc-200 border border-border-subtle flex items-center gap-1.5"
                    title="Parcourir le système de fichiers"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-zinc-400" />
                    <span>Parcourir</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => loadSshConfig(sshConfigPath)}
                    disabled={isLoadingSsh}
                    className="px-3 py-1.5 rounded-md text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-all disabled:opacity-50"
                  >
                    {isLoadingSsh ? 'Lecture...' : 'Charger'}
                  </button>
                </div>
              </div>

              {sshError && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-300 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                  <p>{sshError}</p>
                </div>
              )}

              {sshWarnings.length > 0 && (
                <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 space-y-1">
                  <div className="flex items-center gap-1.5 font-medium">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                    <span>Avertissements de lecture :</span>
                  </div>
                  <ul className="list-disc list-inside space-y-0.5 text-[11px] text-amber-200/80">
                    {sshWarnings.map((w, idx) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {detectedSshProfiles.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-zinc-400 px-1">
                    <span className="font-medium text-zinc-300">
                      {detectedSshProfiles.length} profil(s) détecté(s) ({selectedProfileIds.size} sélectionné(s))
                    </span>
                    <button
                      type="button"
                      onClick={toggleSelectAllSsh}
                      className="text-indigo-400 hover:text-indigo-300 transition-colors"
                    >
                      {selectedProfileIds.size === detectedSshProfiles.length
                        ? 'Tout désélectionner'
                        : 'Tout sélectionner'}
                    </button>
                  </div>

                  <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                    {detectedSshProfiles.map((p) => {
                      const isSelected = selectedProfileIds.has(p.id);
                      return (
                        <div
                          key={p.id}
                          onClick={() => toggleSelectProfile(p.id)}
                          className={`p-2.5 rounded-lg border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                            isSelected
                              ? 'bg-indigo-500/10 border-indigo-500/30 text-white'
                              : 'bg-white/[0.02] border-border-subtle text-zinc-400 hover:bg-white/[0.05]'
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleSelectProfile(p.id)}
                              onClick={(e) => e.stopPropagation()}
                              className="rounded border-zinc-700 bg-surface text-indigo-500 focus:ring-0 cursor-pointer"
                            />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold text-zinc-100 truncate">{p.name}</span>
                                {p.authType === 'agent' && (
                                  <span className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.2 rounded font-mono">
                                    Agent SSH
                                  </span>
                                )}
                                {p.bastion?.enabled && (
                                  <span className="flex items-center gap-1 text-[10px] bg-sky-500/10 text-sky-400 border border-sky-500/20 px-1.5 py-0.2 rounded font-mono">
                                    <Route className="w-2.5 h-2.5" /> Bastion
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-zinc-400 flex items-center gap-2 mt-0.5 truncate">
                                <span>
                                  {p.username ? `${p.username}@` : ''}
                                  {p.host}:{p.port || 22}
                                </span>
                                {p.keyPath && (
                                  <span className="text-zinc-500 truncate" title={p.keyPath}>
                                    • clé: {p.keyPath.split('/').pop()}
                                  </span>
                                )}
                                {p.bastion?.enabled && (
                                  <span className="text-sky-400/80 truncate">
                                    • via {p.bastion.profileId ? p.bastion.profileId : p.bastion.host}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'json' && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-zinc-300">Contenu JSON des profils</label>
                  <button
                    type="button"
                    onClick={handleBrowseJsonFile}
                    className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                  >
                    <FolderOpen className="w-3 h-3" />
                    <span>Ouvrir un fichier .json</span>
                  </button>
                </div>
                <textarea
                  value={jsonInput}
                  onChange={(e) => handleJsonChange(e.target.value)}
                  placeholder="Collez ici le JSON de vos profils Orbit ou ouvrez un fichier..."
                  rows={8}
                  className="w-full bg-surface-muted border border-border-subtle rounded-md p-3 text-xs font-mono text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 leading-relaxed"
                />
              </div>

              {jsonError && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-300 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                  <p>{jsonError}</p>
                </div>
              )}

              {jsonWarnings.length > 0 && (
                <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 space-y-1">
                  <div className="flex items-center gap-1.5 font-medium">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                    <span>Avertissements de validation :</span>
                  </div>
                  <ul className="list-disc list-inside space-y-0.5 text-[11px] text-amber-200/80">
                    {jsonWarnings.map((w, idx) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {parsedJsonProfiles.length > 0 && (
                <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 font-medium">
                    <Check className="w-4 h-4 text-emerald-400" />
                    {parsedJsonProfiles.length} profil(s) valide(s) prêt(s) à être importé(s)
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-border-subtle bg-surface-muted/40 flex items-center justify-between flex-shrink-0">
          <div className="text-xs text-zinc-400">
            {importSuccessMessage ? (
              <span className="text-emerald-400 font-medium flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5" /> {importSuccessMessage}
              </span>
            ) : (
              <span className="text-zinc-500 text-[11px]">
                {activeTab === 'ssh'
                  ? 'Importation automatique des hôtes, clés et sauts de bastion'
                  : 'Importation sécurisée avec assainissement des identifiants'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setImportModalOpen(false)}
              className="px-3 py-1.5 rounded-md text-xs font-medium text-zinc-300 hover:text-white hover:bg-white/5 transition-colors"
            >
              Fermer
            </button>
            <button
              type="button"
              onClick={handleExecuteImport}
              disabled={
                isImporting ||
                (activeTab === 'ssh' && selectedProfileIds.size === 0) ||
                (activeTab === 'json' && parsedJsonProfiles.length === 0)
              }
              className="px-4 py-1.5 rounded-md text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white shadow-md transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>
                {isImporting
                  ? 'Importation...'
                  : activeTab === 'ssh'
                  ? `Importer (${selectedProfileIds.size})`
                  : `Importer (${parsedJsonProfiles.length})`}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
