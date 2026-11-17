import { useEffect } from 'react';
import { useOrbitStore } from './store/useOrbitStore';
import { isTauri } from './services/storageApi';
import { Sidebar } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';
import { WindowsTitlebar } from './components/layout/WindowsTitlebar';
import { DualPaneView } from './components/explorer/DualPaneView';
import { QuickLookModal } from './components/modals/QuickLookModal';
import { TransferDrawer } from './components/transfers/TransferDrawer';
import { NewConnectionModal } from './components/modals/NewConnectionModal';
import { ExportProfilesModal } from './components/modals/ExportProfilesModal';
import { HostKeyVerificationModal } from './components/modals/HostKeyVerificationModal';
import { UpdateModal } from './components/modals/UpdateModal';
import { TransferConflictModal } from './components/modals/TransferConflictModal';

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
  } = useOrbitStore();

  // Load saved profiles from disk on startup & check for updates silently
  useEffect(() => {
    loadPersistedProfiles();
    checkForUpdates(false);
  }, [loadPersistedProfiles, checkForUpdates]);

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
              const { currentPath, enqueueTransfers } = store;

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

              await enqueueTransfers(
                paths.map((filePath) => {
                  const fileName = filePath.split(/[/\\]/).pop() || 'file';
                  const remoteTarget =
                    targetDir === '/'
                      ? `/${fileName}`
                      : `${targetDir.replace(/\/+$/, '')}/${fileName}`;
                  return { direction: 'upload' as const, localPath: filePath, remotePath: remoteTarget, fileName };
                })
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
      <HostKeyVerificationModal />
      <UpdateModal />
      <TransferConflictModal />
    </div>
  );
}

export default App;
