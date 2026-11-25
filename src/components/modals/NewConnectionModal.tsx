import React, { useState } from 'react';
import { useOrbitStore } from '../../store/useOrbitStore';
import { StorageType, ConnectionProfile, SshAuthType } from '../../types';
import { storageApi } from '../../services/storageApi';
import { parsePortInput, resolvePort } from '../../lib/portUtils';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import {
  X,
  Cloud,
  Server,
  Lock,
  Check,
  Key,
  Fingerprint,
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
  Globe,
  Network,
} from 'lucide-react';

export const NewConnectionModal: React.FC = () => {
  const {
    isNewConnectionModalOpen,
    setNewConnectionModalOpen,
    addProfile,
    editingProfile,
    setEditingProfile,
    updateProfile,
    profiles,
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
  const [port, setPort] = useState<number | ''>(22);
  const [username, setUsername] = useState('');
  const [authType, setAuthType] = useState<SshAuthType>('key');
  const [keyPath, setKeyPath] = useState('~/.ssh/id_ed25519');
  // Agent mode: optional public key restricting the agent identity, and optional socket override.
  const [agentKeyPath, setAgentKeyPath] = useState('');
  const [agentSocket, setAgentSocket] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [useSudo, setUseSudo] = useState(false);

  // Bastion (SSH Jump Host) state
  const [bastionEnabled, setBastionEnabled] = useState(false);
  const [bastionMode, setBastionMode] = useState<'profile' | 'custom'>('profile');
  const [bastionProfileId, setBastionProfileId] = useState('');
  const [bastionHost, setBastionHost] = useState('');
  const [bastionPort, setBastionPort] = useState<number | ''>(22);
  const [bastionUsername, setBastionUsername] = useState('');
  const [bastionAuthType, setBastionAuthType] = useState<SshAuthType>('key');
  const [bastionKeyPath, setBastionKeyPath] = useState('~/.ssh/id_ed25519');
  const [bastionAgentKeyPath, setBastionAgentKeyPath] = useState('');
  const [bastionPassphrase, setBastionPassphrase] = useState('');
  const [bastionPassword, setBastionPassword] = useState('');
  const [showBastionPassword, setShowBastionPassword] = useState(false);

  // Proxy state
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyType, setProxyType] = useState<'socks5' | 'http'>('socks5');
  const [proxyHost, setProxyHost] = useState('');
  const [proxyPort, setProxyPort] = useState<number | ''>(1080);
  const [proxyUsername, setProxyUsername] = useState('');
  const [proxyPassword, setProxyPassword] = useState('');
  const [showProxyPassword, setShowProxyPassword] = useState(false);

  // Network accordion toggle
  const [showNetworkSettings, setShowNetworkSettings] = useState(false);

  const otherSftpProfiles = profiles.filter((p) => p.type === 'sftp' && p.id !== editingProfile?.id);
  const effectiveBastionMode = otherSftpProfiles.length > 0 ? bastionMode : 'custom';

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
    let cancelled = false;

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
      const profileAuth = editingProfile.authType || 'key';
      setAuthType(profileAuth);
      setKeyPath(profileAuth === 'key' && editingProfile.keyPath ? editingProfile.keyPath : '~/.ssh/id_ed25519');
      setAgentKeyPath(profileAuth === 'agent' ? editingProfile.keyPath || '' : '');
      setAgentSocket(editingProfile.agentSocket || '');
      setUseSudo(Boolean(editingProfile.useSudo));
      storageApi.getSecret(editingProfile.id).then((sec) => {
        if (!cancelled && sec) {
          if (editingProfile.type === 's3') setSecretKey(sec);
          else if (editingProfile.authType === 'password') setPassword(sec);
          else if (editingProfile.authType !== 'agent') setPassphrase(sec);
        }
      });

      if (editingProfile.bastion?.enabled) {
        setBastionEnabled(true);
        if (editingProfile.bastion.profileId) {
          setBastionMode('profile');
          setBastionProfileId(editingProfile.bastion.profileId);
        } else {
          setBastionMode('custom');
          setBastionHost(editingProfile.bastion.host || '');
          setBastionPort(editingProfile.bastion.port || 22);
          setBastionUsername(editingProfile.bastion.username || '');
          const bastionAuth = editingProfile.bastion.authType || 'key';
          setBastionAuthType(bastionAuth);
          setBastionKeyPath(
            bastionAuth === 'key' && editingProfile.bastion.keyPath ? editingProfile.bastion.keyPath : '~/.ssh/id_ed25519'
          );
          setBastionAgentKeyPath(bastionAuth === 'agent' ? editingProfile.bastion.keyPath || '' : '');
        }
        setShowNetworkSettings(true);
        storageApi.getSecret(`${editingProfile.id}:bastion`).then((sec) => {
          if (!cancelled && sec) {
            if (editingProfile.bastion?.authType === 'password') setBastionPassword(sec);
            else if (editingProfile.bastion?.authType !== 'agent') setBastionPassphrase(sec);
          }
        });
      } else {
        setBastionEnabled(false);
        setBastionMode('profile');
        setBastionProfileId('');
        setBastionHost('');
        setBastionPort(22);
        setBastionUsername('');
        setBastionAuthType('key');
        setBastionKeyPath('~/.ssh/id_ed25519');
        setBastionAgentKeyPath('');
        setBastionPassphrase('');
        setBastionPassword('');
      }

      if (editingProfile.proxy?.enabled) {
        setProxyEnabled(true);
        setProxyType(editingProfile.proxy.proxyType || 'socks5');
        setProxyHost(editingProfile.proxy.host || '');
        setProxyPort(editingProfile.proxy.port || (editingProfile.proxy.proxyType === 'http' ? 8080 : 1080));
        setProxyUsername(editingProfile.proxy.username || '');
        setShowNetworkSettings(true);
        storageApi.getSecret(`${editingProfile.id}:proxy`).then((sec) => {
          if (!cancelled && sec) setProxyPassword(sec);
        });
      } else {
        setProxyEnabled(false);
        setProxyType('socks5');
        setProxyHost('');
        setProxyPort(1080);
        setProxyUsername('');
        setProxyPassword('');
      }
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
      setAgentKeyPath('');
      setAgentSocket('');
      setPassphrase('');
      setPassword('');
      setUseSudo(false);
      setBastionEnabled(false);
      setBastionMode('profile');
      setBastionProfileId('');
      setBastionHost('');
      setBastionPort(22);
      setBastionUsername('');
      setBastionAuthType('key');
      setBastionKeyPath('~/.ssh/id_ed25519');
      setBastionAgentKeyPath('');
      setBastionPassphrase('');
      setBastionPassword('');
      setProxyEnabled(false);
      setProxyType('socks5');
      setProxyHost('');
      setProxyPort(1080);
      setProxyUsername('');
      setProxyPassword('');
      setShowNetworkSettings(false);
      setTestResult(null);
      setIsTesting(false);
      setShowLogs(false);
    }

    return () => {
      cancelled = true;
    };
  }, [editingProfile, isNewConnectionModalOpen]);

  if (!isNewConnectionModalOpen) return null;

  const handleClose = () => {
    setIsTesting(false);
    setTestResult(null);
    setShowLogs(false);
    setEditingProfile(null);
    setNewConnectionModalOpen(false);
  };

  /** Key path sent for the selected method: private key, optional agent public key, or none. */
  const effectiveKeyPath = (): string | undefined =>
    authType === 'key' ? keyPath.trim() || undefined : authType === 'agent' ? agentKeyPath.trim() || undefined : undefined;
  const effectiveBastionKeyPath = (): string | undefined =>
    bastionAuthType === 'key'
      ? bastionKeyPath.trim() || undefined
      : bastionAuthType === 'agent'
      ? bastionAgentKeyPath.trim() || undefined
      : undefined;
  const effectiveAgentSocket = (): string | undefined =>
    authType === 'agent' ? agentSocket.trim() || undefined : undefined;

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

  const handleBrowseAgentKey = async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: "Sélectionner la clé à utiliser dans l'agent (.pub ou clé privée)",
      });
      if (selected && typeof selected === 'string') {
        setAgentKeyPath(selected);
        setTestResult(null);
      }
    } catch (err) {
      console.warn('Dialog not available in browser mode:', err);
    }
  };

  const handleBrowseBastionKey = async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: 'Sélectionner la clé privée SSH du Bastion',
      });
      if (selected && typeof selected === 'string') {
        setBastionKeyPath(selected);
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

    if (bastionEnabled && effectiveBastionMode === 'custom' && !bastionHost.trim()) {
      setTestResult({
        type: 'error',
        message: 'Veuillez renseigner l\'hôte du Bastion SSH.',
        logs: [`[${new Date().toLocaleTimeString()}] ❌ Erreur de validation : Le champ Hôte du Bastion est obligatoire lorsque le bastion est activé.`],
      });
      return;
    }

    if (proxyEnabled && !proxyHost.trim()) {
      setTestResult({
        type: 'error',
        message: 'Veuillez renseigner l\'hôte du Proxy.',
        logs: [`[${new Date().toLocaleTimeString()}] ❌ Erreur de validation : Le champ Hôte du Proxy est obligatoire lorsque le proxy réseau est activé.`],
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

      let bastionParam = undefined;
      if (bastionEnabled) {
        const effectiveBastionPid = effectiveBastionMode === 'profile' ? (bastionProfileId || otherSftpProfiles[0]?.id) : undefined;
        if (effectiveBastionMode === 'profile' && effectiveBastionPid) {
          bastionParam = {
            enabled: true,
            profileId: effectiveBastionPid,
          };
        } else if (bastionHost.trim()) {
          bastionParam = {
            enabled: true,
            host: bastionHost.trim(),
            port: resolvePort(bastionPort, 22),
            username: bastionUsername.trim(),
            authType: bastionAuthType,
            keyPath: effectiveBastionKeyPath(),
            password: bastionAuthType === 'password' ? bastionPassword.trim() || undefined : undefined,
            passphrase: bastionAuthType === 'key' ? bastionPassphrase.trim() || undefined : undefined,
          };
        }
      }

      let proxyParam = undefined;
      if (proxyEnabled && proxyHost.trim()) {
        proxyParam = {
          enabled: true,
          proxyType,
          host: proxyHost.trim(),
          port: resolvePort(proxyPort, proxyType === 'http' ? 8080 : 1080),
          username: proxyUsername.trim() || undefined,
          password: proxyPassword.trim() || undefined,
        };
      }

      const res = await Promise.race([
        storageApi.testSftp({
          profile_id: editingProfile?.id || `test-${Date.now()}`,
          host: host.trim(),
          port: resolvePort(port, 22),
          username: username.trim(),
          auth_type: authType,
          password: authType === 'password' ? password.trim() : undefined,
          key_path: effectiveKeyPath(),
          passphrase: authType === 'key' ? passphrase.trim() || undefined : undefined,
          agent_socket: effectiveAgentSocket(),
          use_sudo: useSudo,
          bastion: bastionParam,
          proxy: proxyParam,
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

    if (type === 'sftp') {
      if (bastionEnabled && effectiveBastionMode === 'custom' && !bastionHost.trim()) {
        setShowNetworkSettings(true);
        setTestResult({
          type: 'error',
          message: 'Veuillez renseigner l\'hôte du Bastion SSH.',
          logs: [`[${new Date().toLocaleTimeString()}] ❌ Erreur de validation : Le champ Hôte du Bastion est obligatoire lorsque le bastion est activé.`],
        });
        return;
      }
      if (proxyEnabled && !proxyHost.trim()) {
        setShowNetworkSettings(true);
        setTestResult({
          type: 'error',
          message: 'Veuillez renseigner l\'hôte du Proxy.',
          logs: [`[${new Date().toLocaleTimeString()}] ❌ Erreur de validation : Le champ Hôte du Proxy est obligatoire lorsque le proxy réseau est activé.`],
        });
        return;
      }
    }

    const secret =
      type === 's3'
        ? secretKey.trim()
        : authType === 'key'
        ? passphrase.trim()
        : authType === 'password'
        ? password.trim()
        : '';

    let bastionConfig = undefined;
    let bastionSecretToSave: string | undefined = undefined;
    if (type === 'sftp') {
      if (bastionEnabled) {
        const effectiveBastionPid = effectiveBastionMode === 'profile' ? (bastionProfileId || otherSftpProfiles[0]?.id) : undefined;
        if (effectiveBastionMode === 'profile' && effectiveBastionPid) {
          bastionConfig = {
            enabled: true,
            profileId: effectiveBastionPid,
          };
          bastionSecretToSave = '';
        } else if (bastionHost.trim()) {
          bastionConfig = {
            enabled: true,
            host: bastionHost.trim(),
            port: resolvePort(bastionPort, 22),
            username: bastionUsername.trim(),
            authType: bastionAuthType,
            keyPath: effectiveBastionKeyPath(),
          };
          bastionSecretToSave =
            bastionAuthType === 'password'
              ? bastionPassword.trim()
              : bastionAuthType === 'key'
              ? bastionPassphrase.trim()
              : '';
        }
      } else {
        bastionSecretToSave = '';
      }
    }

    let proxyConfig = undefined;
    let proxySecretToSave: string | undefined = undefined;
    if (type === 'sftp') {
      if (proxyEnabled && proxyHost.trim()) {
        proxyConfig = {
          enabled: true,
          proxyType,
          host: proxyHost.trim(),
          port: resolvePort(proxyPort, proxyType === 'http' ? 8080 : 1080),
          username: proxyUsername.trim() || undefined,
        };
        proxySecretToSave = proxyPassword.trim();
      } else {
        proxySecretToSave = '';
      }
    }

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
              agentSocket: undefined,
              bastion: undefined,
              proxy: undefined,
            }
          : {
              host: host.trim(),
              port: resolvePort(port, 22),
              username: username.trim(),
              authType,
              keyPath: effectiveKeyPath(),
              agentSocket: effectiveAgentSocket(),
              useSudo,
              bastion: bastionConfig,
              proxy: proxyConfig,
              endpoint: undefined,
              bucket: undefined,
              region: undefined,
              accessKey: undefined,
            }),
      };
      // Switching to agent auth drops any password/passphrase left in the OS keyring.
      const secretUpdate = type === 'sftp' && authType === 'agent' ? '' : secret || undefined;
      await updateProfile(updatedProfile, secretUpdate, bastionSecretToSave, proxySecretToSave);
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
              port: resolvePort(port, 22),
              username: username.trim(),
              authType,
              keyPath: effectiveKeyPath(),
              agentSocket: effectiveAgentSocket(),
              useSudo,
              bastion: bastionConfig,
              proxy: proxyConfig,
            }),
      };
      await addProfile(newProfile, secret || undefined, bastionSecretToSave, proxySecretToSave);
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
                    min={0}
                    max={65535}
                    placeholder="22"
                    value={port}
                    onChange={(e) => {
                      setPort(parsePortInput(e.target.value));
                      setTestResult(null);
                    }}
                    onKeyDown={(e) => {
                      if (['e', 'E', '+', '-', '.'].includes(e.key)) {
                        e.preventDefault();
                      }
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
                <div className="grid grid-cols-3 gap-2 p-1 bg-surface-muted/80 rounded-lg border border-border-subtle">
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
                  <button
                    type="button"
                    onClick={() => {
                      setAuthType('agent');
                      setTestResult(null);
                    }}
                    className={`flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition-all ${
                      authType === 'agent'
                        ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                    title="ssh-agent, 1Password, Secretive…"
                  >
                    <Fingerprint className="w-3.5 h-3.5" />
                    <span>Agent SSH</span>
                  </button>
                </div>
              </div>

              {authType === 'agent' ? (
                <>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    Les clés restent dans l'agent (ssh-agent, 1Password, Secretive…) : Orbit ne stocke aucun secret.
                    Détection automatique via <span className="font-mono">SSH_AUTH_SOCK</span>, puis les emplacements
                    connus de 1Password et Secretive.
                  </p>

                  {/* Optional public key restricting the agent identity */}
                  <div>
                    <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                      Clé à utiliser dans l'agent (optionnel)
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        value={agentKeyPath}
                        onChange={(e) => {
                          setAgentKeyPath(e.target.value);
                          setTestResult(null);
                        }}
                        placeholder="~/.ssh/id_ed25519.pub — toutes les clés de l'agent si vide"
                        className="flex-1 bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-sky-500/50 font-mono"
                      />
                      <button
                        type="button"
                        onClick={handleBrowseAgentKey}
                        className="px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-xs font-medium text-zinc-200 border border-border-subtle transition-colors flex items-center gap-1.5 flex-shrink-0"
                        title="Ouvrir le sélecteur de fichier natif"
                      >
                        <FolderOpen className="w-3.5 h-3.5 text-sky-400" />
                        <span>Parcourir...</span>
                      </button>
                    </div>
                    <p className="mt-1 text-[10px] text-zinc-500">
                      Fichier .pub ou chemin de la clé privée : sert seulement à choisir l'identité, la clé privée
                      n'est jamais lue. Recommandé si l'agent contient beaucoup de clés (« Too many authentication
                      failures »).
                    </p>
                  </div>

                  {/* Optional agent socket override */}
                  <div>
                    <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                      Socket de l'agent (optionnel)
                    </label>
                    <input
                      type="text"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      value={agentSocket}
                      onChange={(e) => {
                        setAgentSocket(e.target.value);
                        setTestResult(null);
                      }}
                      placeholder="Automatique"
                      className="w-full bg-surface-muted border border-border-subtle rounded-md px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-sky-500/50 font-mono"
                    />
                  </div>
                </>
              ) : authType === 'key' ? (
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

              {/* Réseau, Bastion & Proxy Accordion */}
              <div className="pt-2 border-t border-white/5 space-y-3">
                <button
                  type="button"
                  onClick={() => setShowNetworkSettings(!showNetworkSettings)}
                  className="w-full flex items-center justify-between text-xs font-medium text-zinc-300 hover:text-white transition-colors py-1 group"
                >
                  <div className="flex items-center gap-2">
                    <Globe className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Réseau & Passerelle (Bastion SSH / Proxy)</span>
                    {(bastionEnabled || proxyEnabled) && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-mono">
                        {[bastionEnabled && 'Bastion', proxyEnabled && `Proxy ${proxyType.toUpperCase()}`].filter(Boolean).join(' + ')}
                      </span>
                    )}
                  </div>
                  {showNetworkSettings ? <ChevronUp className="w-3.5 h-3.5 text-zinc-400 group-hover:text-white" /> : <ChevronDown className="w-3.5 h-3.5 text-zinc-400 group-hover:text-white" />}
                </button>

                {showNetworkSettings && (
                  <div className="space-y-4 p-3 bg-surface-muted/40 rounded-lg border border-border-subtle text-xs animate-in fade-in duration-150">
                    {/* --- Bastion Section --- */}
                    <div className="space-y-3">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={bastionEnabled}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setBastionEnabled(checked);
                            if (checked && !bastionProfileId && otherSftpProfiles.length > 0) {
                              setBastionProfileId(otherSftpProfiles[0].id);
                            }
                            setTestResult(null);
                          }}
                          className="w-4 h-4 rounded border-border-subtle bg-surface-muted text-sky-600 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                        />
                        <span className="font-semibold text-white flex items-center gap-1.5">
                          <Network className="w-3.5 h-3.5 text-sky-400" />
                          Passer par un Bastion SSH (Jump Host / ProxyJump)
                        </span>
                      </label>

                      {bastionEnabled && (
                        <div className="pl-6 space-y-3 border-l-2 border-sky-500/30 pt-1">
                          {otherSftpProfiles.length > 0 && (
                            <div className="flex items-center gap-4 text-[11px] mb-2">
                              <label className="flex items-center gap-1.5 cursor-pointer text-zinc-300">
                                <input
                                  type="radio"
                                  name="bastionMode"
                                  checked={bastionMode === 'profile'}
                                  onChange={() => {
                                    setBastionMode('profile');
                                    if (!bastionProfileId && otherSftpProfiles[0]) {
                                      setBastionProfileId(otherSftpProfiles[0].id);
                                    }
                                    setTestResult(null);
                                  }}
                                  className="text-sky-500 focus:ring-0 cursor-pointer"
                                />
                                <span>Utiliser un profil SFTP existant</span>
                              </label>
                              <label className="flex items-center gap-1.5 cursor-pointer text-zinc-300">
                                <input
                                  type="radio"
                                  name="bastionMode"
                                  checked={bastionMode === 'custom'}
                                  onChange={() => {
                                    setBastionMode('custom');
                                    setTestResult(null);
                                  }}
                                  className="text-sky-500 focus:ring-0 cursor-pointer"
                                />
                                <span>Configuration personnalisée</span>
                              </label>
                            </div>
                          )}

                          {bastionMode === 'profile' && otherSftpProfiles.length > 0 ? (
                            <div>
                              <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                                Sélectionner la passerelle SSH
                              </label>
                              <select
                                value={bastionProfileId || otherSftpProfiles[0]?.id || ''}
                                onChange={(e) => {
                                  setBastionProfileId(e.target.value);
                                  setTestResult(null);
                                }}
                                className="w-full bg-surface-muted border border-border-subtle rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-500/50"
                              >
                                {otherSftpProfiles.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name} ({p.username}@{p.host}:{p.port || 22})
                                  </option>
                                ))}
                              </select>
                            </div>
                          ) : (
                            <div className="space-y-3">
                              <div className="grid grid-cols-4 gap-2">
                                <div className="col-span-3">
                                  <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                                    Hôte du Bastion
                                  </label>
                                  <input
                                    type="text"
                                    value={bastionHost}
                                    onChange={(e) => {
                                      setBastionHost(e.target.value);
                                      setTestResult(null);
                                    }}
                                    placeholder="jump.mondomaine.com"
                                    className="w-full bg-surface-muted border border-border-subtle rounded-md px-2.5 py-1 text-xs text-white font-mono placeholder-zinc-500 focus:outline-none focus:border-sky-500/50"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                                    Port
                                  </label>
                                  <input
                                    type="number"
                                    min={0}
                                    max={65535}
                                    placeholder="22"
                                    value={bastionPort}
                                    onChange={(e) => {
                                      setBastionPort(parsePortInput(e.target.value));
                                      setTestResult(null);
                                    }}
                                    onKeyDown={(e) => {
                                      if (['e', 'E', '+', '-', '.'].includes(e.key)) {
                                        e.preventDefault();
                                      }
                                    }}
                                    className="w-full bg-surface-muted border border-border-subtle rounded-md px-2.5 py-1 text-xs text-white placeholder-zinc-500 font-mono focus:outline-none focus:border-sky-500/50"
                                  />
                                </div>
                              </div>

                              <div>
                                <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                                  Utilisateur Bastion
                                </label>
                                <input
                                  type="text"
                                  value={bastionUsername}
                                  onChange={(e) => {
                                    setBastionUsername(e.target.value);
                                    setTestResult(null);
                                  }}
                                  placeholder="bastion-user"
                                  className="w-full bg-surface-muted border border-border-subtle rounded-md px-2.5 py-1 text-xs text-white font-mono placeholder-zinc-500 focus:outline-none focus:border-sky-500/50"
                                />
                              </div>

                              <div>
                                <div className="grid grid-cols-3 gap-1.5 p-0.5 bg-black/20 rounded-md border border-border-subtle mb-2">
                                  <button
                                    type="button"
                                    onClick={() => setBastionAuthType('key')}
                                    className={`py-1 rounded text-[11px] font-medium ${bastionAuthType === 'key' ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30' : 'text-zinc-400 hover:text-white'}`}
                                  >
                                    Clé SSH
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setBastionAuthType('password')}
                                    className={`py-1 rounded text-[11px] font-medium ${bastionAuthType === 'password' ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30' : 'text-zinc-400 hover:text-white'}`}
                                  >
                                    Mot de passe
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setBastionAuthType('agent')}
                                    className={`py-1 rounded text-[11px] font-medium ${bastionAuthType === 'agent' ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30' : 'text-zinc-400 hover:text-white'}`}
                                  >
                                    Agent SSH
                                  </button>
                                </div>

                                {bastionAuthType === 'agent' ? (
                                  <input
                                    type="text"
                                    value={bastionAgentKeyPath}
                                    onChange={(e) => setBastionAgentKeyPath(e.target.value)}
                                    placeholder="Clé à utiliser dans l'agent (.pub, optionnel)"
                                    className="w-full bg-surface-muted border border-border-subtle rounded-md px-2.5 py-1 text-xs text-white font-mono placeholder-zinc-500 focus:outline-none focus:border-sky-500/50"
                                  />
                                ) : bastionAuthType === 'key' ? (
                                  <div className="space-y-2">
                                    <div className="flex gap-1.5">
                                      <input
                                        type="text"
                                        value={bastionKeyPath}
                                        onChange={(e) => setBastionKeyPath(e.target.value)}
                                        placeholder="~/.ssh/id_ed25519"
                                        className="flex-1 bg-surface-muted border border-border-subtle rounded-md px-2.5 py-1 text-xs text-white font-mono placeholder-zinc-500 focus:outline-none focus:border-sky-500/50"
                                      />
                                      <button
                                        type="button"
                                        onClick={handleBrowseBastionKey}
                                        className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-[11px] text-zinc-300 border border-border-subtle"
                                      >
                                        Parcourir...
                                      </button>
                                    </div>
                                    <input
                                      type="password"
                                      value={bastionPassphrase}
                                      onChange={(e) => setBastionPassphrase(e.target.value)}
                                      placeholder="Passphrase Bastion (si chiffrée)"
                                      className="w-full bg-surface-muted border border-border-subtle rounded-md px-2.5 py-1 text-xs text-white font-mono placeholder-zinc-500 focus:outline-none focus:border-sky-500/50"
                                    />
                                  </div>
                                ) : (
                                  <div className="relative flex items-center">
                                    <input
                                      type={showBastionPassword ? 'text' : 'password'}
                                      value={bastionPassword}
                                      onChange={(e) => setBastionPassword(e.target.value)}
                                      placeholder="Mot de passe Bastion"
                                      className="w-full bg-surface-muted border border-border-subtle rounded-md pl-2.5 pr-8 py-1 text-xs text-white font-mono placeholder-zinc-500 focus:outline-none focus:border-sky-500/50"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => setShowBastionPassword(!showBastionPassword)}
                                      className="absolute right-2 text-zinc-400 hover:text-white"
                                    >
                                      {showBastionPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* --- Proxy Section --- */}
                    <div className="space-y-3 pt-3 border-t border-white/5">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={proxyEnabled}
                          onChange={(e) => {
                            setProxyEnabled(e.target.checked);
                            setTestResult(null);
                          }}
                          className="w-4 h-4 rounded border-border-subtle bg-surface-muted text-emerald-600 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                        />
                        <span className="font-semibold text-white flex items-center gap-1.5">
                          <Globe className="w-3.5 h-3.5 text-emerald-400" />
                          Passer par un Proxy réseau (SOCKS5 / HTTP)
                        </span>
                      </label>

                      {proxyEnabled && (
                        <div className="pl-6 space-y-3 border-l-2 border-emerald-500/30 pt-1">
                          <div className="grid grid-cols-2 gap-1.5 p-0.5 bg-black/20 rounded-md border border-border-subtle">
                            <button
                              type="button"
                              onClick={() => {
                                setProxyType('socks5');
                                if (resolvePort(proxyPort, 8080) === 8080) setProxyPort(1080);
                                setTestResult(null);
                              }}
                              className={`py-1 rounded text-[11px] font-medium ${proxyType === 'socks5' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'text-zinc-400 hover:text-white'}`}
                            >
                              SOCKS5
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setProxyType('http');
                                if (resolvePort(proxyPort, 1080) === 1080) setProxyPort(8080);
                                setTestResult(null);
                              }}
                              className={`py-1 rounded text-[11px] font-medium ${proxyType === 'http' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'text-zinc-400 hover:text-white'}`}
                            >
                              HTTP CONNECT
                            </button>
                          </div>

                          {proxyType === 'http' && (
                            <div className="flex items-start gap-1.5 p-2 rounded-md bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-300">
                              <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-amber-400" />
                              <span>
                                Les proxys HTTP CONNECT transmettent les identifiants d'authentification en clair (Base64 non chiffré) sur le réseau local. Utilisez un réseau de confiance ou SOCKS5.
                              </span>
                            </div>
                          )}

                          <div className="grid grid-cols-4 gap-2">
                            <div className="col-span-3">
                              <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                                Hôte du Proxy
                              </label>
                              <input
                                type="text"
                                value={proxyHost}
                                onChange={(e) => {
                                  setProxyHost(e.target.value);
                                  setTestResult(null);
                                }}
                                placeholder="127.0.0.1 ou proxy.entreprise.lan"
                                className="w-full bg-surface-muted border border-border-subtle rounded-md px-2.5 py-1 text-xs text-white font-mono placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                                Port
                              </label>
                              <input
                                type="number"
                                min={0}
                                max={65535}
                                placeholder={proxyType === 'http' ? '8080' : '1080'}
                                value={proxyPort}
                                onChange={(e) => {
                                  setProxyPort(parsePortInput(e.target.value));
                                  setTestResult(null);
                                }}
                                onKeyDown={(e) => {
                                  if (['e', 'E', '+', '-', '.'].includes(e.key)) {
                                    e.preventDefault();
                                  }
                                }}
                                className="w-full bg-surface-muted border border-border-subtle rounded-md px-2.5 py-1 text-xs text-white placeholder-zinc-500 font-mono focus:outline-none focus:border-emerald-500/50"
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                                Utilisateur (optionnel)
                              </label>
                              <input
                                type="text"
                                value={proxyUsername}
                                onChange={(e) => {
                                  setProxyUsername(e.target.value);
                                  setTestResult(null);
                                }}
                                placeholder="proxy-user"
                                className="w-full bg-surface-muted border border-border-subtle rounded-md px-2.5 py-1 text-xs text-white font-mono placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                                Mot de passe (optionnel)
                              </label>
                              <div className="relative flex items-center">
                                <input
                                  type={showProxyPassword ? 'text' : 'password'}
                                  value={proxyPassword}
                                  onChange={(e) => {
                                    setProxyPassword(e.target.value);
                                    setTestResult(null);
                                  }}
                                  placeholder="••••••••"
                                  className="w-full bg-surface-muted border border-border-subtle rounded-md pl-2.5 pr-8 py-1 text-xs text-white font-mono placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50"
                                />
                                <button
                                  type="button"
                                  onClick={() => setShowProxyPassword(!showProxyPassword)}
                                  className="absolute right-2 text-zinc-400 hover:text-white"
                                >
                                  {showProxyPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
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
