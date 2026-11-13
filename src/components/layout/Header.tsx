import React, { useRef, useEffect } from 'react';
import { useOrbitStore } from '../../store/useOrbitStore';
import {
  ChevronRight,
  Search,
  Columns2,
  ArrowUpDown,
  Folder,
} from 'lucide-react';

export const Header: React.FC = () => {
  const {
    currentPath,
    setCurrentPath,
    searchQuery,
    setSearchQuery,
    isDualPane,
    toggleDualPane,
    transfers,
    toggleTransferDrawer,
  } = useOrbitStore();

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Global shortcut Cmd+F / Ctrl+F focus
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const pathSegments = currentPath.split('/').filter(Boolean);

  const handleBreadcrumbClick = (index: number) => {
    if (index === -1) {
      setCurrentPath('/');
    } else {
      const newPath = '/' + pathSegments.slice(0, index + 1).join('/');
      setCurrentPath(newPath);
    }
  };

  const activeTransfersCount = transfers.filter(
    (t) => t.status === 'transferring' || t.status === 'queued'
  ).length;

  return (
    <header
      data-tauri-drag-region
      className="h-11 flex-shrink-0 flex items-center justify-between border-b border-border-subtle bg-surface/60 backdrop-blur-xl px-4 select-none"
    >
      {/* Left: Breadcrumbs navigation with macOS traffic lights offset if needed */}
      <div className="flex items-center gap-1.5 text-xs text-zinc-400 overflow-x-auto no-scrollbar">
        <button
          onClick={() => handleBreadcrumbClick(-1)}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/10 hover:text-white transition-colors"
          title="Racine"
        >
          <Folder className="w-3.5 h-3.5 text-zinc-400" />
          <span className="font-mono text-zinc-300">/</span>
        </button>

        {pathSegments.map((segment, index) => (
          <React.Fragment key={index}>
            <ChevronRight className="w-3 h-3 text-zinc-600 flex-shrink-0" />
            <button
              onClick={() => handleBreadcrumbClick(index)}
              className={`px-1.5 py-0.5 rounded transition-colors truncate max-w-[120px] font-mono ${
                index === pathSegments.length - 1
                  ? 'text-white font-medium bg-white/[0.08]'
                  : 'hover:bg-white/10 hover:text-white text-zinc-300'
              }`}
            >
              {segment}
            </button>
          </React.Fragment>
        ))}
      </div>

      {/* Right: Actions, Filter and Dual Pane toggle */}
      <div className="flex items-center gap-2">
        {/* Instant filter input */}
        <div className="relative flex items-center">
          <Search className="w-3.5 h-3.5 absolute left-2 text-zinc-500 pointer-events-none" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filtrer..."
            className="w-36 focus:w-48 transition-all bg-surface-muted border border-border-subtle rounded-md pl-7 pr-12 py-1 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/20 font-mono"
          />
          <kbd className="absolute right-1.5 text-[9px] bg-white/5 border border-border-subtle text-zinc-500 px-1 py-0.5 rounded pointer-events-none">
            ⌘F
          </kbd>
        </div>

        {/* Dual Pane toggle button */}
        <button
          onClick={toggleDualPane}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border transition-all ${
            isDualPane
              ? 'bg-accent-brand/20 border-indigo-500/40 text-indigo-300 shadow-sm'
              : 'bg-surface-muted hover:bg-surface-hover border-border-subtle text-zinc-400 hover:text-zinc-200'
          }`}
          title="Bascule mode double panneau (Local | Distant) [⌘B]"
        >
          <Columns2 className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Double</span>
          <kbd className="text-[9px] text-zinc-500 bg-white/5 px-1 rounded">⌘B</kbd>
        </button>

        {/* Active transfers drawer trigger */}
        {activeTransfersCount > 0 && (
          <button
            onClick={toggleTransferDrawer}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition-all animate-pulse"
            title="Ouvrir la file des transferts"
          >
            <ArrowUpDown className="w-3.5 h-3.5" />
            <span className="font-mono text-[11px] font-semibold">{activeTransfersCount}</span>
          </button>
        )}
      </div>
    </header>
  );
};
