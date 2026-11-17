export type StorageType = 's3' | 'sftp';

export interface ConnectionProfile {
  id: string;
  name: string;
  type: StorageType;
  endpoint?: string;
  bucket?: string;
  region?: string;
  accessKey?: string;
  host?: string;
  port?: number;
  username?: string;
  authType?: 'password' | 'key';
  keyPath?: string;
  status: 'connected' | 'idle' | 'error';
  isFavorite: boolean;
  useSudo?: boolean;
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
  /** Profil sur lequel le transfert a été lancé (figé à la mise en file). */
  profileId?: string | null;
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
  error?: string;
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

export interface UpdateCheckResult {
  current_version: string;
  latest_version: string;
  has_update: boolean;
  release_name: string;
  release_notes: string;
  published_at: string | null;
  release_url: string;
  download_url: string | null;
  asset_name: string | null;
}

export type SudoCapability = 'none' | 'passwordless' | 'password_required';

export interface SftpSessionInfo {
  profile_id: string;
  is_elevated: boolean;
  sudo_capability: SudoCapability;
}

export interface S3ConnectParams {
  profile_id: string;
  endpoint?: string;
  bucket: string;
  region?: string;
  accessKey: string;
  secretKey?: string;
  forcePathStyle?: boolean;
}

export interface NavigationError {
  pane: 'remote' | 'local';
  path: string;
  message: string;
  isPermissionDenied: boolean;
}

