import React, { useRef } from 'react';
import { useOrbitStore } from '../../store/useOrbitStore';
import { FileIcon } from './FileIcon';
import { formatBytes, formatDate } from '../../lib/utils';
import { FileEntry } from '../../types';
import { FolderUp, HardDrive } from 'lucide-react';

interface ExplorerViewProps {
  files: FileEntry[];
  currentPath: string;
  onNavigate: (path: string) => void;
  selectedPath: string | null;
  onSelect: (path: string, multi?: boolean) => void;
  title?: string;
  isLocal?: boolean;
}

export const ExplorerView: React.FC<ExplorerViewProps> = ({
  files,
  currentPath,
  onNavigate,
  selectedPath,
  onSelect,
  title,
}) => {
  const { setQuickLookFile, toggleQuickLook } = useOrbitStore();
  const containerRef = useRef<HTMLDivElement>(null);

  // Navigate up one folder
  const handleGoUp = () => {
    if (currentPath === '/' || currentPath === '') return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    const parent = parts.length === 0 ? '/' : '/' + parts.join('/');
    onNavigate(parent);
  };

  const handleRowDoubleClick = (file: FileEntry) => {
    if (file.is_dir) {
      onNavigate(file.path);
    } else {
      setQuickLookFile(file);
    }
  };

  // Keyboard navigation inside list
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (files.length === 0) return;

    const currentIndex = files.findIndex((f) => f.path === selectedPath);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = currentIndex < files.length - 1 ? currentIndex + 1 : 0;
      onSelect(files[nextIndex].path);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : files.length - 1;
      onSelect(files[prevIndex].path);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = files.find((f) => f.path === selectedPath);
      if (selected) {
        handleRowDoubleClick(selected);
      }
    } else if (e.code === 'Space') {
      e.preventDefault();
      const selected = files.find((f) => f.path === selectedPath);
      if (selected && !selected.is_dir) {
        toggleQuickLook();
      }
    }
  };

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="flex-1 flex flex-col h-full bg-background overflow-hidden outline-none select-none"
    >
      {/* Pane title bar if specified (e.g. for dual pane) */}
      {title && (
        <div className="h-8 px-4 flex items-center justify-between bg-surface-muted/60 border-b border-border-subtle text-xs text-zinc-400 font-mono">
          <div className="flex items-center gap-1.5">
            <HardDrive className="w-3.5 h-3.5 text-zinc-500" />
            <span className="font-semibold text-zinc-300">{title}</span>
            <span className="text-zinc-600 truncate max-w-[200px]">{currentPath}</span>
          </div>
          <span className="text-[11px] text-zinc-500">{files.length} éléments</span>
        </div>
      )}

      {/* Table Header */}
      <div className="grid grid-cols-12 px-4 py-2 text-[11px] font-medium text-zinc-500 uppercase tracking-wider border-b border-border-subtle bg-surface/30">
        <div className="col-span-6 flex items-center gap-2">Nom</div>
        <div className="col-span-2 text-right">Taille</div>
        <div className="col-span-3 text-right">Modifié</div>
        <div className="col-span-1 text-right font-mono">Attr</div>
      </div>

      {/* Files List */}
      <div className="flex-1 overflow-y-auto px-1 py-1 divide-y divide-transparent">
        {/* Parent directory shortcut if not root */}
        {currentPath !== '/' && currentPath !== '' && (
          <div
            onDoubleClick={handleGoUp}
            className="grid grid-cols-12 px-3 py-1.5 rounded text-xs text-zinc-400 hover:bg-surface-hover hover:text-white cursor-pointer items-center transition-colors"
          >
            <div className="col-span-6 flex items-center gap-2.5">
              <FolderUp className="w-4 h-4 text-zinc-500" />
              <span className="font-mono text-zinc-400">..</span>
            </div>
            <div className="col-span-2 text-right text-zinc-600 font-mono text-[11px]">Dossier parent</div>
            <div className="col-span-3 text-right text-zinc-600 text-[11px]">--</div>
            <div className="col-span-1 text-right text-zinc-600 font-mono text-[10px]">--</div>
          </div>
        )}

        {files.length === 0 ? (
          <div className="h-48 flex flex-col items-center justify-center text-zinc-500 text-xs">
            <p>Dossier vide ou aucun fichier trouvé</p>
          </div>
        ) : (
          files.map((file) => {
            const isSelected = file.path === selectedPath;
            return (
              <div
                key={file.path}
                onClick={(e) => onSelect(file.path, e.metaKey || e.ctrlKey)}
                onDoubleClick={() => handleRowDoubleClick(file)}
                className={`grid grid-cols-12 px-3 py-1.5 rounded text-xs items-center cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-indigo-600/20 text-white border border-indigo-500/30 font-medium'
                    : 'text-zinc-300 hover:bg-surface-hover hover:text-white'
                }`}
              >
                {/* Name */}
                <div className="col-span-6 flex items-center gap-2.5 min-w-0 pr-2">
                  <FileIcon name={file.name} isDir={file.is_dir} />
                  <span className="truncate">{file.name}</span>
                </div>

                {/* Size */}
                <div className="col-span-2 text-right font-mono text-[11px] text-zinc-400">
                  {file.is_dir ? '--' : formatBytes(file.size)}
                </div>

                {/* Modified date */}
                <div className="col-span-3 text-right text-[11px] text-zinc-400">
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
        <div>
          {files.length} élément{files.length > 1 ? 's' : ''}
        </div>
        <div>
          Espace : Aperçu rapide (Quick Look)
        </div>
      </div>
    </div>
  );
};
