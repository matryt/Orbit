import { useEffect } from 'react';
import { useOrbitStore } from './store/useOrbitStore';
import { Sidebar } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';
import { WindowsTitlebar } from './components/layout/WindowsTitlebar';
import { DualPaneView } from './components/explorer/DualPaneView';
import { QuickLookModal } from './components/modals/QuickLookModal';
import { TransferDrawer } from './components/transfers/TransferDrawer';
import { NewConnectionModal } from './components/modals/NewConnectionModal';
import { ExportProfilesModal } from './components/modals/ExportProfilesModal';
import { HostKeyVerificationModal } from './components/modals/HostKeyVerificationModal';

export function App() {
  const {
    toggleDualPane,
    toggleQuickLook,
    quickLookFile,
    setQuickLookFile,
    loadPersistedProfiles,
    isNewConnectionModalOpen,
    isExportModalOpen,
  } = useOrbitStore();

  // Load saved profiles from disk on startup
  useEffect(() => {
    loadPersistedProfiles();
  }, [loadPersistedProfiles]);

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
    </div>
  );
}

export default App;
