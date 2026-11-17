import { create } from 'zustand';
import { ConnectionProfile, FileEntry, NavigationError, SudoCapability, TransferItem, UpdateCheckResult } from '../types';
import { MOCK_REMOTE_FILES } from '../data/mockData';
import { storageApi, BackendTransferProgress, isCancelledError, isPermissionDeniedError, SftpConnectParams } from '../services/storageApi';
import { buildNewFolderPath, buildRenamePath } from '../lib/pathUtils';
import { applyProgress, generateTransferId, isFinishedStatus, pickTransfersToStart } from '../lib/transferQueue';

export interface ActiveDragState {
  source: 'local' | 'remote';
  files: FileEntry[];
  currentX: number;
  currentY: number;
  isDragging: boolean;
  hoverPane: 'local' | 'remote' | null;
  hoverFolderPath: string | null;
}

interface OrbitState {
  // Profiles
  profiles: ConnectionProfile[];
  activeProfileId: string;
  loadPersistedProfiles: () => Promise<void>;
  setActiveProfile: (id: string) => Promise<void>;
  addProfile: (profile: ConnectionProfile, secret?: string) => Promise<void>;
  updateProfile: (profile: ConnectionProfile, secret?: string) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  connectProfile: (profileId: string, secret?: string) => Promise<void>;
  disconnectProfile: (id: string) => Promise<void>;

  // Editing profile modal state
  editingProfile: ConnectionProfile | null;
  setEditingProfile: (profile: ConnectionProfile | null) => void;

  // Connection state & error
  isConnecting: boolean;
  connectionError: string | null;
  clearConnectionError: () => void;
  isElevated: boolean;
  sudoCapability: SudoCapability;
  remoteNavigationError: NavigationError | null;
  localNavigationError: NavigationError | null;
  clearNavigationError: (pane: 'remote' | 'local') => void;
  elevateActiveSession: (targetPath?: string) => Promise<void>;

  // Active Pane (for keyboard shortcuts and Quick Look)
  activePane: 'remote' | 'local';
  setActivePane: (pane: 'remote' | 'local') => void;

  // Remote Explorer
  currentPath: string;
  setCurrentPath: (path: string) => Promise<void>;
  remoteFiles: FileEntry[];
  isLoadingFiles: boolean;
  getRemoteFiles: () => FileEntry[];
  selectedRemotePath: string | null;
  selectedRemotePaths: string[];
  selectRemoteFile: (path: string, multi?: boolean) => void;
  clearRemoteSelection: () => void;
  refreshRemote: () => Promise<void>;
  createRemoteFolder: (folderName: string) => Promise<void>;
  renameRemoteItem: (oldPath: string, newName: string) => Promise<void>;
  deleteRemoteItem: (path: string, isDir: boolean) => Promise<void>;

  // Local Explorer (for Dual Pane)
  localPath: string;
  setLocalPath: (path: string) => Promise<void>;
  localFiles: FileEntry[];
  isLoadingLocalFiles: boolean;
  getLocalFiles: () => FileEntry[];
  selectedLocalPath: string | null;
  selectedLocalPaths: string[];
  selectLocalFile: (path: string, multi?: boolean) => void;
  clearLocalSelection: () => void;
  refreshLocal: () => Promise<void>;
  createLocalFolder: (folderName: string) => Promise<void>;
  renameLocalItem: (oldPath: string, newName: string) => Promise<void>;
  deleteLocalItem: (path: string, isDir?: boolean) => Promise<void>;

  // View state
  isDualPane: boolean;
  toggleDualPane: () => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;

  // Quick Look modal
  quickLookFile: FileEntry | null;
  setQuickLookFile: (file: FileEntry | null) => void;
  toggleQuickLook: () => void;

  // Transfers
  transfers: TransferItem[];
  isTransferDrawerOpen: boolean;
  toggleTransferDrawer: () => void;
  setTransferDrawerOpen: (open: boolean) => void;
  pauseTransfer: (id: string) => void;
  resumeTransfer: (id: string) => void;
  cancelTransfer: (id: string) => void;
  clearCompletedTransfers: () => void;
  /** Starts queued transfers within the available concurrency slots. */
  processTransferQueue: () => void;
  uploadFile: (localPath: string, remotePath: string, fileName: string) => Promise<void>;
  downloadFile: (remotePath: string, localPath: string, fileName: string) => Promise<void>;

  // Dual-Pane Pointer Drag and Drop State
  activeDrag: ActiveDragState | null;
  setActiveDrag: (drag: ActiveDragState | null) => void;

  // Modals
  isNewConnectionModalOpen: boolean;
  setNewConnectionModalOpen: (open: boolean) => void;
  isExportModalOpen: boolean;
  setExportModalOpen: (open: boolean) => void;
  isNewFolderModalOpen: boolean;
  setNewFolderModalOpen: (open: boolean) => void;

  // Updates
  availableUpdate: UpdateCheckResult | null;
  isCheckingUpdate: boolean;
  isUpdateModalOpen: boolean;
  updateCheckError: string | null;
  lastUpdateCheckTime: number;
  checkForUpdates: (notifyIfUpToDate?: boolean) => Promise<void>;
  setUpdateModalOpen: (open: boolean) => void;
  dismissUpdate: () => void;
}

let remoteNavGen = 0;
let localNavGen = 0;

// ─── Transfers ────────────────────────────────────────────────────────────────

type StoreSet = (fn: (state: OrbitState) => Partial<OrbitState>) => void;
type StoreGet = () => OrbitState;

/** Cancellations requested before the backend registered the transfer. */
const pendingCancels = new Set<string>();

function updateTransfer(
  set: StoreSet,
  id: string,
  patch: Partial<TransferItem>,
  onlyIfStatus?: TransferItem['status'][]
) {
  set((state) => ({
    transfers: state.transfers.map((tx) =>
      tx.id === id && (!onlyIfStatus || onlyIfStatus.includes(tx.status)) ? { ...tx, ...patch } : tx
    ),
  }));
}

function enqueueTransfer(
  set: StoreSet,
  get: StoreGet,
  params: Pick<TransferItem, 'direction' | 'localPath' | 'remotePath' | 'fileName'>
) {
  const { activeProfileId, profiles } = get();
  const profile = profiles.find((p) => p.id === activeProfileId);

  const item: TransferItem = {
    id: generateTransferId(),
    profileId: activeProfileId,
    serverName: profile?.name || 'SFTP Server',
    serverType: profile?.type || 'sftp',
    ...params,
    bytesTransferred: 0,
    totalBytes: 0,
    speedBps: 0,
    status: 'queued',
  };

  set((state) => ({
    transfers: [item, ...state.transfers],
    isTransferDrawerOpen: true,
  }));
  get().processTransferQueue();
}

async function runTransfer(set: StoreSet, get: StoreGet, tx: TransferItem) {
  const onProgress = (p: BackendTransferProgress) => {
    if (pendingCancels.has(tx.id)) {
      storageApi.cancelTransfer(tx.id).catch(() => {});
    }
    set((state) => ({
      transfers: state.transfers.map((t) => (t.id === tx.id ? applyProgress(t, p) : t)),
    }));
  };

  try {
    if (tx.direction === 'upload') {
      await storageApi.uploadFile(tx.profileId ?? undefined, tx.id, tx.localPath, tx.remotePath, onProgress);
    } else {
      await storageApi.downloadFile(tx.profileId ?? undefined, tx.id, tx.remotePath, tx.localPath, onProgress);
    }
    // The file made it: show it as completed even if a late cancellation was requested.
    updateTransfer(set, tx.id, { status: 'completed', speedBps: 0 });

    const state = get();
    if (tx.direction === 'upload' && state.activeProfileId === tx.profileId) {
      await state.refreshRemote();
    } else if (tx.direction === 'download' && state.isDualPane) {
      await state.refreshLocal();
    }
  } catch (err: any) {
    if (isCancelledError(err) || pendingCancels.has(tx.id)) {
      updateTransfer(set, tx.id, { status: 'cancelled', speedBps: 0 });
    } else {
      console.error(`[Orbit] ${tx.direction === 'upload' ? 'Upload' : 'Download'} failed:`, err);
      const errorMsg = typeof err === 'string' ? err : err?.message || 'Erreur lors du transfert';
      updateTransfer(set, tx.id, { status: 'failed', speedBps: 0, error: errorMsg });
    }
  } finally {
    pendingCancels.delete(tx.id);
    get().processTransferQueue();
  }
}

export const useOrbitStore = create<OrbitState>((set, get) => ({
  profiles: [],
  activeProfileId: '',
  isConnecting: false,
  connectionError: null,
  clearConnectionError: () => set({ connectionError: null }),
  isElevated: false,
  sudoCapability: 'none',
  remoteNavigationError: null,
  localNavigationError: null,
  clearNavigationError: (pane) => {
    if (pane === 'remote') set({ remoteNavigationError: null });
    else set({ localNavigationError: null });
  },

  loadPersistedProfiles: async () => {
    try {
      const persisted = await storageApi.loadProfiles();
      if (persisted && persisted.length > 0) {
        set({ profiles: persisted });
        const currentActive = get().activeProfileId;
        const exists = persisted.some((p) => p.id === currentActive);
        if (!currentActive || !exists) {
          await get().setActiveProfile(persisted[0].id);
        }
      } else {
        set({ profiles: [], activeProfileId: '', remoteFiles: [] });
      }
    } catch (err) {
      console.warn('Failed to load persisted profiles:', err);
    }
  },

  setActiveProfile: async (id) => {
    const profile = get().profiles.find((p) => p.id === id);
    set({
      activeProfileId: id,
      currentPath: '/',
      selectedRemotePath: null,
      selectedRemotePaths: [],
      connectionError: null,
      isElevated: false,
      sudoCapability: 'none',
      remoteNavigationError: null,
    });

    if (profile && (profile.type === 'sftp' || profile.type === 's3')) {
      await get().connectProfile(id);
    } else {
      const files = MOCK_REMOTE_FILES['/'] || [];
      set({ remoteFiles: files });
    }
  },

  addProfile: async (profile, secret) => {
    if (secret) {
      await storageApi.saveSecret(profile.id, secret);
    }

    try {
      await storageApi.saveProfile(profile);
    } catch (err) {
      console.error('Failed to persist profile to connections.json:', err);
    }

    set((state) => {
      const existingIdx = state.profiles.findIndex((p) => p.id === profile.id);
      const updated = existingIdx >= 0
        ? state.profiles.map((p) => (p.id === profile.id ? profile : p))
        : [...state.profiles, profile];
      return {
        profiles: updated,
        activeProfileId: profile.id,
        currentPath: '/',
      };
    });

    if (profile.type === 'sftp' || profile.type === 's3') {
      await get().connectProfile(profile.id, secret);
    }
  },

  editingProfile: null,
  setEditingProfile: (profile) => set({ editingProfile: profile, isNewConnectionModalOpen: profile !== null }),

  updateProfile: async (profile, secret) => {
    if (secret) {
      await storageApi.saveSecret(profile.id, secret);
    }

    try {
      await storageApi.saveProfile(profile);
    } catch (err) {
      console.error('Failed to update profile in connections.json:', err);
    }

    set((state) => ({
      profiles: state.profiles.map((p) => (p.id === profile.id ? profile : p)),
    }));

    if (get().activeProfileId === profile.id && (profile.type === 'sftp' || profile.type === 's3')) {
      await get().connectProfile(profile.id, secret);
    }
  },

  disconnectProfile: async (id: string) => {
    // Queued transfers on this profile can no longer start; running ones are
    // cancelled on the Rust side by the `disconnect` command.
    set((state) => ({
      transfers: state.transfers.map((tx) =>
        tx.profileId === id && tx.status === 'queued' ? { ...tx, status: 'cancelled' as const } : tx
      ),
    }));
    try {
      await storageApi.disconnect(id);
    } catch (err) {
      console.error('Failed to disconnect session:', err);
    }

    set((state) => ({
      profiles: state.profiles.map((p) =>
        p.id === id ? { ...p, status: 'idle' } : p
      ),
      ...(state.activeProfileId === id
        ? {
          remoteFiles: [],
          selectedRemotePath: null,
          selectedRemotePaths: [],
          isElevated: false,
          sudoCapability: 'none' as const,
          remoteNavigationError: null,
        }
        : {}),
    }));
  },

  deleteProfile: async (id: string) => {
    try {
      await storageApi.deleteProfile(id);
    } catch (err) {
      console.error('Failed to delete profile from storage:', err);
    }

    const { profiles, activeProfileId } = get();
    const remaining = profiles.filter((p) => p.id !== id);
    const nextActive = activeProfileId === id ? (remaining[0]?.id || '') : activeProfileId;

    set({
      profiles: remaining,
      activeProfileId: nextActive,
    });

    if (nextActive) {
      await get().setActiveProfile(nextActive);
    } else {
      set({
        remoteFiles: [],
        currentPath: '/',
        selectedRemotePath: null,
        selectedRemotePaths: [],
        isElevated: false,
        sudoCapability: 'none',
        remoteNavigationError: null,
      });
    }
  },

  connectProfile: async (profileId, secret) => {
    const profile = get().profiles.find((p) => p.id === profileId);
    if (!profile) return;

    set({ isConnecting: true, connectionError: null });

    try {
      let secretVal = secret;
      if (!secretVal) {
        secretVal = (await storageApi.getSecret(profileId)) || undefined;
      }

      let sessionInfo;
      if (profile.type === 's3') {
        sessionInfo = await storageApi.connectS3({
          profile_id: profile.id,
          endpoint: profile.endpoint,
          bucket: profile.bucket || '',
          region: profile.region,
          accessKey: profile.accessKey || '',
          secretKey: secretVal,
        });
      } else {
        const isKeyAuth = profile.authType === 'key' || Boolean(profile.keyPath);

        const connectParams: SftpConnectParams = {
          profile_id: profile.id,
          host: profile.host || '',
          port: profile.port || 22,
          username: profile.username || '',
          use_sudo: profile.useSudo,
        };
        if (isKeyAuth) {
          if (profile.keyPath) connectParams.key_path = profile.keyPath;
          if (secretVal) connectParams.passphrase = secretVal;
        } else if (secretVal) {
          connectParams.password = secretVal;
        }

        sessionInfo = await storageApi.connectSftp(connectParams);
      }

      // Update status to connected
      set((state) => ({
        profiles: state.profiles.map((p) =>
          p.id === profileId ? { ...p, status: 'connected' } : p
        ),
        isConnecting: false,
        ...(state.activeProfileId === profileId
          ? {
              isElevated: sessionInfo?.is_elevated ?? false,
              sudoCapability: sessionInfo?.sudo_capability ?? 'none',
              remoteNavigationError: null,
            }
          : {}),
      }));

      // Fetch root directory only if still the active profile
      if (get().activeProfileId === profileId) {
        await get().setCurrentPath('/');
      }
    } catch (err: any) {
      if (isCancelledError(err)) {
        // Disconnect or cancellation was requested: maintain or restore profile to idle and suppress error message
        set((state) => ({
          profiles: state.profiles.map((p) =>
            p.id === profileId ? { ...p, status: 'idle' } : p
          ),
          isConnecting: false,
          ...(state.activeProfileId === profileId ? { connectionError: null } : {}),
        }));
        return;
      }
      const errMsg = typeof err === 'string' ? err : err?.message || JSON.stringify(err);
      set((state) => ({
        profiles: state.profiles.map((p) =>
          p.id === profileId ? { ...p, status: 'error' } : p
        ),
        isConnecting: false,
        ...(state.activeProfileId === profileId ? { connectionError: errMsg } : {}),
      }));
    }
  },

  activePane: 'remote',
  setActivePane: (pane) => set({ activePane: pane }),

  currentPath: '/',
  remoteFiles: MOCK_REMOTE_FILES['/'] || [],
  isLoadingFiles: false,

  setCurrentPath: async (path) => {
    const { activeProfileId, profiles } = get();
    const profile = profiles.find((p) => p.id === activeProfileId);
    const reqGen = ++remoteNavGen;

    set({
      selectedRemotePath: null,
      selectedRemotePaths: [],
      isLoadingFiles: true,
      remoteNavigationError: null,
    });

    try {
      if (profile && (profile.type === 'sftp' || profile.type === 's3') && profile.status === 'connected') {
        const liveFiles = await storageApi.listDir(activeProfileId, path);
        if (remoteNavGen !== reqGen) return;
        set({
          currentPath: path,
          remoteFiles: liveFiles,
          isLoadingFiles: false,
          selectedRemotePath: liveFiles.length > 0 ? liveFiles[0].path : null,
          selectedRemotePaths: liveFiles.length > 0 ? [liveFiles[0].path] : [],
          remoteNavigationError: null,
        });
      } else {
        const mockList = MOCK_REMOTE_FILES[path] || [];
        if (remoteNavGen !== reqGen) return;
        set({
          currentPath: path,
          remoteFiles: mockList,
          isLoadingFiles: false,
          selectedRemotePath: mockList.length > 0 ? mockList[0].path : null,
          selectedRemotePaths: mockList.length > 0 ? [mockList[0].path] : [],
          remoteNavigationError: null,
        });
      }
    } catch (err: any) {
      if (remoteNavGen !== reqGen) return;
      console.error('Error listing dir:', err);
      const isPerm = isPermissionDeniedError(err);
      const message = isPerm
        ? `Accès refusé : permissions insuffisantes pour ouvrir « ${path} »`
        : `Impossible d'accéder au dossier distant « ${path} » : ${err?.message || err}`;

      set({
        isLoadingFiles: false,
        remoteNavigationError: {
          pane: 'remote',
          path,
          message,
          isPermissionDenied: isPerm,
        },
      });
    }
  },

  refreshRemote: async () => {
    const { currentPath } = get();
    await get().setCurrentPath(currentPath);
  },

  elevateActiveSession: async (targetPath?: string) => {
    const { activeProfileId, profiles, remoteNavigationError, setCurrentPath } = get();
    const profile = profiles.find((p) => p.id === activeProfileId);
    if (!profile || profile.type !== 'sftp') return;

    const initiatingProfileId = activeProfileId;
    const destination = targetPath || (remoteNavigationError?.path ? remoteNavigationError.path : '/');

    set({ isConnecting: true, remoteNavigationError: null });

    try {
      const secret = (await storageApi.getSecret(initiatingProfileId)) || undefined;
      const isKeyAuth = profile.authType === 'key' || Boolean(profile.keyPath);

      const elevateParams: SftpConnectParams = {
        profile_id: profile.id,
        host: profile.host || '',
        port: profile.port || 22,
        username: profile.username || '',
        use_sudo: true,
      };
      if (isKeyAuth) {
        if (profile.keyPath) elevateParams.key_path = profile.keyPath;
        if (secret) elevateParams.passphrase = secret;
      } else if (secret) {
        elevateParams.password = secret;
      }

      const sessionInfo = await storageApi.connectSftp(elevateParams);

      if (get().activeProfileId !== initiatingProfileId) return;

      set((state) => ({
        profiles: state.profiles.map((p) =>
          p.id === initiatingProfileId ? { ...p, status: 'connected', useSudo: true } : p
        ),
        isConnecting: false,
        isElevated: sessionInfo.is_elevated,
        sudoCapability: sessionInfo.sudo_capability,
        remoteNavigationError: null,
      }));

      await setCurrentPath(destination);
    } catch (err: any) {
      if (get().activeProfileId !== initiatingProfileId) return;
      const errMsg = typeof err === 'string' ? err : err?.message || JSON.stringify(err);
      // Retain existing connected status on profile rather than destroying the session
      set({
        isConnecting: false,
        connectionError: `Échec de l'élévation Sudo : ${errMsg}`,
      });
    }
  },

  createRemoteFolder: async (folderName: string) => {
    const { activeProfileId, currentPath, refreshRemote } = get();
    if (!folderName.trim()) return;
    const cleanName = folderName.trim().replace(/^\/+/, '');
    const basePath = currentPath === '/' ? '' : currentPath.replace(/\/+$/, '');
    const newPath = `${basePath}/${cleanName}`;
    await storageApi.createDir(activeProfileId, newPath);
    await refreshRemote();
  },

  renameRemoteItem: async (oldPath: string, newName: string) => {
    const { activeProfileId, refreshRemote } = get();
    const cleanName = newName.trim().replace(/^\/+/, '');
    if (!cleanName) return;
    const lastSlash = oldPath.lastIndexOf('/');
    const parentDir = lastSlash > 0 ? oldPath.substring(0, lastSlash) : (lastSlash === 0 ? '' : '');
    const newPath = `${parentDir}/${cleanName}`;
    if (newPath === oldPath) return;
    await storageApi.renameFile(activeProfileId, oldPath, newPath);
    await refreshRemote();
  },

  deleteRemoteItem: async (path: string, isDir: boolean) => {
    const { activeProfileId, refreshRemote, selectedRemotePath } = get();
    await storageApi.deleteFile(activeProfileId, path, isDir);
    if (selectedRemotePath === path) {
      set({ selectedRemotePath: null, selectedRemotePaths: [] });
    }
    await refreshRemote();
  },

  getRemoteFiles: () => {
    const { remoteFiles, searchQuery } = get();
    if (!searchQuery.trim()) return remoteFiles;
    const lower = searchQuery.toLowerCase();
    return remoteFiles.filter((f) => f.name.toLowerCase().includes(lower));
  },

  selectedRemotePath: null,
  selectedRemotePaths: [],
  selectRemoteFile: (path, multi = false) => {
    const { selectedRemotePaths } = get();
    if (multi) {
      const exists = selectedRemotePaths.includes(path);
      const newPaths = exists
        ? selectedRemotePaths.filter((p) => p !== path)
        : [...selectedRemotePaths, path];
      set({
        selectedRemotePaths: newPaths,
        selectedRemotePath: newPaths[newPaths.length - 1] || null,
        activePane: 'remote',
      });
    } else {
      set({
        selectedRemotePaths: [path],
        selectedRemotePath: path,
        activePane: 'remote',
      });
    }
  },
  clearRemoteSelection: () => {
    set({ selectedRemotePaths: [], selectedRemotePath: null });
  },

  localPath: '',
  localFiles: [],
  isLoadingLocalFiles: false,
  setLocalPath: async (path: string) => {
    const reqGen = ++localNavGen;
    set({ isLoadingLocalFiles: true, localNavigationError: null });
    try {
      const res = await storageApi.listLocalDir(path);
      if (localNavGen !== reqGen) return;
      set({
        localPath: res.currentPath,
        localFiles: res.entries,
        selectedLocalPath: null,
        selectedLocalPaths: [],
        isLoadingLocalFiles: false,
        localNavigationError: null,
      });
    } catch (err: any) {
      if (localNavGen !== reqGen) return;
      console.error('Failed to list local directory:', err);
      const isPerm = isPermissionDeniedError(err);
      const message = isPerm
        ? `Accès refusé : permissions insuffisantes pour ouvrir « ${path} »`
        : `Impossible d'accéder au dossier local « ${path} » : ${err?.message || err}`;

      set({
        isLoadingLocalFiles: false,
        localNavigationError: {
          pane: 'local',
          path,
          message,
          isPermissionDenied: isPerm,
        },
      });
    }
  },
  getLocalFiles: () => {
    const { localFiles, searchQuery } = get();
    if (!searchQuery.trim()) return localFiles;
    const lower = searchQuery.toLowerCase();
    return localFiles.filter((f) => f.name.toLowerCase().includes(lower));
  },
  selectedLocalPath: null,
  selectedLocalPaths: [],
  selectLocalFile: (path, multi = false) => {
    const { selectedLocalPaths } = get();
    if (multi) {
      const exists = selectedLocalPaths.includes(path);
      const newPaths = exists
        ? selectedLocalPaths.filter((p) => p !== path)
        : [...selectedLocalPaths, path];
      set({
        selectedLocalPaths: newPaths,
        selectedLocalPath: newPaths.length > 0 ? newPaths[newPaths.length - 1] : null,
        activePane: 'local',
      });
    } else {
      set({
        selectedLocalPath: path,
        selectedLocalPaths: [path],
        activePane: 'local',
      });
    }
  },
  clearLocalSelection: () => {
    set({ selectedLocalPaths: [], selectedLocalPath: null });
  },
  refreshLocal: async () => {
    const { localPath, setLocalPath } = get();
    await setLocalPath(localPath || '');
  },
  createLocalFolder: async (folderName: string) => {
    const { localPath, refreshLocal } = get();
    const newDir = buildNewFolderPath(localPath, folderName);
    if (!newDir) return;
    await storageApi.createLocalDir(newDir);
    await refreshLocal();
  },
  renameLocalItem: async (oldPath: string, newName: string) => {
    const { refreshLocal } = get();
    const newPath = buildRenamePath(oldPath, newName);
    if (!newPath) return;
    await storageApi.renameLocalItem(oldPath, newPath);
    await refreshLocal();
  },
  deleteLocalItem: async (path: string) => {
    const { refreshLocal, selectedLocalPath } = get();
    await storageApi.deleteLocalItem(path);
    if (selectedLocalPath === path) {
      set({ selectedLocalPath: null, selectedLocalPaths: [] });
    }
    await refreshLocal();
  },

  isDualPane: false,
  toggleDualPane: () => {
    const next = !get().isDualPane;
    set({ isDualPane: next });
    if (next && get().localFiles.length === 0) {
      get().refreshLocal();
    }
  },

  searchQuery: '',
  setSearchQuery: (query) => set({ searchQuery: query }),

  quickLookFile: null,
  setQuickLookFile: (file) => set({ quickLookFile: file }),
  toggleQuickLook: () => {
    const {
      quickLookFile,
      selectedRemotePath,
      getRemoteFiles,
      getLocalFiles,
      activePane,
      selectedLocalPath,
    } = get();

    if (quickLookFile) {
      set({ quickLookFile: null });
      return;
    }

    if (activePane === 'local') {
      const localFiles = getLocalFiles();
      const file =
        (selectedLocalPath ? localFiles.find((f) => f.path === selectedLocalPath) : null) ||
        (localFiles.length > 0 ? localFiles[0] : null);
      if (file) {
        set({ quickLookFile: file, selectedLocalPath: file.path });
      }
      return;
    }

    const remoteFiles = getRemoteFiles();
    const file =
      (selectedRemotePath ? remoteFiles.find((f) => f.path === selectedRemotePath) : null) ||
      (remoteFiles.length > 0 ? remoteFiles[0] : null);
    if (file) {
      set({ quickLookFile: file, selectedRemotePath: file.path });
    }
  },

  transfers: [],
  isTransferDrawerOpen: false,
  toggleTransferDrawer: () =>
    set((state) => ({ isTransferDrawerOpen: !state.isTransferDrawerOpen })),
  setTransferDrawerOpen: (open) => set({ isTransferDrawerOpen: open }),

  pauseTransfer: (id) => {
    const tx = get().transfers.find((t) => t.id === id);
    if (!tx || tx.status !== 'transferring') return;
    updateTransfer(set, id, { status: 'paused', speedBps: 0 });
    storageApi.pauseTransfer(id).catch((err) => {
      console.error('[Orbit] Pause failed:', err);
      updateTransfer(set, id, { status: 'transferring' }, ['paused']);
    });
  },

  resumeTransfer: (id) => {
    const tx = get().transfers.find((t) => t.id === id);
    if (!tx || tx.status !== 'paused') return;
    updateTransfer(set, id, { status: 'transferring' });
    storageApi.resumeTransfer(id).catch((err) => {
      console.error('[Orbit] Resume failed:', err);
    });
  },

  cancelTransfer: (id) => {
    const tx = get().transfers.find((t) => t.id === id);
    if (!tx || isFinishedStatus(tx.status)) return;
    const wasQueued = tx.status === 'queued';
    updateTransfer(set, id, { status: 'cancelled', speedBps: 0 });
    if (!wasQueued) {
      // The transfer may not be registered on the Rust side yet: retry as soon
      // as the first progress event arrives.
      pendingCancels.add(id);
      storageApi.cancelTransfer(id).catch(() => {});
    }
    get().processTransferQueue();
  },

  clearCompletedTransfers: () => {
    set((state) => ({
      transfers: state.transfers.filter((tx) => !isFinishedStatus(tx.status)),
    }));
  },

  uploadFile: async (localPath, remotePath, fileName) => {
    enqueueTransfer(set, get, { direction: 'upload', localPath, remotePath, fileName });
  },

  downloadFile: async (remotePath, localPath, fileName) => {
    enqueueTransfer(set, get, { direction: 'download', localPath, remotePath, fileName });
  },

  processTransferQueue: () => {
    const toStart = pickTransfersToStart(get().transfers);
    if (toStart.length === 0) return;
    set((state) => ({
      transfers: state.transfers.map((tx) =>
        toStart.includes(tx.id) ? { ...tx, status: 'transferring' as const } : tx
      ),
    }));
    for (const id of toStart) {
      const tx = get().transfers.find((t) => t.id === id);
      if (tx) void runTransfer(set, get, tx);
    }
  },

  activeDrag: null,
  setActiveDrag: (drag) => set({ activeDrag: drag }),

  isNewConnectionModalOpen: false,
  setNewConnectionModalOpen: (open) => set({ isNewConnectionModalOpen: open }),

  isExportModalOpen: false,
  setExportModalOpen: (open) => set({ isExportModalOpen: open }),

  isNewFolderModalOpen: false,
  setNewFolderModalOpen: (open) => set({ isNewFolderModalOpen: open }),

  // Updates
  availableUpdate: null,
  isCheckingUpdate: false,
  isUpdateModalOpen: false,
  updateCheckError: null,
  lastUpdateCheckTime: 0,

  checkForUpdates: async (notifyIfUpToDate = false) => {
    // 1. Prevent duplicate in-flight checks
    if (get().isCheckingUpdate) return;

    // 2. Cache successful checks for 15 minutes unless manually requested
    const now = Date.now();
    const { availableUpdate, lastUpdateCheckTime } = get();
    if (!notifyIfUpToDate && availableUpdate && now - lastUpdateCheckTime < 15 * 60 * 1000) {
      if (availableUpdate.has_update) {
        set({ isUpdateModalOpen: true });
      }
      return;
    }

    set({ isCheckingUpdate: true, updateCheckError: null });
    try {
      const result = await storageApi.checkAppUpdate();
      set({ availableUpdate: result, isCheckingUpdate: false, lastUpdateCheckTime: Date.now() });
      if (result.has_update || notifyIfUpToDate) {
        set({ isUpdateModalOpen: true });
      }
    } catch (err: any) {
      console.warn('Erreur vérification mise à jour:', err);
      const msg = typeof err === 'string' ? err : err?.message || 'Impossible de vérifier les mises à jour';
      set({ isCheckingUpdate: false, updateCheckError: msg });
      if (notifyIfUpToDate) {
        set({ isUpdateModalOpen: true });
      }
    }
  },

  setUpdateModalOpen: (open) => set({ isUpdateModalOpen: open }),
  dismissUpdate: () => set({ isUpdateModalOpen: false }),
}));
