import React, { useRef, useState, useEffect, useMemo } from 'react';
import { useOrbitStore, TransferRequest } from '../../store/useOrbitStore';
import { FileIcon } from './FileIcon';
import { formatBytes, formatDate } from '../../lib/utils';
import { FileEntry } from '../../types';
import {
  FolderUp,
  HardDrive,
  Server,
  Plus,
  FolderPlus,
  Pencil,
  Trash2,
  Eye,
  Download,
  Upload,
  ArrowRight,
  ArrowLeft,
  RefreshCw,
  AlertTriangle,
  Loader2,
  X,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  ShieldAlert,
  Terminal,
  KeyRound,
  FilePen,
} from 'lucide-react';
import { PermissionsModal } from '../modals/PermissionsModal';
import { open, save } from '@tauri-apps/plugin-dialog';
import { isTauri, storageApi } from '../../services/storageApi';
import {
  SortColumn,
  SortDirection,
  sortFiles,
  getDefaultDirection,
} from '../../lib/fileSort';

interface ExplorerViewProps {
  files: FileEntry[];
  currentPath: string;
  onNavigate: (path: string) => void;
  selectedPath: string | null;
  onSelect: (path: string, multi?: boolean) => void;
  title?: string;
  isLocal?: boolean;
}

interface ContextMenuState {
  x: number;
  y: number;
  file: FileEntry | null;
}

export const ExplorerView: React.FC<ExplorerViewProps> = ({
  files,
  currentPath,
  onNavigate,
  selectedPath,
  onSelect,
  title,
  isLocal = false,
}) => {
  const {
    setQuickLookFile,
    activePane,
    setActivePane,
    profiles,
    setNewConnectionModalOpen,
    createRemoteFolder,
    renameRemoteItem,
    deleteRemoteItem,
    refreshRemote,
    createLocalFolder,
    renameLocalItem,
    deleteLocalItem,
    refreshLocal,
    downloadFile,
    uploadFile,
    enqueueTransfers,
    enqueueFolder,
    isDualPane,
    isNewFolderModalOpen,
    setNewFolderModalOpen,
    searchQuery,
    remoteNavigationError,
    localNavigationError,
    clearNavigationError,
    elevateActiveSession,
    sudoCapability,
    selectedRemotePaths,
    selectedLocalPaths,
    activeDrag,
    setActiveDrag,
    openExternalTerminal,
    activeProfileId,
    openLocalEdit,
    isElevated,
  } = useOrbitStore();

  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  const isSftp = activeProfile?.type === 'sftp';

  const selectedPaths = isLocal ? selectedLocalPaths : selectedRemotePaths;

  const isTargetOfDrag =
    Boolean(activeDrag?.isDragging) &&
    activeDrag?.hoverPane === (isLocal ? 'local' : 'remote') &&
    activeDrag?.source !== (isLocal ? 'local' : 'remote');

  const currentNavigationError = isLocal ? localNavigationError : remoteNavigationError;

  const containerRef = useRef<HTMLDivElement>(null);

  // Sorting State
  const [sortColumn, setSortColumn] = useState<SortColumn>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection(getDefaultDirection(column));
    }
  };

  const sortedFiles = useMemo(() => {
    return sortFiles(files, {
      column: sortColumn,
      direction: sortDirection,
      foldersFirst: true,
    });
  }, [files, sortColumn, sortDirection]);

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Action Modals State
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameInput, setRenameInput] = useState('');

  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [deleteItemCount, setDeleteItemCount] = useState<number | null>(null);

  const [permissionsTarget, setPermissionsTarget] = useState<FileEntry | null>(null);

  useEffect(() => {
    if (!deleteTarget || !deleteTarget.is_dir) {
      setDeleteItemCount(null);
      return;
    }
    let active = true;
    const check = async () => {
      try {
        if (isLocal) {
          const res = await storageApi.listLocalDir(deleteTarget.path);
          if (active) setDeleteItemCount(res.entries.length);
        } else {
          const profileId = useOrbitStore.getState().activeProfileId;
          const entries = await storageApi.listDir(profileId, deleteTarget.path);
          if (active) setDeleteItemCount(entries.length);
        }
      } catch {
        if (active) setDeleteItemCount(null);
      }
    };
    check();
    return () => {
      active = false;
    };
  }, [deleteTarget, isLocal]);

  const [newFolderNameInput, setNewFolderNameInput] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Close context menu on outside click or window blur
  useEffect(() => {
    const handleOutsideClick = () => setContextMenu(null);
    window.addEventListener('click', handleOutsideClick);
    window.addEventListener('blur', handleOutsideClick);
    return () => {
      window.removeEventListener('click', handleOutsideClick);
      window.removeEventListener('blur', handleOutsideClick);
    };
  }, []);

  // Sync rename input when target changes
  useEffect(() => {
    if (renameTarget) {
      setRenameInput(renameTarget.name);
      setModalError(null);
    }
  }, [renameTarget]);

  const isModalActive = isNewFolderModalOpen && activePane === (isLocal ? 'local' : 'remote');

  // Reset new folder input when modal opens
  useEffect(() => {
    if (isModalActive) {
      setNewFolderNameInput('');
      setModalError(null);
    }
  }, [isModalActive]);

  // Navigate up one folder
  const handleGoUp = () => {
    if (currentPath === '/' || currentPath === '' || currentPath === '\\') return;
    const isWindows = currentPath.includes('\\');
    const parts = currentPath.split(/[/\\]/).filter(Boolean);
    parts.pop();
    if (parts.length === 0) {
      onNavigate(isWindows ? currentPath.substring(0, 3) : '/');
    } else {
      const parent = isWindows
        ? parts.join('\\')
        : '/' + parts.join('/');
      onNavigate(parent);
    }
  };

  const isWindows = currentPath.includes('\\');
  const paneSegments = currentPath.split(/[/\\]/).filter(Boolean);
  const rootPrefix = isWindows ? currentPath.substring(0, 3) : '/';

  const handlePaneBreadcrumbClick = (index: number) => {
    if (index === -1) {
      onNavigate(rootPrefix);
    } else {
      const separator = isWindows ? '\\' : '/';
      const newPath = isWindows
        ? rootPrefix + paneSegments.slice(0, index + 1).join(separator)
        : '/' + paneSegments.slice(0, index + 1).join('/');
      onNavigate(newPath);
    }
  };

  const handleRowDoubleClick = (file: FileEntry) => {
    if (file.is_dir) {
      onNavigate(file.path);
    } else {
      setQuickLookFile(file);
    }
  };

  // Keyboard navigation & shortcuts inside list
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // If a modal is open, let modal handle keys
    if (isNewFolderModalOpen || renameTarget || deleteTarget || permissionsTarget) return;

    if (sortedFiles.length === 0) return;

    const currentIndex = sortedFiles.findIndex((f) => f.path === selectedPath);
    const selectedFile = sortedFiles.find((f) => f.path === selectedPath);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = currentIndex < sortedFiles.length - 1 ? currentIndex + 1 : 0;
      onSelect(sortedFiles[nextIndex].path);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : sortedFiles.length - 1;
      onSelect(sortedFiles[prevIndex].path);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedFile) {
        handleRowDoubleClick(selectedFile);
      }
    } else if (e.key === 'F2' && selectedFile) {
      e.preventDefault();
      setRenameTarget(selectedFile);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedFile) {
      e.preventDefault();
      setDeleteTarget(selectedFile);
    }
  };

  // Handle right click on table row
  const handleRowContextMenu = (e: React.MouseEvent, file: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setActivePane(isLocal ? 'local' : 'remote');

    onSelect(file.path, false);

    const menuWidth = 200;
    const menuHeight = isLocal ? 180 : 260;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 12);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 12);

    setContextMenu({ x, y, file });
  };

  // Handle right click on empty background
  const handleBackgroundContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setActivePane(isLocal ? 'local' : 'remote');

    const menuWidth = 200;
    const menuHeight = isLocal ? 120 : 160;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 12);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 12);

    setContextMenu({ x, y, file: null });
  };

  // Trigger download with native Save dialog
  const handleDownload = async (file: FileEntry) => {
    setContextMenu(null);

    if (file.is_dir) {
      try {
        if (!isTauri()) return;
        const destDir = await open({ directory: true, multiple: false, title: `Télécharger « ${file.name} » dans…` });
        if (typeof destDir === 'string') {
          await enqueueFolder({ direction: 'download', sourcePath: file.path, destDir, name: file.name });
        }
      } catch (err: any) {
        console.error('Folder download prompt failed:', err);
      }
      return;
    }

    try {
      let targetPath: string | null = null;
      if (isTauri()) {
        targetPath = await save({ defaultPath: file.name });
      } else {
        targetPath = `/Downloads/${file.name}`;
      }

      if (targetPath) {
        // The native save dialog already asked about overwriting an existing file.
        await enqueueTransfers(
          [{ direction: 'download', localPath: targetPath, remotePath: file.path, fileName: file.name }],
          { checkConflicts: false }
        );
      }
    } catch (err: any) {
      console.error('Download prompt failed:', err);
    }
  };

  // Trigger file picker to upload files to remote currentPath
  const handleUploadDialog = async () => {
    setContextMenu(null);
    try {
      if (isTauri()) {
        const selected = await open({
          multiple: true,
          directory: false,
        });
        if (selected) {
          const filePaths = Array.isArray(selected) ? selected : [selected];
          await enqueueTransfers(
            filePaths.map((filePath) => {
              const fileName = filePath.split(/[/\\]/).pop() || 'file';
              const remoteTarget =
                currentPath === '/'
                  ? `/${fileName}`
                  : `${currentPath.replace(/\/+$/, '')}/${fileName}`;
              return { direction: 'upload' as const, localPath: filePath, remotePath: remoteTarget, fileName };
            })
          );
        }
      }
    } catch (err: any) {
      console.error('Upload prompt failed:', err);
    }
  };

  // Dual pane quick send from local to remote
  const handleSendToRemote = async (file: FileEntry) => {
    setContextMenu(null);
    const { currentPath: remoteCurrentPath } = useOrbitStore.getState();
    if (file.is_dir) {
      await enqueueFolder({ direction: 'upload', sourcePath: file.path, destDir: remoteCurrentPath, name: file.name });
      return;
    }
    const remoteTarget =
      remoteCurrentPath === '/'
        ? `/${file.name}`
        : `${remoteCurrentPath.replace(/\/+$/, '')}/${file.name}`;
    await uploadFile(file.path, remoteTarget, file.name);
  };

  // Dual pane quick download from remote to local
  const handleDownloadToLocal = async (file: FileEntry) => {
    setContextMenu(null);
    const { localPath: storeLocalPath } = useOrbitStore.getState();
    if (file.is_dir) {
      await enqueueFolder({ direction: 'download', sourcePath: file.path, destDir: storeLocalPath, name: file.name });
      return;
    }
    const target = `${storeLocalPath.replace(/[/\\]+$/, '')}/${file.name}`;
    await downloadFile(file.path, target, file.name);
  };

  // Submit New Folder
  const handleCreateFolderSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newFolderNameInput.trim();
    if (!name) return;

    setIsSubmitting(true);
    setModalError(null);
    try {
      if (isLocal) {
        await createLocalFolder(name);
      } else {
        await createRemoteFolder(name);
      }
      setNewFolderModalOpen(false);
      setNewFolderNameInput('');
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || 'Erreur lors de la création du dossier';
      setModalError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Submit Rename
  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameTarget) return;
    const newName = renameInput.trim();
    if (!newName || newName === renameTarget.name) {
      setRenameTarget(null);
      return;
    }

    setIsSubmitting(true);
    setModalError(null);
    try {
      if (isLocal) {
        await renameLocalItem(renameTarget.path, newName);
      } else {
        await renameRemoteItem(renameTarget.path, newName);
      }
      setRenameTarget(null);
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || 'Erreur lors du renommage';
      setModalError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Submit Delete
  const handleDeleteSubmit = async () => {
    if (!deleteTarget) return;

    setIsSubmitting(true);
    setModalError(null);
    try {
      if (isLocal) {
        await deleteLocalItem(deleteTarget.path);
      } else {
        await deleteRemoteItem(deleteTarget.path, deleteTarget.is_dir);
      }
      setDeleteTarget(null);
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || 'Erreur lors de la suppression';
      setModalError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Submit Permissions Change
  const handleSavePermissions = async (
    mode: number,
    owner: string | null,
    group: string | null,
    recursive: boolean
  ) => {
    if (!permissionsTarget) return;
    if (isLocal) {
      await storageApi.setLocalPermissions(
        permissionsTarget.path,
        mode,
        owner,
        group,
        recursive
      );
      await refreshLocal();
    } else {
      await storageApi.setPermissions(
        activeProfileId,
        permissionsTarget.path,
        mode,
        owner,
        group,
        recursive
      );
      await refreshRemote();
    }
  };

  // Pointer-based Drag & Drop (supports multi-selection, Escape cancellation, and works without WebKit Cocoa conflicts)
  const handleRowPointerDown = (e: React.PointerEvent, file: FileEntry) => {
    // Only proceed on main left-click, and don't initiate drag if modifier keys are pressed (let click handle multi-select toggle)
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let isDragActive = false;

    // Determine files to drag
    let dragFiles: FileEntry[];
    if (selectedPaths.includes(file.path)) {
      dragFiles = files.filter((f) => selectedPaths.includes(f.path));
      if (dragFiles.length === 0) dragFiles = [file];
    } else {
      onSelect(file.path, false);
      dragFiles = [file];
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('keydown', handleKeyDown);
      setActiveDrag(null);
    };

    const handleKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        cleanup();
      }
    };

    const handlePointerCancel = () => {
      cleanup();
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const dist = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
      if (!isDragActive && dist < 6) {
        return;
      }

      if (!isDragActive) {
        isDragActive = true;
      }

      moveEvent.preventDefault();

      // Detect pane & folder under cursor
      const elem = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const paneElem = elem?.closest('[data-pane]');
      const targetPane = paneElem?.getAttribute('data-pane') as 'local' | 'remote' | null;

      const folderElem = elem?.closest('[data-folder-path]');
      const targetFolder = folderElem?.getAttribute('data-folder-path') || null;

      setActiveDrag({
        source: isLocal ? 'local' : 'remote',
        files: dragFiles,
        currentX: moveEvent.clientX,
        currentY: moveEvent.clientY,
        isDragging: true,
        hoverPane: targetPane,
        hoverFolderPath: targetFolder,
      });
    };

    const handlePointerUp = async (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('keydown', handleKeyDown);

      if (!isDragActive) {
        setActiveDrag(null);
        return;
      }

      const elem = document.elementFromPoint(upEvent.clientX, upEvent.clientY);
      const paneElem = elem?.closest('[data-pane]');
      const targetPane = paneElem?.getAttribute('data-pane') as 'local' | 'remote' | null;
      const folderElem = elem?.closest('[data-folder-path]');
      const targetFolder = folderElem?.getAttribute('data-folder-path') || null;

      setActiveDrag(null);

      // Only execute transfer if released on the opposite pane
      if (targetPane && targetPane !== (isLocal ? 'local' : 'remote')) {
        const store = useOrbitStore.getState();
        // Pin the profile for the whole drop: the loop awaits folder scans, during which the
        // user may switch profiles.
        const profileId = store.activeProfileId;
        const targetBaseDir =
          targetFolder ||
          (targetPane === 'remote' ? store.currentPath : store.localPath);

        const requests: TransferRequest[] = [];
        for (const item of dragFiles) {
          if (item.is_dir) {
            await store.enqueueFolder({
              direction: isLocal ? 'upload' : 'download',
              sourcePath: item.path,
              destDir: targetBaseDir,
              name: item.name,
              profileId,
            });
          } else if (isLocal && targetPane === 'remote') {
            const remoteTarget =
              targetBaseDir === '/'
                ? `/${item.name}`
                : `${targetBaseDir.replace(/\/+$/, '')}/${item.name}`;
            requests.push({ direction: 'upload', localPath: item.path, remotePath: remoteTarget, fileName: item.name });
          } else if (!isLocal && targetPane === 'local') {
            const localTarget = `${targetBaseDir.replace(/[/\\]+$/, '')}/${item.name}`;
            requests.push({ direction: 'download', localPath: localTarget, remotePath: item.path, fileName: item.name });
          }
        }
        await store.enqueueTransfers(requests, { profileId });
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('keydown', handleKeyDown);
  };

  return (
    <div
      ref={containerRef}
      data-pane={isLocal ? 'local' : 'remote'}
      data-current-path={currentPath}
      tabIndex={0}
      onFocus={() => setActivePane(isLocal ? 'local' : 'remote')}
      onClick={() => setActivePane(isLocal ? 'local' : 'remote')}
      onKeyDown={handleKeyDown}
      onContextMenu={handleBackgroundContextMenu}
      className="flex-1 flex flex-col h-full bg-background overflow-hidden outline-none select-none relative"
    >
      {/* Pane title bar if specified (e.g. for dual pane) */}
      {title && (
        <div className="h-8 px-3 flex items-center justify-between bg-surface-muted/60 border-b border-border-subtle text-xs text-zinc-400 font-mono">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <button
              type="button"
              onClick={handleGoUp}
              disabled={currentPath === '/' || currentPath === '' || currentPath === '\\'}
              className="p-1 rounded hover:bg-white/10 text-zinc-400 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent transition-colors flex-shrink-0"
              title="Dossier parent (..)"
            >
              <FolderUp className="w-3.5 h-3.5" />
            </button>
            <div className="flex items-center gap-1 font-semibold text-zinc-300 flex-shrink-0">
              <HardDrive className="w-3.5 h-3.5 text-zinc-400" />
              <span>{title}</span>
            </div>
            <span className="text-zinc-600 flex-shrink-0">/</span>
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar text-[11px] min-w-0">
              <button
                type="button"
                onClick={() => handlePaneBreadcrumbClick(-1)}
                className="hover:text-white text-zinc-400 transition-colors flex-shrink-0"
                title="Racine"
              >
                {rootPrefix}
              </button>
              {paneSegments.map((segment, idx) => (
                <React.Fragment key={idx}>
                  <span className="text-zinc-600 flex-shrink-0">/</span>
                  <button
                    type="button"
                    onClick={() => handlePaneBreadcrumbClick(idx)}
                    className={`hover:text-white transition-colors truncate max-w-[100px] flex-shrink-0 ${idx === paneSegments.length - 1 ? 'text-zinc-200 font-semibold' : 'text-zinc-400'
                      }`}
                    title={segment}
                  >
                    {segment}
                  </button>
                </React.Fragment>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0 ml-2">
            <span className="text-[11px] text-zinc-500">
              {files.length} élément{files.length > 1 ? 's' : ''}
              {searchQuery.trim() ? ' (filtré)' : ''}
            </span>
            {!isLocal && isSftp && (
              <button
                type="button"
                onKeyDown={(e) => e.stopPropagation()}
                onClick={() => openExternalTerminal(currentPath)}
                className="p-1 rounded hover:bg-white/10 text-zinc-400 hover:text-white transition-colors ml-1"
                title={`Ouvrir dans le terminal (${currentPath})`}
              >
                <Terminal className="w-3.5 h-3.5 text-zinc-400 hover:text-indigo-400 transition-colors" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Table Header with interactive column sorting */}
      <div
        onKeyDown={(e) => e.stopPropagation()}
        className="grid grid-cols-12 gap-x-3 px-4 py-2 text-[11px] font-medium text-zinc-500 uppercase tracking-wider border-b border-border-subtle bg-surface/30 select-none"
      >
        <button
          type="button"
          onClick={() => handleSort('name')}
          className="col-span-5 flex items-center gap-1.5 hover:text-zinc-200 transition-colors text-left group"
          title="Trier par nom"
        >
          <span className={sortColumn === 'name' ? 'text-zinc-200 font-semibold' : ''}>Nom</span>
          {sortColumn === 'name' ? (
            sortDirection === 'asc' ? (
              <ArrowUp className="w-3 h-3 text-sky-400 flex-shrink-0" />
            ) : (
              <ArrowDown className="w-3 h-3 text-sky-400 flex-shrink-0" />
            )
          ) : (
            <ArrowUpDown className="w-3 h-3 text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
          )}
        </button>

        <button
          type="button"
          onClick={() => handleSort('size')}
          className="col-span-2 flex items-center justify-end gap-1.5 hover:text-zinc-200 transition-colors group text-right"
          title="Trier par taille"
        >
          {sortColumn === 'size' ? (
            sortDirection === 'asc' ? (
              <ArrowUp className="w-3 h-3 text-sky-400 flex-shrink-0" />
            ) : (
              <ArrowDown className="w-3 h-3 text-sky-400 flex-shrink-0" />
            )
          ) : (
            <ArrowUpDown className="w-3 h-3 text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
          )}
          <span className={sortColumn === 'size' ? 'text-zinc-200 font-semibold' : ''}>Taille</span>
        </button>

        <button
          type="button"
          onClick={() => handleSort('owner')}
          className="col-span-2 flex items-center justify-end gap-1.5 hover:text-zinc-200 transition-colors group text-right"
          title="Trier par propriétaire"
        >
          {sortColumn === 'owner' ? (
            sortDirection === 'asc' ? (
              <ArrowUp className="w-3 h-3 text-sky-400 flex-shrink-0" />
            ) : (
              <ArrowDown className="w-3 h-3 text-sky-400 flex-shrink-0" />
            )
          ) : (
            <ArrowUpDown className="w-3 h-3 text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
          )}
          <span className={sortColumn === 'owner' ? 'text-zinc-200 font-semibold' : ''}>Propriétaire</span>
        </button>

        <button
          type="button"
          onClick={() => handleSort('mtime')}
          className="col-span-2 flex items-center justify-end gap-1.5 hover:text-zinc-200 transition-colors group text-right"
          title="Trier par date de modification"
        >
          {sortColumn === 'mtime' ? (
            sortDirection === 'asc' ? (
              <ArrowUp className="w-3 h-3 text-sky-400 flex-shrink-0" />
            ) : (
              <ArrowDown className="w-3 h-3 text-sky-400 flex-shrink-0" />
            )
          ) : (
            <ArrowUpDown className="w-3 h-3 text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
          )}
          <span className={sortColumn === 'mtime' ? 'text-zinc-200 font-semibold' : ''}>Modifié</span>
        </button>

        <button
          type="button"
          onClick={() => handleSort('permissions')}
          className="col-span-1 flex items-center justify-end gap-1 hover:text-zinc-200 transition-colors group text-right font-mono"
          title="Trier par permissions"
        >
          {sortColumn === 'permissions' ? (
            sortDirection === 'asc' ? (
              <ArrowUp className="w-3 h-3 text-sky-400 flex-shrink-0" />
            ) : (
              <ArrowDown className="w-3 h-3 text-sky-400 flex-shrink-0" />
            )
          ) : (
            <ArrowUpDown className="w-3 h-3 text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
          )}
          <span className={sortColumn === 'permissions' ? 'text-zinc-200 font-semibold' : ''}>Attr</span>
        </button>
      </div>

      {/* Persistent status region for screen readers */}
      <div role="status" aria-live="polite" className="sr-only">
        {currentNavigationError ? currentNavigationError.message : ''}
      </div>

      {/* Navigation / Permission Error Banner */}
      {currentNavigationError && (
        <div
          role="status"
          onKeyDown={(e) => e.stopPropagation()}
          className="mx-2 my-1.5 p-2.5 rounded-lg bg-red-500/10 border border-red-500/25 flex items-start justify-between gap-2.5 text-xs animate-in fade-in duration-150"
        >
          <div className="flex items-start gap-2 min-w-0">
            <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
            <div className="space-y-1.5 min-w-0">
              <div className="text-red-300 font-medium">
                {currentNavigationError.message}
              </div>
              {currentNavigationError.isPermissionDenied && !isLocal && sudoCapability === 'passwordless' && (
                <div className="pt-0.5">
                  <button
                    type="button"
                    onClick={() => elevateActiveSession(currentNavigationError.path)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 text-[11px] font-medium transition-all shadow-sm"
                  >
                    <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                    <span>Ouvrir avec les privilèges Sudo</span>
                  </button>
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => clearNavigationError(isLocal ? 'local' : 'remote')}
            className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
            title="Masquer l'alerte"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Files List */}
      <div className="relative flex-1 overflow-y-auto px-1 py-1 divide-y divide-transparent">
        {isTargetOfDrag && (
          <div className="absolute inset-1 z-20 pointer-events-none border-2 border-dashed border-indigo-500 bg-indigo-500/15 backdrop-blur-[1px] flex items-center justify-center rounded-lg animate-in fade-in duration-100">
            <div className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-[#141722]/95 border border-indigo-500/40 text-white text-xs font-medium shadow-2xl">
              <Upload className="w-4 h-4 text-indigo-400 animate-bounce" />
              <span>
                Déposer {activeDrag?.files.length} élément{activeDrag?.files.length! > 1 ? 's' : ''} pour {isLocal ? 'télécharger ici' : 'importer sur le serveur'}
              </span>
            </div>
          </div>
        )}
        {/* Parent directory shortcut if not root */}
        {currentPath !== '/' && currentPath !== '' && (
          <div
            onDoubleClick={handleGoUp}
            className="grid grid-cols-12 gap-x-3 px-3 py-1.5 rounded text-xs text-zinc-400 hover:bg-surface-hover hover:text-white cursor-pointer items-center transition-colors"
          >
            <div className="col-span-5 flex items-center gap-2.5">
              <FolderUp className="w-4 h-4 text-zinc-500" />
              <span className="font-mono text-zinc-400">..</span>
            </div>
            <div className="col-span-2 text-right text-zinc-600 font-mono text-[11px]">Dossier parent</div>
            <div className="col-span-2 text-right text-zinc-600 font-mono text-[11px]">--</div>
            <div className="col-span-2 text-right text-zinc-600 text-[11px]">--</div>
            <div className="col-span-1 text-right text-zinc-600 font-mono text-[10px]">--</div>
          </div>
        )}

        {sortedFiles.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-center p-6 text-zinc-500">
            {!isLocal && profiles.length === 0 ? (
              <>
                <div className="w-10 h-10 rounded-full bg-white/5 border border-border-subtle flex items-center justify-center mb-2.5">
                  <Server className="w-5 h-5 text-zinc-500" />
                </div>
                <p className="text-zinc-300 text-xs font-medium">Aucun serveur connecté</p>
                <p className="text-zinc-500 text-[11px] mt-1 mb-3">
                  Créez ou sélectionnez une connexion pour explorer vos fichiers distants.
                </p>
                <button
                  type="button"
                  onClick={() => setNewConnectionModalOpen(true)}
                  className="px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-all flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Nouvelle connexion</span>
                </button>
              </>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <p className="text-xs">
                  {searchQuery.trim()
                    ? `Aucun fichier ne correspond à "${searchQuery}"`
                    : 'Dossier vide ou aucun fichier trouvé'}
                </p>
                {!searchQuery.trim() && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setActivePane(isLocal ? 'local' : 'remote');
                        setNewFolderModalOpen(true);
                      }}
                      className="px-2.5 py-1 rounded bg-white/5 hover:bg-white/10 text-zinc-300 text-xs flex items-center gap-1.5 transition-colors"
                    >
                      <FolderPlus className="w-3.5 h-3.5 text-indigo-400" />
                      <span>Créer un dossier</span>
                    </button>
                    {!isLocal && (
                      <button
                        type="button"
                        onClick={handleUploadDialog}
                        className="px-2.5 py-1 rounded bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 text-xs flex items-center gap-1.5 transition-colors"
                      >
                        <Upload className="w-3.5 h-3.5 text-indigo-400" />
                        <span>Importer des fichiers...</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          sortedFiles.map((file) => {
            const isSelected = selectedPaths.includes(file.path) || file.path === selectedPath;
            const isHoveredTarget = Boolean(
              activeDrag?.isDragging &&
              activeDrag?.hoverFolderPath === file.path &&
              activeDrag?.source !== (isLocal ? 'local' : 'remote')
            );

            return (
              <div
                key={file.path}
                data-folder-path={file.is_dir ? file.path : undefined}
                onPointerDown={(e) => handleRowPointerDown(e, file)}
                onClick={(e) => onSelect(file.path, e.metaKey || e.ctrlKey)}
                onDoubleClick={() => handleRowDoubleClick(file)}
                onContextMenu={(e) => handleRowContextMenu(e, file)}
                className={`grid grid-cols-12 gap-x-3 px-3 py-1.5 rounded text-xs items-center cursor-pointer transition-colors select-none ${isHoveredTarget
                    ? 'ring-2 ring-indigo-500 bg-indigo-500/25 text-white font-medium'
                    : isSelected
                      ? 'bg-indigo-600/20 text-white border border-indigo-500/30 font-medium'
                      : 'text-zinc-300 hover:bg-surface-hover hover:text-white'
                  }`}
              >
                {/* Name */}
                <div className="col-span-5 flex items-center gap-2.5 min-w-0 pr-2">
                  <FileIcon name={file.name} isDir={file.is_dir} />
                  <span className="truncate">{file.name}</span>
                </div>

                {/* Size */}
                <div className="col-span-2 text-right font-mono text-[11px] text-zinc-400">
                  {file.is_dir ? '--' : formatBytes(file.size)}
                </div>

                {/* Owner / Group */}
                <div
                  className="col-span-2 text-right font-mono text-[11px] text-zinc-400 truncate"
                  title={file.owner ? `${file.owner}${file.group ? `:${file.group}` : ''}` : undefined}
                >
                  {file.owner ? `${file.owner}${file.group ? `:${file.group}` : ''}` : '--'}
                </div>

                {/* Modified date */}
                <div className="col-span-2 text-right text-[11px] text-zinc-400">
                  {formatDate(file.modified_at)}
                </div>

                {/* Permissions / Attr */}
                <div className="col-span-1 text-right font-mono text-[10px] text-zinc-500">
                  {file.permissions || (file.is_dir ? 'drwxr-xr-x' : '-rw-r--r--')}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Bottom status bar for the pane */}
      <div className="h-6 px-3 bg-surface-muted/40 border-t border-border-subtle flex items-center justify-between text-[11px] text-zinc-500 font-mono">
        <div className="flex items-center gap-2">
          <span>
            {files.length} élément{files.length > 1 ? 's' : ''}
            {searchQuery.trim() ? ' (filtré)' : ''}
          </span>
          <span className="text-zinc-600">·</span>
          <span className="text-zinc-400">
            Tri : {sortColumn === 'name' ? 'Nom' : sortColumn === 'size' ? 'Taille' : sortColumn === 'owner' ? 'Propriétaire' : sortColumn === 'mtime' ? 'Date' : 'Attr'} ({sortDirection === 'asc' ? 'croissant' : 'décroissant'})
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span>Clic droit : Menu</span>
          <span>•</span>
          <span>Espace : Aperçu</span>
        </div>
      </div>

      {/* Context Menu Dropdown */}
      {contextMenu && (
        <div
          style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }}
          onClick={(e) => e.stopPropagation()}
          className="fixed z-50 w-52 bg-[#141722]/95 backdrop-blur-xl border border-white/10 rounded-lg shadow-2xl py-1 text-xs text-zinc-300 select-none animate-in fade-in duration-75"
        >
          {contextMenu.file ? (
            <>
              {/* Quick Look */}
              {!contextMenu.file.is_dir && (
                <button
                  type="button"
                  onClick={() => {
                    const f = contextMenu.file;
                    setContextMenu(null);
                    if (f) setQuickLookFile(f);
                  }}
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-white/10 hover:text-white transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <Eye className="w-3.5 h-3.5 text-zinc-400" />
                    <span>Aperçu rapide</span>
                  </div>
                  <kbd className="text-[10px] text-zinc-500 bg-white/5 px-1 py-0.5 rounded font-mono">Espace</kbd>
                </button>
              )}

              {/* Edit in a local text editor (remote files; uploaded back on each save) */}
              {!isLocal && !contextMenu.file.is_dir && isTauri() && (
                <button
                  type="button"
                  disabled={isElevated}
                  onClick={() => {
                    const target = contextMenu.file;
                    setContextMenu(null);
                    if (target) openLocalEdit(target.path);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                  title={
                    isElevated
                      ? "Désactivé en mode sudo"
                      : "Ouvrir dans l'éditeur de texte du système ; chaque enregistrement est renvoyé sur le serveur"
                  }
                >
                  <FilePen className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Modifier localement</span>
                </button>
              )}

              {/* Dual-Pane Quick Send / Download */}
              {isDualPane && isLocal && (
                <button
                  type="button"
                  onClick={() => handleSendToRemote(contextMenu.file!)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-indigo-600/20 text-indigo-300 hover:text-white transition-colors"
                >
                  <ArrowRight className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Envoyer vers le distant</span>
                </button>
              )}

              {isDualPane && !isLocal && (
                <button
                  type="button"
                  onClick={() => handleDownloadToLocal(contextMenu.file!)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-indigo-600/20 text-indigo-300 hover:text-white transition-colors"
                >
                  <ArrowLeft className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Télécharger dans le dossier local</span>
                </button>
              )}

              {/* Download (Remote only; folders need the native directory picker) */}
              {!isLocal && (!contextMenu.file.is_dir || isTauri()) && (
                <button
                  type="button"
                  onClick={() => handleDownload(contextMenu.file!)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/10 hover:text-white transition-colors"
                >
                  <Download className="w-3.5 h-3.5 text-sky-400" />
                  <span>{contextMenu.file.is_dir ? 'Télécharger le dossier dans...' : 'Télécharger sous...'}</span>
                </button>
              )}

              {/* Ouvrir un terminal ici (Dossier distant SFTP) */}
              {!isLocal && contextMenu.file.is_dir && isSftp && (
                <button
                  type="button"
                  onClick={() => {
                    const dirPath = contextMenu.file?.path;
                    setContextMenu(null);
                    if (dirPath) {
                      openExternalTerminal(dirPath);
                    }
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/10 hover:text-white transition-colors"
                >
                  <Terminal className="w-3.5 h-3.5 text-zinc-400" />
                  <span>Ouvrir un terminal ici</span>
                </button>
              )}

              {/* Rename */}
              <button
                type="button"
                onClick={() => {
                  const target = contextMenu.file;
                  setContextMenu(null);
                  if (target) setRenameTarget(target);
                }}
                className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-white/10 hover:text-white transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Pencil className="w-3.5 h-3.5 text-amber-400" />
                  <span>Renommer...</span>
                </div>
                <kbd className="text-[10px] text-zinc-500 bg-white/5 px-1 py-0.5 rounded font-mono">F2</kbd>
              </button>

              {/* Permissions (Local & SFTP) */}
              {(isLocal || isSftp) && (
                <button
                  type="button"
                  onClick={() => {
                    const target = contextMenu.file;
                    setContextMenu(null);
                    if (target) setPermissionsTarget(target);
                  }}
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-white/10 hover:text-white transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <KeyRound className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Permissions...</span>
                  </div>
                </button>
              )}

              <div className="my-1 border-t border-white/10" />

              {/* New Folder inside current dir */}
              <button
                type="button"
                onClick={() => {
                  setActivePane(isLocal ? 'local' : 'remote');
                  setContextMenu(null);
                  setNewFolderModalOpen(true);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/10 hover:text-white transition-colors"
              >
                <FolderPlus className="w-3.5 h-3.5 text-indigo-400" />
                <span>Nouveau dossier...</span>
              </button>

              <div className="my-1 border-t border-white/10" />

              {/* Delete */}
              <button
                type="button"
                onClick={() => {
                  const target = contextMenu.file;
                  setContextMenu(null);
                  if (target) setDeleteTarget(target);
                }}
                className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-red-500/10 text-red-400 hover:text-red-300 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Trash2 className="w-3.5 h-3.5 text-red-400" />
                  <span>Supprimer</span>
                </div>
                <kbd className="text-[10px] text-red-400/60 bg-red-500/10 px-1 py-0.5 rounded font-mono">⌫</kbd>
              </button>
            </>
          ) : (
            <>
              {/* Context menu on empty area */}
              {!isLocal && (
                <button
                  type="button"
                  onClick={handleUploadDialog}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/10 hover:text-white transition-colors"
                >
                  <Upload className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Importer des fichiers...</span>
                </button>
              )}

              {/* Ouvrir un terminal ici (Répertoire courant distant SFTP) */}
              {!isLocal && isSftp && (
                <button
                  type="button"
                  onClick={() => {
                    setContextMenu(null);
                    openExternalTerminal(currentPath);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/10 hover:text-white transition-colors"
                >
                  <Terminal className="w-3.5 h-3.5 text-zinc-400" />
                  <span>Ouvrir un terminal ici</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  setActivePane(isLocal ? 'local' : 'remote');
                  setContextMenu(null);
                  setNewFolderModalOpen(true);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/10 hover:text-white transition-colors"
              >
                <FolderPlus className="w-3.5 h-3.5 text-indigo-400" />
                <span>Nouveau dossier...</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setContextMenu(null);
                  if (isLocal) {
                    refreshLocal();
                  } else {
                    refreshRemote();
                  }
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/10 hover:text-white transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5 text-zinc-400" />
                <span>Actualiser</span>
              </button>
            </>
          )}
        </div>
      )}

      {/* MODAL 1: Nouveau Dossier */}
      {isModalActive && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm bg-[#161926] border border-white/10 rounded-xl shadow-2xl p-5 text-zinc-200"
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
                  <FolderPlus className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">Nouveau dossier</h3>
                  <p className="text-[11px] text-zinc-400 truncate max-w-[220px]">
                    Dans : {currentPath}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setNewFolderModalOpen(false)}
                className="p-1 rounded text-zinc-500 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {modalError && (
              <div className="mb-3 p-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            <form onSubmit={handleCreateFolderSubmit}>
              <div className="mb-4">
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                  Nom du dossier
                </label>
                <input
                  type="text"
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={newFolderNameInput}
                  onChange={(e) => setNewFolderNameInput(e.target.value)}
                  placeholder="ex: assets, uploads, logs..."
                  className="w-full px-3 py-1.5 rounded-lg bg-surface-muted border border-white/10 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 font-mono"
                />
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setNewFolderModalOpen(false)}
                  disabled={isSubmitting}
                  className="px-3 py-1.5 rounded-md hover:bg-white/10 text-xs text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !newFolderNameInput.trim()}
                  className="px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  {isSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>Créer</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: Renommer */}
      {renameTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm bg-[#161926] border border-white/10 rounded-xl shadow-2xl p-5 text-zinc-200"
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
                  <Pencil className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">Renommer l'élément</h3>
                  <p className="text-[11px] text-zinc-400 truncate max-w-[220px]">
                    Actuel : {renameTarget.name}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRenameTarget(null)}
                className="p-1 rounded text-zinc-500 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {modalError && (
              <div className="mb-3 p-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            <form onSubmit={handleRenameSubmit}>
              <div className="mb-4">
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                  Nouveau nom
                </label>
                <input
                  type="text"
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={renameInput}
                  onChange={(e) => setRenameInput(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-surface-muted border border-white/10 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 font-mono"
                />
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRenameTarget(null)}
                  disabled={isSubmitting}
                  className="px-3 py-1.5 rounded-md hover:bg-white/10 text-xs text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !renameInput.trim() || renameInput.trim() === renameTarget.name}
                  className="px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  {isSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>Renommer</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: Confirmer Suppression */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm bg-[#161926] border border-red-500/30 rounded-xl shadow-2xl p-5 text-zinc-200"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400 flex-shrink-0">
                <Trash2 className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-white">Supprimer {deleteTarget.is_dir ? 'le dossier' : 'le fichier'} ?</h3>
                <p className="text-xs text-zinc-400 truncate max-w-[220px] font-mono mt-0.5">
                  {deleteTarget.name}
                </p>
              </div>
            </div>

            {deleteTarget.is_dir ? (
              <div className="mb-4 bg-amber-500/10 border border-amber-500/20 p-3 rounded-lg text-xs space-y-1.5">
                <div className="flex items-center gap-1.5 font-medium text-amber-300">
                  <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                  <span>Suppression récursive du dossier</span>
                </div>
                {deleteItemCount !== null && (
                  <p className="text-[11px] text-zinc-300">
                    {deleteItemCount === 0 ? (
                      <span className="text-zinc-400">Le dossier est actuellement vide.</span>
                    ) : (
                      <span className="text-amber-200">
                        Ce dossier contient au moins <strong className="font-semibold text-white">{deleteItemCount}</strong> élément{deleteItemCount > 1 ? 's' : ''}.
                      </span>
                    )}
                  </p>
                )}
                <p className="text-zinc-400 text-[11px] leading-relaxed">
                  Cette action est <span className="text-red-400 font-medium">définitive et irréversible</span>. Le dossier ainsi que tous les fichiers et sous-dossiers qu'il contient seront définitivement supprimés.
                </p>
              </div>
            ) : (
              <p className="text-xs text-zinc-400 mb-4 bg-white/5 p-2.5 rounded-lg border border-white/5">
                Cette action est <span className="text-red-400 font-medium">définitive et irréversible</span>. Le fichier sera effacé du serveur distant.
              </p>
            )}

            {modalError && (
              <div className="mb-3 p-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={isSubmitting}
                className="px-3 py-1.5 rounded-md hover:bg-white/10 text-xs text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={handleDeleteSubmit}
                disabled={isSubmitting}
                className="px-3.5 py-1.5 rounded-md bg-red-600 hover:bg-red-500 text-white text-xs font-medium transition-colors flex items-center gap-1.5 disabled:opacity-50 shadow-sm shadow-red-900/50"
              >
                {isSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Supprimer définitivement</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 4: Permissions */}
      <PermissionsModal
        file={permissionsTarget}
        isOpen={Boolean(permissionsTarget)}
        isLocal={isLocal}
        profileId={activeProfileId}
        directoryFiles={files}
        onClose={() => setPermissionsTarget(null)}
        onSave={handleSavePermissions}
      />
    </div>
  );
};
