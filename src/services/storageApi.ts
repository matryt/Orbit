import { invoke, Channel } from '@tauri-apps/api/core';
import { FileEntry } from '../types';
import { MOCK_REMOTE_FILES, MOCK_PREVIEWS } from '../data/mockData';

export interface SftpConnectParams {
  profile_id: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  key_path?: string;
  passphrase?: string;
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

export const storageApi = {
  async connectSftp(params: SftpConnectParams): Promise<void> {
    if (!isTauri()) {
      console.log('[Mock] Connecting SFTP:', params);
      return;
    }
    await invoke('connect_sftp', { config: params });
  },

  async disconnect(profileId: string): Promise<void> {
    if (!isTauri()) {
      console.log('[Mock] Disconnected:', profileId);
      return;
    }
    await invoke('disconnect', { profileId });
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
};
