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
  authType?: 'password' | 'key';
  keyPath?: string;
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
  owner?: string;
  group?: string;
  etag?: string;
}

export interface TransferItem {
  id: string;
  serverName?: string;
  serverType?: StorageType;
  fileName: string;
  remotePath: string;
  localPath: string;
  direction: 'upload' | 'download';
  bytesTransferred: number;
  totalBytes: number;
  speedBps: number;
  status: 'queued' | 'transferring' | 'paused' | 'completed' | 'failed' | 'cancelled';
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  logs: string[];
}

export interface HostKeyPromptRequest {
  request_id: string;
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  is_new: boolean;
  changed_line?: number | null;
}

export type HostKeyDecision = 'accept_and_remember' | 'accept_once' | 'reject';

