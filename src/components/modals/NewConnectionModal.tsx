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
  ShieldAlert,
} from 'lucide-react';

export const NewConnectionModal: React.FC = () => {
  const {
    isNewConnectionModalOpen,
    setNewConnectionModalOpen,
    addProfile,
    editingProfile,
    setEditingProfile,
    updateProfile,
  } = useOrbitStore();

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
  const [useSudo, setUseSudo] = useState(false);

  // Test state & logs
  const [isTesting, setIsTesting] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [copiedLogs, setCopiedLogs] = useState(false);
  const [testResult, setTestResult] = useState<{
    type: 'success' | 'error';
    message: string;
    logs?: string[];
  } | null>(null);

  // Populate fields when editing an existing profile
  React.useEffect(() => {
    if (editingProfile) {
      setType(editingProfile.type);
      setName(editingProfile.name);
      setEndpoint(editingProfile.endpoint || '');
      setBucket(editingProfile.bucket || '');
      setRegion(editingProfile.region || 'eu-west-3');
      setAccessKey(editingProfile.accessKey || '');
      setHost(editingProfile.host || '');
      setPort(editingProfile.port || 22);
      setUsername(editingProfile.username || '');
      setAuthType(editingProfile.authType || 'key');
      setKeyPath(editingProfile.keyPath || '~/.ssh/id_ed25519');
      setUseSudo(Boolean(editingProfile.useSudo));
      storageApi.getSecret(editingProfile.id).then((sec) => {
        if (sec) {
          if (editingProfile.type === 's3') setSecretKey(sec);
          else if (editingProfile.authType === 'password') setPassword(sec);
          else setPassphrase(sec);
        }
      });
    } else {
      setType('sftp');
      setName('');
      setEndpoint('');
      setBucket('');
      setRegion('eu-west-3');
      setAccessKey('');
      setSecretKey('');
      setHost('');
      setPort(22);
      setUsername('');
      setAuthType('key');
      setKeyPath('~/.ssh/id_ed25519');
      setPassphrase('');
      setPassword('');
      setUseSudo(false);
      setTestResult(null);
      setIsTesting(false);
      setShowLogs(false);
    }
  }, [editingProfile, isNewConnectionModalOpen]);

  if (!isNewConnectionModalOpen) return null;

  const handleClose = () => {
    setIsTesting(false);
    setTestResult(null);
    setShowLogs(false);
    setEditingProfile(null);
    setNewConnectionModalOpen(false);
  };

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
      if (!bucket.trim()) {
        setTestResult({
          type: 'error',
          message: 'Veuillez saisir un nom de bucket S3.',
          logs: [`[${new Date().toLocaleTimeString()}] ❌ Erreur de validation : Le champ Bucket est obligatoire.`],
        });
        return;
      }
      if (!accessKey.trim()) {
        setTestResult({
          type: 'error',
          message: 'Veuillez renseigner votre Access Key ID.',
          logs: [`[${new Date().toLocaleTimeString()}] ❌ Erreur de validation : Le champ Access Key est obligatoire.`],
        });
        return;
      }

      setIsTesting(true);
      try {
        const res = await storageApi.testS3Connection({
          profile_id: editingProfile?.id || `test-${Date.now()}`,
          endpoint: endpoint.trim() || undefined,
          bucket: bucket.trim(),
          region: region.trim() || undefined,
          accessKey: accessKey.trim(),
          secretKey: secretKey.trim() || undefined,
        });

        setTestResult({
          type: res.success ? 'success' : 'error',
          message: res.message,
          logs: res.logs,
        });

        if (!res.success) {
          setShowLogs(true);
        }
      } catch (err: any) {
        setTestResult({
          type: 'error',
          message: err.message || 'Impossible de contacter le service S3.',
          logs: [`[Erreur inattendue] ${err?.message || err}`],
        });
        setShowLogs(true);
      } finally {
        setIsTesting(false);
      }
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
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Délai d'attente dépassé (90s) : aucune réponse reçue du serveur SSH ou de la validation.")),
          90000
        )
      );

      const res = await Promise.race([
        storageApi.testSftp({
          profile_id: `test-${Date.now()}`,
          host: host.trim(),
          port: Number(port) || 22,
          username: username.trim(),
          password: authType === 'password' ? password.trim() : undefined,
          key_path: authType === 'key' ? keyPath.trim() || undefined : undefined,
          passphrase: authType === 'key' ? passphrase.trim() || undefined : undefined,
          use_sudo: useSudo,
        }),
        timeoutPromise,
      ]);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const secret =
      type === 's3'
        ? secretKey.trim()
        : authType === 'key'
        ? passphrase.trim()
        : password.trim();

    if (editingProfile) {
      const updatedProfile: ConnectionProfile = {
        ...editingProfile,
        name: name.trim(),
        type,
        ...(type === 's3'
          ? {
              endpoint: endpoint.trim() || undefined,
              bucket: bucket.trim() || undefined,
              region: region.trim() || undefined,
              accessKey: accessKey.trim() || undefined,
              host: undefined,
              port: undefined,
              username: undefined,
              authType: undefined,
              keyPath: undefined,
            }
          : {
              host: host.trim(),
              port: Number(port) || 22,
              username: username.trim(),
              authType,
              keyPath: authType === 'key' ? keyPath.trim() || undefined : undefined,
              useSudo,
              endpoint: undefined,
              bucket: undefined,
              region: undefined,
              accessKey: undefined,
            }),
      };
      await updateProfile(updatedProfile, secret || undefined);
    } else {
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
              accessKey: accessKey.trim() || undefined,
            }
          : {
              host: host.trim(),
              port: Number(port) || 22,
              username: username.trim(),
              authType,
              keyPath: authType === 'key' ? keyPath.trim() || undefined : undefined,
              useSudo,
            }),
      };
      await addProfile(newProfile, secret || undefined);
    }

    handleClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-lg bg-surface border border-border-light rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="h-12 px-5 border-b border-border-subtle flex items-center justify-between bg-surface-muted/60 select-none flex-shrink-0">
          <h2 className="text-sm font-semibold text-white">
            {editingProfile ? 'Modifier la connexion' : 'Nouvelle connexion'}
          </h2>
          <button
            onClick={handleClose}
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
                  : 'text-zinc-400 hover:text-white hover:bg-white/5 border border-transparent'
              }`}
            >
              <Server className={`w-4 h-4 ${type === 'sftp' ? 'text-sky-400' : 'text-zinc-400'}`} />
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
                  : 'text-zinc-400 hover:text-white hover:bg-white/5 border border-transparent'
              }`}
            >
              <Cloud className={`w-4 h-4 ${type === 's3' ? 'text-amber-400' : 'text-zinc-400'}`} />
              <span>Amazon S3 / R2 / MinIO</span>
            </button>
          </div>

          {/* Profile Name */}
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">
              Nom de la connexion
            </label>
            <input
              type="text"
              required
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ex: Serveur Production, VPS Debian..."
              className="w-full bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500/50"
            />
          </div>

          {type === 's3' ? (
            <>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Endpoint URL (Optionnel pour AWS standard)
                </label>
                <input
                  type="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://<account_id>.r2.cloudflarestorage.com"
                  className="w-full bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500/50 font-mono"
                />
                {endpoint.trim().startsWith('http://') &&
                  !endpoint.includes('localhost') &&
                  !endpoint.includes('127.0.0.1') &&
                  !endpoint.includes('::1') && (
                    <p className="mt-1 text-[11px] text-amber-400">
                      ⚠️ Attention : cet endpoint utilise HTTP non chiffré. Vos identifiants et données transiteront en clair.
                    </p>
                  )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    Bucket Name
                  </label>
                  <input
                    type="text"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                    placeholder="my-bucket"
                    className="w-full bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500/50 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    Région
                  </label>
                  <input
                    type="text"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    placeholder="auto / eu-west-3"
                    className="w-full bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500/50 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Access Key ID
                </label>
                <input
                  type="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={accessKey}
                  onChange={(e) => setAccessKey(e.target.value)}
                  placeholder="AKIAIOSFODNN7EXAMPLE"
                  className="w-full bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500/50 font-mono"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-zinc-300">
                    Secret Access Key
                  </label>
                  <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                    <Lock className="w-3 h-3 text-emerald-400" /> Trousseau OS
                  </span>
                </div>
                <input
                  type="password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
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
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    Hôte ou adresse IP
                  </label>
                  <input
                    type="text"
                    required
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
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
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
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
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Nom d'utilisateur
                </label>
                <input
                  type="text"
                  required
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
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
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
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
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-medium text-zinc-300">
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
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
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
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-medium text-zinc-300">
                        Passphrase de la clé (si chiffrée)
                      </label>
                      <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                        <Lock className="w-3 h-3 text-emerald-400" /> Trousseau OS
                      </span>
                    </div>
                    <input
                      type="password"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
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
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-zinc-300">
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
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
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

              {/* Sudo / Root privileges toggle */}
              <div className="pt-2 border-t border-white/5">
                <label className="flex items-start gap-2.5 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={useSudo}
                    onChange={(e) => {
                      setUseSudo(e.target.checked);
                      setTestResult(null);
                    }}
                    className="w-4 h-4 mt-0.5 rounded border-border-subtle bg-surface-muted text-indigo-600 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                  />
                  <div className="flex-1">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-300 group-hover:text-white transition-colors">
                      <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                      <span>Mode Superutilisateur (Sudo / Root)</span>
                    </div>
                    <p className="text-[11px] text-zinc-500 mt-0.5">
                      Lance le serveur SFTP avec sudo pour accéder aux dossiers système protégés (nécessite les privilèges sudo).
                    </p>
                  </div>
                </label>
              </div>
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
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-white/[0.08] hover:bg-white/[0.12] text-zinc-200 hover:text-white border border-border-subtle transition-colors flex items-center justify-center gap-1.5 min-w-[155px] disabled:opacity-50"
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
                onClick={handleClose}
                className="px-3 py-1.5 rounded-md text-xs font-medium text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded-md text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white shadow-md transition-all flex items-center gap-1.5"
              >
                <Check className="w-3.5 h-3.5" />
                <span>{editingProfile ? 'Mettre à jour' : 'Enregistrer & Connecter'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
