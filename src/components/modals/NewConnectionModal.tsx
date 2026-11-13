import React, { useState } from 'react';
import { useOrbitStore } from '../../store/useOrbitStore';
import { StorageType, ConnectionProfile } from '../../types';
import { storageApi } from '../../services/storageApi';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import {
  X,
  Cloud,
  Server,
  Lock,
  Check,
  Key,
  FolderOpen,
  Eye,
  EyeOff,
  Activity,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Terminal,
  Copy,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

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

  // Test state & logs
  const [isTesting, setIsTesting] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [copiedLogs, setCopiedLogs] = useState(false);
  const [testResult, setTestResult] = useState<{
    type: 'success' | 'error';
    message: string;
    logs?: string[];
  } | null>(null);

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
        setTestResult(null);
      }
    } catch (err) {
      console.warn('Dialog not available in browser mode:', err);
    }
  };

  const handleTestConnection = async () => {
    setTestResult(null);
    setShowLogs(false);

    if (type === 's3') {
      setTestResult({
        type: 'success',
        message: 'Configuration S3 prête (le test direct via AWS SDK sera activé à l\'étape 2).',
        logs: [
          `[${new Date().toLocaleTimeString()}] Validation des identifiants S3`,
          `[${new Date().toLocaleTimeString()}] Bucket : ${bucket || '(racine)'}`,
          `[${new Date().toLocaleTimeString()}] Endpoint : ${endpoint || 'AWS Standard (S3)'}`,
        ],
      });
      return;
    }

    if (!host.trim()) {
      setTestResult({
        type: 'error',
        message: 'Veuillez saisir une adresse d\'hôte valide.',
        logs: [`[${new Date().toLocaleTimeString()}] ❌ Erreur de validation : Le champ Hôte est obligatoire.`],
      });
      return;
    }
    if (!username.trim()) {
      setTestResult({
        type: 'error',
        message: 'Veuillez renseigner un nom d\'utilisateur SSH.',
        logs: [`[${new Date().toLocaleTimeString()}] ❌ Erreur de validation : Le champ Nom d'utilisateur est obligatoire.`],
      });
      return;
    }

    setIsTesting(true);

    try {
      const res = await storageApi.testSftp({
        profile_id: `test-${Date.now()}`,
        host: host.trim(),
        port: Number(port) || 22,
        username: username.trim(),
        password: authType === 'password' ? password.trim() : undefined,
        key_path: authType === 'key' ? keyPath.trim() || undefined : undefined,
        passphrase: authType === 'key' ? passphrase.trim() || undefined : undefined,
      });

      setTestResult({
        type: res.success ? 'success' : 'error',
        message: res.message,
        logs: res.logs,
      });

      // Auto-expand logs if error occurred to help the user diagnose immediately
      if (!res.success) {
        setShowLogs(true);
      }
    } catch (err: any) {
      setTestResult({
        type: 'error',
        message: err.message || 'Impossible d\'établir la connexion au serveur distant.',
        logs: [`[Erreur inattendue] ${err?.message || err}`],
      });
      setShowLogs(true);
    } finally {
      setIsTesting(false);
    }
  };

  const handleCopyLogs = () => {
    if (!testResult?.logs) return;
    navigator.clipboard.writeText(testResult.logs.join('\n'));
    setCopiedLogs(true);
    setTimeout(() => setCopiedLogs(false), 2000);
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
        className="w-full max-w-lg bg-surface border border-border-light rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="h-12 px-5 border-b border-border-subtle flex items-center justify-between bg-surface-muted/60 select-none flex-shrink-0">
          <h2 className="text-sm font-semibold text-white">Nouvelle Connexion</h2>
          <button
            onClick={() => setNewConnectionModalOpen(false)}
            className="p-1.5 rounded-md hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body with scroll if needed */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto flex-1">
          {/* Protocol Switcher */}
          <div className="grid grid-cols-2 gap-2 p-1 bg-surface-muted rounded-lg border border-border-subtle">
            <button
              type="button"
              onClick={() => {
                setType('sftp');
                setTestResult(null);
              }}
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
              onClick={() => {
                setType('s3');
                setTestResult(null);
              }}
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
                    onChange={(e) => {
                      setHost(e.target.value);
                      setTestResult(null);
                    }}
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
                    onChange={(e) => {
                      setPort(Number(e.target.value));
                      setTestResult(null);
                    }}
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
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setTestResult(null);
                  }}
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
                    onClick={() => {
                      setAuthType('key');
                      setTestResult(null);
                    }}
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
                    onClick={() => {
                      setAuthType('password');
                      setTestResult(null);
                    }}
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
                          onClick={() => {
                            setKeyPath('~/.ssh/id_ed25519');
                            setTestResult(null);
                          }}
                          className="hover:text-sky-400 underline font-mono"
                        >
                          id_ed25519
                        </button>
                        <span>•</span>
                        <button
                          type="button"
                          onClick={() => {
                            setKeyPath('~/.ssh/id_rsa');
                            setTestResult(null);
                          }}
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
                        onChange={(e) => {
                          setKeyPath(e.target.value);
                          setTestResult(null);
                        }}
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
                      onChange={(e) => {
                        setPassphrase(e.target.value);
                        setTestResult(null);
                      }}
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
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setTestResult(null);
                      }}
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

          {/* Test connection result & expandable log console */}
          {testResult && (
            <div className="space-y-2 animate-in fade-in">
              {/* Summary Banner */}
              <div
                className={`p-3 rounded-lg border text-xs flex items-start justify-between gap-2.5 ${
                  testResult.type === 'success'
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-red-500/10 border-red-500/30 text-red-300'
                }`}
              >
                <div className="flex items-start gap-2.5 flex-1 min-w-0">
                  {testResult.type === 'success' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold mb-0.5">
                      {testResult.type === 'success' ? 'Connexion réussie' : 'Échec de connexion'}
                    </div>
                    <p className="text-[11px] leading-relaxed opacity-90 break-words">
                      {testResult.message}
                    </p>
                  </div>
                </div>

                {/* Toggle Logs Button */}
                {testResult.logs && testResult.logs.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowLogs(!showLogs)}
                    className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-black/30 hover:bg-black/50 text-zinc-300 transition-colors flex-shrink-0 font-medium"
                  >
                    <Terminal className="w-3 h-3 text-sky-400" />
                    <span>{showLogs ? 'Masquer logs' : 'Voir logs'}</span>
                    {showLogs ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                )}
              </div>

              {/* Expandable Technical Log Box */}
              {showLogs && testResult.logs && (
                <div className="p-3 bg-[#090a0f] border border-border-subtle rounded-lg space-y-2">
                  <div className="flex items-center justify-between pb-1.5 border-b border-border-subtle text-[11px] text-zinc-400 font-mono">
                    <span className="flex items-center gap-1.5 text-zinc-300 font-semibold">
                      <Terminal className="w-3.5 h-3.5 text-sky-400" />
                      Journal de négociation SSH / SFTP
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyLogs}
                      className="flex items-center gap-1 text-[10px] text-zinc-400 hover:text-white px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 transition-colors"
                      title="Copier les logs complets dans le presse-papiers"
                    >
                      {copiedLogs ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedLogs ? 'Copié !' : 'Copier logs'}</span>
                    </button>
                  </div>

                  <div className="max-h-44 overflow-y-auto space-y-1 font-mono text-[11px] text-zinc-300 select-text leading-relaxed">
                    {testResult.logs.map((line, idx) => {
                      const isErr = line.includes('❌') || line.includes('Échec') || line.includes('Erreur');
                      const isOk = line.includes('✅') || line.includes('acceptée') || line.includes('succès');
                      const isTip = line.includes('ℹ️');

                      return (
                        <div
                          key={idx}
                          className={`truncate ${
                            isErr
                              ? 'text-red-400 font-medium'
                              : isOk
                              ? 'text-emerald-400 font-medium'
                              : isTip
                              ? 'text-amber-300/90'
                              : 'text-zinc-400'
                          }`}
                        >
                          {line}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div className="pt-3 flex items-center justify-between border-t border-border-subtle flex-shrink-0">
            <button
              type="button"
              disabled={isTesting}
              onClick={handleTestConnection}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-white/[0.08] hover:bg-white/[0.12] text-zinc-200 hover:text-white border border-border-subtle transition-all flex items-center gap-1.5 disabled:opacity-50"
            >
              {isTesting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
                  <span>Test en cours...</span>
                </>
              ) : (
                <>
                  <Activity className="w-3.5 h-3.5 text-sky-400" />
                  <span>Tester la connexion</span>
                </>
              )}
            </button>

            <div className="flex items-center gap-2">
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
          </div>
        </form>
      </div>
    </div>
  );
};
