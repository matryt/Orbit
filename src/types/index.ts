export type StorageType = 's3' | 'sftp';

export type ProxyType = 'socks5' | 'http';

export interface ProxyConfig {
  enabled: boolean;
  proxyType?: ProxyType;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
}

export interface BastionConfig {
  enabled: boolean;
  profileId?: string;
  host?: string;
  port?: number;
  username?: string;
  authType?: 'password' | 'key';
  keyPath?: string;
  password?: string;
  passphrase?: string;
}

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
  bastion?: BastionConfig;
  proxy?: ProxyConfig;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink?: boolean;
  size: number;
  modified_at: string;
  permissions?: string;
  owner?: string;
  group?: string;
  etag?: string;
}

export interface TransferItem {
  id: string;
  /** Profile the transfer was started on (frozen when enqueued). */
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
  /**
   * True while the backend call is running. It can outlive a `cancelled` status: the Rust
   * side still has to stop and clean up, so the destination stays reserved until then.
   */
  inFlight?: boolean;
  /** Folder transfer this file belongs to, if any. */
  groupId?: string;
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


/** Entry of a recursive walk; `relative_path` is `/`-separated and relative to the walked root. */
export interface WalkEntry {
  relative_path: string;
  is_dir: boolean;
  size: number;
}

/** A folder transfer: one row in the drawer, backed by one TransferItem per file. */
export interface TransferGroup {
  id: string;
  name: string;
  direction: 'upload' | 'download';
  profileId: string;
  serverName?: string;
  serverType?: StorageType;
  /** scanning: walking the source tree; ready: files enqueued; failed/cancelled before enqueuing. */
  phase: 'scanning' | 'ready' | 'failed' | 'cancelled';
  error?: string;
  paused?: boolean;
}
