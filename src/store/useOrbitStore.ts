import { create } from 'zustand';
import { ConnectionProfile, FileEntry, TransferItem } from '../types';
import { MOCK_PROFILES, MOCK_REMOTE_FILES, MOCK_LOCAL_FILES, MOCK_TRANSFERS } from '../data/mockData';
import { storageApi, BackendTransferProgress } from '../services/storageApi';

interface OrbitState {
  // Profiles
  profiles: ConnectionProfile[];
  activeProfileId: string;
  setActiveProfile: (id: string) => Promise<void>;
  addProfile: (profile: ConnectionProfile, secret?: string) => Promise<void>;
  connectProfile: (profileId: string, secret?: string) => Promise<void>;

  // Connection state & error
  isConnecting: boolean;
  connectionError: string | null;
  clearConnectionError: () => void;

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

  // Local Explorer (for Dual Pane)
  localPath: string;
  setLocalPath: (path: string) => void;
  localFiles: FileEntry[];
  selectedLocalPath: string | null;
  selectLocalFile: (path: string) => void;

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
  uploadFile: (localPath: string, remotePath: string, fileName: string) => Promise<void>;
  downloadFile: (remotePath: string, localPath: string, fileName: string) => Promise<void>;

  // Modals
  isNewConnectionModalOpen: boolean;
  setNewConnectionModalOpen: (open: boolean) => void;
  isExportModalOpen: boolean;
  setExportModalOpen: (open: boolean) => void;
}

export const useOrbitStore = create<OrbitState>((set, get) => ({
  profiles: MOCK_PROFILES,
  activeProfileId: 'prof-1',
    isConnecting: false,
      connectionError: null,
        clearConnectionError: () => set({ connectionError: null }),

          setActiveProfile: async (id) => {
            const profile = get().profiles.find((p) => p.id === id);
            set({
              activeProfileId: id,
              currentPath: '/',
              selectedRemotePath: null,
              selectedRemotePaths: [],
              connectionError: null,
            });

            if (profile && profile.type === 'sftp') {
              await get().connectProfile(id);
            } else {
              // Fallback or mock files
              const files = MOCK_REMOTE_FILES['/'] || [];
              set({ remoteFiles: files });
            }
          },

              addProfile: async (profile, secret) => {
                if (secret) {
                  await storageApi.saveSecret(profile.id, secret);
                }
                set((state) => ({
                  profiles: [...state.profiles, profile],
                  activeProfileId: profile.id,
                  currentPath: '/',
                }));

                if (profile.type === 'sftp') {
                  await get().connectProfile(profile.id, secret);
                }
              },

                connectProfile: async (profileId, secret) => {
                  const profile = get().profiles.find((p) => p.id === profileId);
                  if (!profile || profile.type !== 'sftp') return;

                  set({ isConnecting: true, connectionError: null });

                  try {
                    let pwd = secret;
                    if (!pwd) {
                      pwd = (await storageApi.getSecret(profileId)) || undefined;
                    }

                    await storageApi.connectSftp({
                      profile_id: profile.id,
                      host: profile.host || '',
                      port: profile.port || 22,
                      username: profile.username || 'root',
                      password: pwd,
                      key_path: undefined,
                    });

                    // Update status to connected
                    set((state) => ({
                      profiles: state.profiles.map((p) =>
                        p.id === profileId ? { ...p, status: 'connected' } : p
                      ),
                      isConnecting: false,
                    }));

                    // Fetch root directory
                    await get().setCurrentPath('/');
                  } catch (err: any) {
                    const errMsg = typeof err === 'string' ? err : err?.message || JSON.stringify(err);
                    set((state) => ({
                      profiles: state.profiles.map((p) =>
                        p.id === profileId ? { ...p, status: 'error' } : p
                      ),
                      isConnecting: false,
                      connectionError: errMsg,
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

                                set({
                                  currentPath: path,
                                  selectedRemotePath: null,
                                  selectedRemotePaths: [],
                                  isLoadingFiles: true,
                                });

                                try {
                                  if (profile && profile.type === 'sftp' && profile.status === 'connected') {
                                    const liveFiles = await storageApi.listDir(activeProfileId, path);
                                    set({
                                      remoteFiles: liveFiles,
                                      isLoadingFiles: false,
                                      selectedRemotePath: liveFiles.length > 0 ? liveFiles[0].path : null,
                                      selectedRemotePaths: liveFiles.length > 0 ? [liveFiles[0].path] : [],
                                    });
                                  } else {
                                    const mockList = MOCK_REMOTE_FILES[path] || [];
                                    set({
                                      remoteFiles: mockList,
                                      isLoadingFiles: false,
                                      selectedRemotePath: mockList.length > 0 ? mockList[0].path : null,
                                      selectedRemotePaths: mockList.length > 0 ? [mockList[0].path] : [],
                                    });
                                  }
                                } catch (err: any) {
                                  console.error('Error listing dir:', err);
                                  set({ isLoadingFiles: false });
                                }
                              },

                                refreshRemote: async () => {
                                  const { currentPath } = get();
                                  await get().setCurrentPath(currentPath);
                                },

                                  getRemoteFiles: () => {
                                    const { remoteFiles, searchQuery } = get();
                                    if (!searchQuery.trim()) return remoteFiles;
                                    const lower = searchQuery.toLowerCase();
                                    return remoteFiles.filter((f) => f.name.toLowerCase().includes(lower));
                                  },

                                    selectedRemotePath: '/app-config.json',
                                      selectedRemotePaths: ['/app-config.json'],
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

                                            localPath: '/Users/mac',
                                              setLocalPath: (path) => set({ localPath: path }),
                                                localFiles: MOCK_LOCAL_FILES,
                                                  selectedLocalPath: null,
                                                    selectLocalFile: (path) => set({ selectedLocalPath: path, activePane: 'local' }),

                                                      isDualPane: false,
                                                        toggleDualPane: () => set((state) => ({ isDualPane: !state.isDualPane })),

                                                          searchQuery: '',
                                                            setSearchQuery: (query) => set({ searchQuery: query }),

                                                              quickLookFile: null,
                                                                setQuickLookFile: (file) => set({ quickLookFile: file }),
                                                                  toggleQuickLook: () => {
                                                                    const {
                                                                      quickLookFile,
                                                                      selectedRemotePath,
                                                                      getRemoteFiles,
                                                                      activePane,
                                                                      selectedLocalPath,
                                                                      localFiles,
                                                                    } = get();

                                                                    if (quickLookFile) {
                                                                      set({ quickLookFile: null });
                                                                      return;
                                                                    }

                                                                    if (activePane === 'local') {
                                                                      const targetPath = selectedLocalPath || (localFiles.length > 0 ? localFiles[0].path : null);
                                                                      if (targetPath) {
                                                                        const file = localFiles.find((f) => f.path === targetPath);
                                                                        if (file) {
                                                                          set({ quickLookFile: file, selectedLocalPath: file.path });
                                                                          return;
                                                                        }
                                                                      }
                                                                    }

                                                                    const remoteFiles = getRemoteFiles();
                                                                    const targetPath = selectedRemotePath || (remoteFiles.length > 0 ? remoteFiles[0].path : null);
                                                                    if (targetPath) {
                                                                      const file = remoteFiles.find((f) => f.path === targetPath);
                                                                      if (file) {
                                                                        set({ quickLookFile: file, selectedRemotePath: file.path });
                                                                      }
                                                                    }
                                                                  },

                                                                    transfers: MOCK_TRANSFERS,
                                                                      isTransferDrawerOpen: false,
                                                                        toggleTransferDrawer: () =>
                                                                          set((state) => ({ isTransferDrawerOpen: !state.isTransferDrawerOpen })),
                                                                          setTransferDrawerOpen: (open) => set({ isTransferDrawerOpen: open }),

                                                                            pauseTransfer: (id) => {
                                                                              set((state) => ({
                                                                                transfers: state.transfers.map((tx) =>
                                                                                  tx.id === id ? { ...tx, status: 'paused', speedBps: 0 } : tx
                                                                                ),
                                                                              }));
                                                                            },

                                                                              resumeTransfer: (id) => {
                                                                                set((state) => ({
                                                                                  transfers: state.transfers.map((tx) =>
                                                                                    tx.id === id ? { ...tx, status: 'transferring', speedBps: 24500000 } : tx
                                                                                  ),
                                                                                }));
                                                                              },

                                                                                cancelTransfer: (id) => {
                                                                                  set((state) => ({
                                                                                    transfers: state.transfers.map((tx) =>
                                                                                      tx.id === id ? { ...tx, status: 'cancelled', speedBps: 0 } : tx
                                                                                    ),
                                                                                  }));
                                                                                },

                                                                                  clearCompletedTransfers: () => {
                                                                                    set((state) => ({
                                                                                      transfers: state.transfers.filter(
                                                                                        (tx) => tx.status === 'transferring' || tx.status === 'paused' || tx.status === 'queued'
                                                                                      ),
                                                                                    }));
                                                                                  },

                                                                                    uploadFile: async (localPath, remotePath, fileName) => {
                                                                                      const { activeProfileId, profiles } = get();
                                                                                      const profile = profiles.find((p) => p.id === activeProfileId);
                                                                                      const txId = `tx-${Date.now()}`;

                                                                                      const newTransfer: TransferItem = {
                                                                                        id: txId,
                                                                                        serverName: profile?.name || 'SFTP Server',
                                                                                        serverType: profile?.type || 'sftp',
                                                                                        fileName,
                                                                                        localPath,
                                                                                        remotePath,
                                                                                        direction: 'upload',
                                                                                        bytesTransferred: 0,
                                                                                        totalBytes: 0,
                                                                                        speedBps: 0,
                                                                                        status: 'transferring',
                                                                                      };

                                                                                      set((state) => ({
                                                                                        transfers: [newTransfer, ...state.transfers],
                                                                                        isTransferDrawerOpen: true,
                                                                                      }));

                                                                                      try {
                                                                                        await storageApi.uploadFile(
                                                                                          activeProfileId,
                                                                                          localPath,
                                                                                          remotePath,
                                                                                          (p: BackendTransferProgress) => {
                                                                                            set((state) => ({
                                                                                              transfers: state.transfers.map((tx) =>
                                                                                                tx.id === txId
                                                                                                  ? {
                                                                                                    ...tx,
                                                                                                    bytesTransferred: p.bytes_transferred,
                                                                                                    totalBytes: p.total_bytes,
                                                                                                    speedBps: p.speed_bps,
                                                                                                    status: p.status === 'completed' ? 'completed' : 'transferring',
                                                                                                  }
                                                                                                  : tx
                                                                                              ),
                                                                                            }));
                                                                                          }
                                                                                        );
                                                                                        await get().refreshRemote();
                                                                                      } catch (err: any) {
                                                                                        set((state) => ({
                                                                                          transfers: state.transfers.map((tx) =>
                                                                                            tx.id === txId ? { ...tx, status: 'failed' } : tx
                                                                                          ),
                                                                                        }));
                                                                                      }
                                                                                    },

                                                                                      downloadFile: async (remotePath, localPath, fileName) => {
                                                                                        const { activeProfileId, profiles } = get();
                                                                                        const profile = profiles.find((p) => p.id === activeProfileId);
                                                                                        const txId = `tx-${Date.now()}`;

                                                                                        const newTransfer: TransferItem = {
                                                                                          id: txId,
                                                                                          serverName: profile?.name || 'SFTP Server',
                                                                                          serverType: profile?.type || 'sftp',
                                                                                          fileName,
                                                                                          localPath,
                                                                                          remotePath,
                                                                                          direction: 'download',
                                                                                          bytesTransferred: 0,
                                                                                          totalBytes: 0,
                                                                                          speedBps: 0,
                                                                                          status: 'transferring',
                                                                                        };

                                                                                        set((state) => ({
                                                                                          transfers: [newTransfer, ...state.transfers],
                                                                                          isTransferDrawerOpen: true,
                                                                                        }));

                                                                                        try {
                                                                                          await storageApi.downloadFile(
                                                                                            activeProfileId,
                                                                                            remotePath,
                                                                                            localPath,
                                                                                            (p: BackendTransferProgress) => {
                                                                                              set((state) => ({
                                                                                                transfers: state.transfers.map((tx) =>
                                                                                                  tx.id === txId
                                                                                                    ? {
                                                                                                      ...tx,
                                                                                                      bytesTransferred: p.bytes_transferred,
                                                                                                      totalBytes: p.total_bytes,
                                                                                                      speedBps: p.speed_bps,
                                                                                                      status: p.status === 'completed' ? 'completed' : 'transferring',
                                                                                                    }
                                                                                                    : tx
                                                                                                ),
                                                                                              }));
                                                                                            }
                                                                                          );
                                                                                        } catch (err: any) {
                                                                                          set((state) => ({
                                                                                            transfers: state.transfers.map((tx) =>
                                                                                              tx.id === txId ? { ...tx, status: 'failed' } : tx
                                                                                            ),
                                                                                          }));
                                                                                        }
                                                                                      },

                                                                                        isNewConnectionModalOpen: false,
                                                                                          setNewConnectionModalOpen: (open) => set({ isNewConnectionModalOpen: open }),

                                                                                            isExportModalOpen: false,
                                                                                              setExportModalOpen: (open) => set({ isExportModalOpen: open }),
}));
