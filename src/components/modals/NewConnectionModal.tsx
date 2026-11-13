import React, { useState } from 'react';
import { useOrbitStore } from '../../store/useOrbitStore';
import { StorageType, ConnectionProfile } from '../../types';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { X, Cloud, Server, Lock, Check, Key, FolderOpen, Eye, EyeOff } from 'lucide-react';

export const NewConnectionModal: React.FC = () => {
  const { isNewConnectionModalOpen, setNewConnectionModalOpen, addProfile } = useOrbitStore();

  const [type, setType] = useState<StorageType>('sftp');
  const [name, setName] = useState('');

  // S3 state
  const [endpoint, setEndpoint] = useState('');
  const [bucket, setBucket] = useState('');
  const [region, setRegion] = useState('eu-west-3');
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');

  // SFTP state
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('');
  const [authType, setAuthType] = useState<'key' | 'password'>('key');
  const [keyPath, setKeyPath] = useState('~/.ssh/id_ed25519');
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  if (!isNewConnectionModalOpen) return null;

  const handleBrowseKey = async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: 'Sélectionner la clé privée SSH',
      });
      if (selected && typeof selected === 'string') {
        setKeyPath(selected);
      }
    } catch (err) {
      console.warn('Dialog not available in browser mode:', err);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const newProfile: ConnectionProfile = {
      id: `prof-${Date.now()}`,
      name: name.trim(),
      type,
      status: 'idle',
      isFavorite: true,
      ...(type === 's3'
        ? {
            endpoint: endpoint.trim() || undefined,
            bucket: bucket.trim() || undefined,
            region: region.trim() || undefined,
          }
        : {
            host: host.trim(),
            port: Number(port) || 22,
            username: username.trim(),
            authType,
            keyPath: authType === 'key' ? keyPath.trim() || undefined : undefined,
          }),
    };

    const secret =
      type === 's3'
        ? secretKey.trim()
        : authType === 'key'
        ? passphrase.trim()
        : password.trim();

    addProfile(newProfile, secret || undefined);
    setNewConnectionModalOpen(false);
  };

  return (
    <div
      onClick={() => setNewConnectionModalOpen(false)}
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-surface border border-border-light rounded-xl shadow-2xl overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="h-12 px-5 border-b border-border-subtle flex items-center justify-between bg-surface-muted/60 select-none">
          <h2 className="text-sm font-semibold text-white">Nouvelle Connexion</h2>
          <button
            onClick={() => setNewConnectionModalOpen(false)}
            className="p-1.5 rounded-md hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Protocol Switcher */}
          <div className="grid grid-cols-2 gap-2 p-1 bg-surface-muted rounded-lg border border-border-subtle">
            <button
              type="button"
              onClick={() => setType('sftp')}
              className={`flex items-center justify-center gap-2 py-1.5 rounded-md text-xs font-medium transition-all ${
                type === 'sftp'
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30 shadow-sm'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              <Server className="w-4 h-4 text-sky-400" />
              <span>SFTP (SSH)</span>
            </button>
            <button
              type="button"
              onClick={() => setType('s3')}
              className={`flex items-center justify-center gap-2 py-1.5 rounded-md text-xs font-medium transition-all ${
                type === 's3'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 shadow-sm'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              <Cloud className="w-4 h-4 text-amber-400" />
              <span>Amazon S3 / R2 / MinIO</span>
            </button>
          </div>

          {/* Profile Name */}
          <div>
            <label className="block text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-1">
              Nom du favori
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={type === 's3' ? 'Cloudflare R2 Prod' : 'Mon Serveur Linux'}
              className="w-full bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500/50"
            />
          </div>

          {type === 's3' ? (
            <>
              <div>
                <label className="block text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-1">
                  Endpoint URL (Optionnel pour AWS standard)
                </label>
                <input
                  type="text"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://<account_id>.r2.cloudflarestorage.com"
                  className="w-full bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500/50 font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-1">
                    Bucket Name
                  </label>
                  <input
                    type="text"
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                    placeholder="my-bucket"
                    className="w-full bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500/50 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-1">
                    Région
                  </label>
                  <input
                    type="text"
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    placeholder="auto / eu-west-3"
                    className="w-full bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500/50 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-1">
                  Access Key ID
                </label>
                <input
                  type="text"
                  value={accessKey}
                  onChange={(e) => setAccessKey(e.target.value)}
                  placeholder="AKIAIOSFODNN7EXAMPLE"
                  className="w-full bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500/50 font-mono"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
                    Secret Access Key
                  </label>
                  <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                    <Lock className="w-3 h-3 text-emerald-400" /> Trousseau OS
                  </span>
                </div>
                <input
                  type="password"
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  placeholder="••••••••••••••••••••••••••••••"
                  className="w-full bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500/50 font-mono"
                />
              </div>
            </>
          ) : (
            <>
              {/* Host & Port */}
              <div className="grid grid-cols-4 gap-3">
                <div className="col-span-3">
                  <label className="block text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-1">
                    Hôte (Host / IP)
                  </label>
                  <input
                    type="text"
                    required
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="192.168.1.100 ou ssh.mondomaine.com"
                    className="w-full bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-sky-500/50 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-1">
                    Port
                  </label>
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                    className="w-full bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-sky-500/50 font-mono"
                  />
                </div>
              </div>

              {/* Username */}
              <div>
                <label className="block text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-1">
                  Nom d'utilisateur
                </label>
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="root / ubuntu / deploy"
                  className="w-full bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-sky-500/50 font-mono"
                />
              </div>

              {/* SFTP Authentication Type Switcher */}
              <div>
                <label className="block text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-1.5">
                  Méthode d'authentification
                </label>
                <div className="grid grid-cols-2 gap-2 p-1 bg-surface-muted/80 rounded-lg border border-border-subtle">
                  <button
                    type="button"
                    onClick={() => setAuthType('key')}
                    className={`flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                      authType === 'key'
                        ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    <Key className="w-3.5 h-3.5" />
                    <span>Clé privée SSH</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAuthType('password')}
                    className={`flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                      authType === 'password'
                        ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    <Lock className="w-3.5 h-3.5" />
                    <span>Mot de passe</span>
                  </button>
                </div>
              </div>

              {authType === 'key' ? (
                <>
                  {/* SSH Key File Picker */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
                        Fichier de clé privée
                      </label>
                      <div className="flex items-center gap-1 text-[10px] text-zinc-500">
                        <span>Presets :</span>
                        <button
                          type="button"
                          onClick={() => setKeyPath('~/.ssh/id_ed25519')}
                          className="hover:text-sky-400 underline font-mono"
                        >
                          id_ed25519
                        </button>
                        <span>•</span>
                        <button
                          type="button"
                          onClick={() => setKeyPath('~/.ssh/id_rsa')}
                          className="hover:text-sky-400 underline font-mono"
                        >
                          id_rsa
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        required
                        value={keyPath}
                        onChange={(e) => setKeyPath(e.target.value)}
                        placeholder="~/.ssh/id_ed25519 ou /chemin/vers/cle.pem"
                        className="flex-1 bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-sky-500/50 font-mono"
                      />
                      <button
                        type="button"
                        onClick={handleBrowseKey}
                        className="px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-xs font-medium text-zinc-200 border border-border-subtle transition-colors flex items-center gap-1.5 flex-shrink-0"
                        title="Ouvrir le sélecteur de fichier natif"
                      >
                        <FolderOpen className="w-3.5 h-3.5 text-sky-400" />
                        <span>Parcourir...</span>
                      </button>
                    </div>
                  </div>

                  {/* Key Passphrase */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
                        Passphrase de la clé (si chiffrée)
                      </label>
                      <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                        <Lock className="w-3 h-3 text-emerald-400" /> Trousseau OS
                      </span>
                    </div>
                    <input
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder="Laisser vide si la clé n'a pas de passphrase"
                      className="w-full bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-sky-500/50 font-mono"
                    />
                  </div>
                </>
              ) : (
                /* Password Auth */
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
                      Mot de passe du compte
                    </label>
                    <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                      <Lock className="w-3 h-3 text-emerald-400" /> Trousseau OS
                    </span>
                  </div>
                  <div className="relative flex items-center">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••••••••••••••••••••"
                      className="w-full bg-surface-muted border border-border-subtle rounded-md pl-3 pr-9 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-sky-500/50 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2.5 text-zinc-400 hover:text-white transition-colors"
                      title={showPassword ? 'Masquer' : 'Afficher'}
                    >
                      {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Action buttons */}
          <div className="pt-3 flex items-center justify-end gap-2 border-t border-border-subtle">
            <button
              type="button"
              onClick={() => setNewConnectionModalOpen(false)}
              className="px-3 py-1.5 rounded-md text-xs font-medium text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
            >
              Annuler
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 rounded-md text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white shadow-md transition-all flex items-center gap-1.5"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Enregistrer & Connecter</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
