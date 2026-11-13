import { create } from 'zustand';
import { ConnectionProfile, FileEntry, TransferItem } from '../types';
import { MOCK_PROFILES, MOCK_REMOTE_FILES, MOCK_LOCAL_FILES, MOCK_TRANSFERS } from '../data/mockData';

interface OrbitState {
  // Profiles
  profiles: ConnectionProfile[];
  activeProfileId: string;
  setActiveProfile: (id: string) => void;
  addProfile: (profile: ConnectionProfile) => void;

  // Remote Explorer
  currentPath: string;
  setCurrentPath: (path: string) => void;
  getRemoteFiles: () => FileEntry[];
  selectedRemotePath: string | null;
  selectedRemotePaths: string[];
  selectRemoteFile: (path: string, multi?: boolean) => void;
  clearRemoteSelection: () => void;

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

  // Modals
  isNewConnectionModalOpen: boolean;
  setNewConnectionModalOpen: (open: boolean) => void;
  isExportModalOpen: boolean;
  setExportModalOpen: (open: boolean) => void;
}

export const useOrbitStore = create<OrbitState>((set, get) => ({
  profiles: MOCK_PROFILES,
  activeProfileId: 'prof-1',
  setActiveProfile: (id) => {
    set({
      activeProfileId: id,
      currentPath: '/',
      selectedRemotePath: null,
      selectedRemotePaths: [],
    });
  },
  addProfile: (profile) => {
    set((state) => ({
      profiles: [...state.profiles, profile],
      activeProfileId: profile.id,
      currentPath: '/',
    }));
  },

  currentPath: '/',
  setCurrentPath: (path) => {
    set({
      currentPath: path,
      selectedRemotePath: null,
      selectedRemotePaths: [],
    });
  },
  getRemoteFiles: () => {
    const { currentPath, searchQuery } = get();
    const list = MOCK_REMOTE_FILES[currentPath] || [];
    if (!searchQuery.trim()) return list;
    const lower = searchQuery.toLowerCase();
    return list.filter((f) => f.name.toLowerCase().includes(lower));
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
      });
    } else {
      set({
        selectedRemotePaths: [path],
        selectedRemotePath: path,
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
  selectLocalFile: (path) => set({ selectedLocalPath: path }),

  isDualPane: false,
  toggleDualPane: () => set((state) => ({ isDualPane: !state.isDualPane })),

  searchQuery: '',
  setSearchQuery: (query) => set({ searchQuery: query }),

  quickLookFile: null,
  setQuickLookFile: (file) => set({ quickLookFile: file }),
  toggleQuickLook: () => {
    const { quickLookFile, selectedRemotePath, getRemoteFiles } = get();
    if (quickLookFile) {
      set({ quickLookFile: null });
    } else if (selectedRemotePath) {
      const file = getRemoteFiles().find((f) => f.path === selectedRemotePath);
      if (file && !file.is_dir) {
        set({ quickLookFile: file });
      }
    }
  },

  transfers: MOCK_TRANSFERS,
  isTransferDrawerOpen: false,
  toggleTransferDrawer: () =>
    set((state) => ({ isTransferDrawerOpen: !state.isTransferDrawerOpen })),
  setTransferDrawerOpen: (open) => set({ isTransferDrawerOpen: open }),

  isNewConnectionModalOpen: false,
  setNewConnectionModalOpen: (open) => set({ isNewConnectionModalOpen: open }),

  isExportModalOpen: false,
  setExportModalOpen: (open) => set({ isExportModalOpen: open }),
}));
