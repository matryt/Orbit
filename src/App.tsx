import { useEffect } from 'react';
import { useOrbitStore } from './store/useOrbitStore';
import { isTauri, storageApi } from './services/storageApi';
import { Sidebar } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';
import { WindowsTitlebar } from './components/layout/WindowsTitlebar';
import { DualPaneView } from './components/explorer/DualPaneView';
import { QuickLookModal } from './components/modals/QuickLookModal';
import { TransferDrawer } from './components/transfers/TransferDrawer';
import { NewConnectionModal } from './components/modals/NewConnectionModal';
import { ExportProfilesModal } from './components/modals/ExportProfilesModal';
import { ImportProfilesModal } from './components/modals/ImportProfilesModal';
import { HostKeyVerificationModal } from './components/modals/HostKeyVerificationModal';
import { UpdateModal } from './components/modals/UpdateModal';
import { TransferConflictModal } from './components/modals/TransferConflictModal';
import { LocalEditConflictModal } from './components/modals/LocalEditConflictModal';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { LocalEditInfo } from './types';

const UPDATE_RECHECK_INTERVAL_MS = 60 * 60 * 1000;

export function App() {
  const {
    toggleDualPane,
    toggleQuickLook,
    quickLookFile,
    setQuickLookFile,
    loadPersistedProfiles,
    checkForUpdates,
    isNewConnectionModalOpen,
    isExportModalOpen,
    isImportModalOpen,
    loadLocalEdits,
    applyLocalEditStatus,
    applyLocalEditClosed,
    confirmCloseLocalEdits,
  } = useOrbitStore();

  // Local edit sessions: initial state, then backend events.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (p: Promise<() => void>) =>
      p.then((un) => (disposed ? un() : unlisteners.push(un))).catch((err) =>
        console.error('Failed to listen to local edit events:', err)
      );
    track(listen<LocalEditInfo>('local-edit://status', (e) => applyLocalEditStatus(e.payload)));
    track(listen<string>('local-edit://closed', (e) => applyLocalEditClosed(e.payload)));
    loadLocalEdits();
    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, [loadLocalEdits, applyLocalEditStatus, applyLocalEditClosed]);

  // Closing the window ends every local edit session: ask first.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (!(await confirmCloseLocalEdits())) event.preventDefault();
      })
      .then((un) => (disposed ? un() : (unlisten = un)))
      .catch((err) => console.error('Failed to register close handler:', err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [confirmCloseLocalEdits]);

  // Load saved profiles from disk on startup & check for updates silently
  useEffect(() => {
    loadPersistedProfiles();
    checkForUpdates(false);
  }, [loadPersistedProfiles, checkForUpdates]);

  // Re-check hourly so long-running sessions see new releases and expired snoozes.
  // One unauthenticated GitHub API call per hour stays far below the rate limit.
  useEffect(() => {
    const timer = window.setInterval(() => checkForUpdates(false), UPDATE_RECHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [checkForUpdates]);

  // Singleton OS drag-and-drop listener (macOS Finder / Windows Explorer)
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let isDisposed = false;
    let lastDropTime = 0;

    (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const unlistenFn = await getCurrentWebview().onDragDropEvent(
          async (event) => {
            if (event.payload.type === 'drop') {
              const now = Date.now();
              if (now - lastDropTime < 400) {
                return; // debounce duplicate drop events
              }
              lastDropTime = now;

              const paths = event.payload.paths;
              if (!paths || paths.length === 0) return;

              const store = useOrbitStore.getState();
              // Pin the profile with the remote path: the loop below awaits folder scans, during
              // which the user may switch profiles.
              const { currentPath, activeProfileId: profileId, enqueueTransfers, enqueueFolder } = store;

              // Determine if drop happened over a specific folder element
              let targetDir = currentPath;
              const position = event.payload.position;
              if (position) {
                const scale = window.devicePixelRatio || 1;
                const elem = document.elementFromPoint(
                  position.x / scale,
                  position.y / scale
                );
                const folderElem = elem?.closest('[data-folder-path]');
                if (folderElem) {
                  const folderPath = folderElem.getAttribute('data-folder-path');
                  if (folderPath) {
                    targetDir = folderPath;
                  }
                }
              }

              const files: { path: string; name: string }[] = [];
              for (const filePath of paths) {
                const name = filePath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || 'file';
                let isDir = false;
                try {
                  isDir = await storageApi.localIsDir(filePath);
                } catch {
                  // Unreadable path: let the upload report the error.
                }
                if (isDir) {
                  await enqueueFolder({ direction: 'upload', sourcePath: filePath, destDir: targetDir, name, profileId });
                } else {
                  files.push({ path: filePath, name });
                }
              }
              await enqueueTransfers(
                files.map(({ path, name }) => ({
                  direction: 'upload' as const,
                  localPath: path,
                  remotePath: targetDir === '/' ? `/${name}` : `${targetDir.replace(/\/+$/, '')}/${name}`,
                  fileName: name,
                })),
                { profileId }
              );
            }
          }
        );

        if (isDisposed) {
          unlistenFn();
        } else {
          unlisten = unlistenFn;
        }
      } catch (err) {
        console.error('Failed to register global Tauri drag-drop listener:', err);
      }
    })();

    return () => {
      isDisposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept shortcuts if user is typing in an input
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        return;
      }

      // Cmd+B / Ctrl+B: Toggle dual pane
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleDualPane();
        return;
      }

      // Space: Quick Look
      if (e.code === 'Space') {
        e.preventDefault();
        toggleQuickLook();
        return;
      }

      // Escape: close modal
      if (e.key === 'Escape') {
        if (quickLookFile) {
          e.preventDefault();
          setQuickLookFile(null);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleDualPane, toggleQuickLook, quickLookFile, setQuickLookFile]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-zinc-200 select-none antialiased">
      {/* Windows custom titlebar (hidden on macOS) */}
      <WindowsTitlebar />

      {/* Main app shell */}
      <div className="flex flex-1 h-full overflow-hidden">
        {/* Left Sidebar */}
        <Sidebar />

        {/* Right Main Panel */}
        <main className="flex-1 flex flex-col h-full overflow-hidden bg-background">
          <Header />
          <div className="flex-1 flex overflow-hidden relative">
            <DualPaneView />
          </div>
          <TransferDrawer />
        </main>
      </div>

      {/* Overlays & Modals */}
      <QuickLookModal />
      {isNewConnectionModalOpen && <NewConnectionModal />}
      {isExportModalOpen && <ExportProfilesModal />}
      {isImportModalOpen && <ImportProfilesModal />}
      <HostKeyVerificationModal />
      <UpdateModal />
      <TransferConflictModal />
      <LocalEditConflictModal />
    </div>
  );
}

export default App;
