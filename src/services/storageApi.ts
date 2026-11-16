import { invoke, Channel } from '@tauri-apps/api/core';
import { ConnectionProfile, ConnectionTestResult, FileEntry, HostKeyDecision, HostKeyPromptRequest, S3ConnectParams, SftpSessionInfo, UpdateCheckResult } from '../types';
import { APP_VERSION } from '../version';
import { MOCK_REMOTE_FILES, MOCK_PREVIEWS } from '../data/mockData';

export interface SftpConnectParams {
  profile_id: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  key_path?: string;
  passphrase?: string;
  use_sudo?: boolean;
  sudo_password?: string;
}

export interface BackendTransferProgress {
  transfer_id: string;
  bytes_transferred: number;
  total_bytes: number;
  speed_bps: number;
  status: string;
}

export const isTauri = () => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
};

export { isPermissionDeniedError } from '../lib/permissionError';

export function isCancelledError(err: any): boolean {
  if (err?.type === 'Cancelled') return true;
  const msg = typeof err === 'string' ? err : err?.message || JSON.stringify(err);
  return msg.includes('Connexion annulée') || msg.includes('Cancelled');
}

export function formatConnectionError(err: any): string {
  const msg = typeof err === 'string' ? err : err?.message || JSON.stringify(err);

  if (msg.includes('Failed to connect to host') || msg.includes('Connection refused') || msg.includes('timed out')) {
    return 'Hôte injoignable : Vérifiez l\'adresse IP/domaine, le port et l\'état du serveur SSH.';
  }
  if (msg.includes('Could not load SSH key')) {
    return 'Clé SSH introuvable ou illisible : Vérifiez le chemin du fichier et les permissions.';
  }
  if (msg.includes('SSH key authentication rejected') || msg.includes('Invalid username or password') || msg.includes('auth failed')) {
    return 'Authentification refusée : Nom d\'utilisateur, clé SSH ou mot de passe incorrect.';
  }
  if (msg.includes('No password or valid SSH key provided')) {
    return 'Authentification manquante : Veuillez indiquer un mot de passe ou sélectionner une clé SSH valide.';
  }
  if (msg.includes('Keyring error')) {
    return 'Erreur de trousseau OS : Impossible d\'accéder au trousseau de clés du système.';
  }
  return msg;
}

export const storageApi = {
  async testSftp(params: SftpConnectParams): Promise<ConnectionTestResult> {
    if (!isTauri()) {
      await new Promise((r) => setTimeout(r, 600));
      if (!params.host) {
        return {
          success: false,
          message: 'Veuillez renseigner une adresse d\'hôte valide.',
          logs: [
            `[${new Date().toLocaleTimeString()}] Validation des paramètres...`,
            `[${new Date().toLocaleTimeString()}] ❌ Erreur : Hôte manquant`,
          ],
        };
      }
      return {
        success: true,
        message: 'Test réussi (mode simulé) : Serveur accessible et authentification validée.',
        logs: [
          `[${new Date().toLocaleTimeString()}] Démarrage de la séquence de test...`,
          `[${new Date().toLocaleTimeString()}] Connexion socket TCP vers ${params.host}:${params.port}...`,
          `[${new Date().toLocaleTimeString()}] Socket connecté. Négociation SSH KEX réussie.`,
          `[${new Date().toLocaleTimeString()}] Authentification utilisateur '${params.username}' validée.`,
          `[${new Date().toLocaleTimeString()}] ✅ Sous-système SFTP ouvert avec succès.`,
        ],
      };
    }
    try {
      const res = await invoke<ConnectionTestResult>('test_sftp_connection', { config: params });
      return {
        ...res,
        message: res.success ? res.message : formatConnectionError(res.message),
      };
    } catch (err: any) {
      return {
        success: false,
        message: formatConnectionError(err),
        logs: [`[Erreur Système] ${err?.message || err}`],
      };
    }
  },

  async connectSftp(params: SftpConnectParams): Promise<SftpSessionInfo> {
    if (!isTauri()) {
      console.log('[Mock] Connecting SFTP:', params);
      return {
        profile_id: params.profile_id,
        is_elevated: params.use_sudo ?? false,
        sudo_capability: 'passwordless',
      };
    }
    try {
      return await invoke<SftpSessionInfo>('connect_sftp', { config: params });
    } catch (err: any) {
      if (isCancelledError(err)) {
        const error = new Error('Connexion annulée : le profil a été déconnecté.');
        (error as any).type = 'Cancelled';
        throw error;
      }
      throw new Error(formatConnectionError(err));
    }
  },

  async testS3Connection(params: S3ConnectParams): Promise<ConnectionTestResult> {
    if (!isTauri()) {
      return {
        success: true,
        message: 'Connexion S3 établie avec succès ! Accès au bucket validé.',
        logs: [
          `[${new Date().toLocaleTimeString()}] Résolution du bucket '${params.bucket}'`,
          `[${new Date().toLocaleTimeString()}] Endpoint : ${params.endpoint || 'AWS S3 Standard'}`,
          `[${new Date().toLocaleTimeString()}] Région : ${params.region || 'auto'}`,
          `[${new Date().toLocaleTimeString()}] ✅ Accès au bucket validé avec succès.`,
        ],
      };
    }
    try {
      return await invoke<ConnectionTestResult>('test_s3_connection', { config: params });
    } catch (err: any) {
      return {
        success: false,
        message: err?.message || String(err),
        logs: [`[Erreur Système] ${err?.message || err}`],
      };
    }
  },

  async connectS3(params: S3ConnectParams): Promise<SftpSessionInfo> {
    if (!isTauri()) {
      console.log('[Mock] Connecting S3:', {
        profile_id: params.profile_id,
        bucket: params.bucket,
        endpoint: params.endpoint,
        region: params.region,
        hasAccessKey: Boolean(params.accessKey),
        hasSecretKey: Boolean(params.secretKey),
      });
      return {
        profile_id: params.profile_id,
        is_elevated: false,
        sudo_capability: 'none',
      };
    }
    try {
      return await invoke<SftpSessionInfo>('connect_s3', { config: params });
    } catch (err: any) {
      if (isCancelledError(err)) {
        const error = new Error('Connexion annulée : le profil a été déconnecté.');
        (error as any).type = 'Cancelled';
        throw error;
      }
      throw new Error(err?.message || String(err));
    }
  },

  async getSessionInfo(profileId?: string): Promise<SftpSessionInfo | null> {
    if (!isTauri()) {
      return null;
    }
    try {
      return await invoke<SftpSessionInfo>('get_session_info', { profileId });
    } catch {
      return null;
    }
  },

  async disconnect(profileId: string): Promise<void> {
    if (!isTauri()) {
      console.log('[Mock] Disconnected:', profileId);
      return;
    }
    await invoke('disconnect', { profileId });
  },

  async respondHostKeyPrompt(requestId: string, decision: HostKeyDecision): Promise<boolean> {
    if (!isTauri()) {
      console.log('[Mock] respondHostKeyPrompt:', requestId, decision);
      return true;
    }
    return await invoke<boolean>('respond_host_key_prompt', {
      requestId,
      decision,
    });
  },

  async getPendingHostKeyPrompts(): Promise<HostKeyPromptRequest[]> {
    if (!isTauri()) {
      return [];
    }
    return await invoke<HostKeyPromptRequest[]>('get_pending_host_key_prompts');
  },

  async listDir(profileId: string | undefined, path: string): Promise<FileEntry[]> {
    if (!isTauri()) {
      return MOCK_REMOTE_FILES[path] || [];
    }
    return await invoke<FileEntry[]>('storage_list_dir', {
      profileId: profileId || null,
      path,
    });
  },

  async createDir(profileId: string | undefined, path: string): Promise<void> {
    if (!isTauri()) {
      console.log('[Mock] createDir:', path);
      return;
    }
    await invoke('storage_create_dir', {
      profileId: profileId || null,
      path,
    });
  },

  async deleteFile(profileId: string | undefined, path: string, isDir: boolean): Promise<void> {
    if (!isTauri()) {
      console.log('[Mock] delete:', path, isDir);
      return;
    }
    await invoke('storage_delete', {
      profileId: profileId || null,
      path,
      isDir,
    });
  },

  async renameFile(profileId: string | undefined, oldPath: string, newPath: string): Promise<void> {
    if (!isTauri()) {
      console.log('[Mock] rename:', oldPath, '->', newPath);
      return;
    }
    await invoke('storage_rename', {
      profileId: profileId || null,
      oldPath,
      newPath,
    });
  },

  async readPreview(
    profileId: string | undefined,
    path: string,
    maxBytes = 2 * 1024 * 1024
  ): Promise<string> {
    if (!isTauri()) {
      return (
        MOCK_PREVIEWS[path] ||
        `// Mock aperçu pour ${path}\n// Connectez un vrai serveur SFTP pour lire le flux distant.`
      );
    }

    const bytes = await invoke<number[]>('storage_read_preview', {
      profileId: profileId || null,
      path,
      maxBytes,
    });

    const uint8 = new Uint8Array(bytes);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    return decoder.decode(uint8);
  },

  async uploadFile(
    profileId: string | undefined,
    localPath: string,
    remotePath: String,
    onProgress: (progress: BackendTransferProgress) => void
  ): Promise<void> {
    if (!isTauri()) {
      console.log('[Mock] uploadFile:', localPath, remotePath);
      return;
    }

    const channel = new Channel<BackendTransferProgress>();
    channel.onmessage = onProgress;

    await invoke('storage_upload_file', {
      profileId: profileId || null,
      localPath,
      remotePath,
      progressTx: channel,
    });
  },

  async downloadFile(
    profileId: string | undefined,
    remotePath: string,
    localPath: string,
    onProgress: (progress: BackendTransferProgress) => void
  ): Promise<void> {
    if (!isTauri()) {
      console.log('[Mock] downloadFile:', remotePath, localPath);
      return;
    }

    const channel = new Channel<BackendTransferProgress>();
    channel.onmessage = onProgress;

    await invoke('storage_download_file', {
      profileId: profileId || null,
      remotePath,
      localPath,
      progressTx: channel,
    });
  },

  async listLocalDir(path?: string): Promise<{ currentPath: string; entries: FileEntry[] }> {
    if (!isTauri()) {
      return {
        currentPath: path || '/',
        entries: [],
      };
    }
    const res = await invoke<{ current_path: string; entries: FileEntry[] }>('local_list_dir', {
      path: path || null,
    });
    return {
      currentPath: res.current_path,
      entries: res.entries,
    };
  },

  async readLocalPreview(path: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
    if (!isTauri()) {
      return `// Mock local aperçu pour ${path}`;
    }
    const bytes = await invoke<number[]>('local_read_preview', {
      path,
      maxBytes,
    });
    const uint8 = new Uint8Array(bytes);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    return decoder.decode(uint8);
  },

  async createLocalDir(path: string): Promise<void> {
    if (!isTauri()) {
      console.log('[Mock] createLocalDir:', path);
      return;
    }
    await invoke('local_create_dir', { path });
  },

  async deleteLocalItem(path: string): Promise<void> {
    if (!isTauri()) {
      console.log('[Mock] deleteLocalItem:', path);
      return;
    }
    await invoke('local_delete', { path });
  },

  async renameLocalItem(oldPath: string, newPath: string): Promise<void> {
    if (!isTauri()) {
      console.log('[Mock] renameLocalItem:', oldPath, '->', newPath);
      return;
    }
    await invoke('local_rename', { oldPath, newPath });
  },

  async saveSecret(profileId: string, secret: string): Promise<void> {
    if (!isTauri()) return;
    await invoke('save_secret', { profileId, secret });
  },

  async getSecret(profileId: string): Promise<string | null> {
    if (!isTauri()) return null;
    return await invoke<string | null>('get_secret', { profileId });
  },

  async deleteSecret(profileId: string): Promise<void> {
    if (!isTauri()) return;
    await invoke('delete_secret', { profileId });
  },

  async loadProfiles(): Promise<ConnectionProfile[]> {
    if (!isTauri()) {
      const stored = localStorage.getItem('orbit_connections');
      return stored ? JSON.parse(stored) : [];
    }
    return await invoke<ConnectionProfile[]>('load_profiles');
  },

  async saveProfile(profile: ConnectionProfile): Promise<void> {
    if (!isTauri()) {
      const stored = localStorage.getItem('orbit_connections');
      const list: ConnectionProfile[] = stored ? JSON.parse(stored) : [];
      const idx = list.findIndex((p) => p.id === profile.id);
      if (idx >= 0) {
        list[idx] = profile;
      } else {
        list.push(profile);
      }
      localStorage.setItem('orbit_connections', JSON.stringify(list));
      return;
    }
    await invoke('save_profile', { profile });
  },

  async deleteProfile(profileId: string): Promise<void> {
    if (!isTauri()) {
      const stored = localStorage.getItem('orbit_connections');
      const list: ConnectionProfile[] = stored ? JSON.parse(stored) : [];
      const filtered = list.filter((p) => p.id !== profileId);
      localStorage.setItem('orbit_connections', JSON.stringify(filtered));
      return;
    }
    await invoke('delete_profile', { profileId });
  },

  async checkAppUpdate(): Promise<UpdateCheckResult> {
    if (!isTauri()) {
      return {
        current_version: APP_VERSION,
        latest_version: APP_VERSION,
        has_update: false,
        release_name: `Orbit v${APP_VERSION}`,
        release_notes: 'Version actuelle (Mock)',
        published_at: new Date().toISOString(),
        release_url: 'https://github.com/matryt/Orbit/releases',
        download_url: null,
        asset_name: null,
      };
    }
    return await invoke<UpdateCheckResult>('check_app_update');
  },
};
