export type StorageType = 's3' | 'sftp';

export interface ConnectionProfile {
  id: string;
  name: string;
  type: StorageType;
  endpoint?: string;
  bucket?: string;
  region?: string;
  host?: string;
  port?: number;
  username?: string;
  status: 'connected' | 'idle' | 'error';
  isFavorite: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified_at: string;
  permissions?: string;
  etag?: string;
}

export interface TransferItem {
  id: string;
  fileName: string;
  remotePath: string;
  localPath: string;
  direction: 'upload' | 'download';
  bytesTransferred: number;
  totalBytes: number;
  speedBps: number;
  status: 'queued' | 'transferring' | 'completed' | 'failed';
}
