import React, { useEffect, useState } from 'react';
import { Minus, Square, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { type as getOsType } from '@tauri-apps/plugin-os';

export const WindowsTitlebar: React.FC = () => {
  const [isWindows, setIsWindows] = useState(false);

  useEffect(() => {
    try {
      const osType = getOsType();
      if (osType === 'windows') {
        setIsWindows(true);
      }
    } catch {
      // In web/browser dev mode or non-tauri environment
      setIsWindows(navigator.userAgent.toLowerCase().includes('windows'));
    }
  }, []);

  if (!isWindows) {
    return null;
  }

  const appWindow = getCurrentWindow();

  return (
    <div
      data-tauri-drag-region
      className="h-8 bg-surface-muted border-b border-border-subtle flex items-center justify-between select-none z-50 text-xs text-zinc-400"
    >
      <div className="flex items-center gap-2 pl-3 pointer-events-none">
        <span className="font-semibold text-zinc-200 tracking-wide">Orbit</span>
      </div>
      <div className="flex items-center h-full">
        <button
          onClick={() => appWindow.minimize()}
          className="h-full px-3 hover:bg-white/10 text-zinc-400 hover:text-zinc-200 transition-colors flex items-center justify-center"
          title="Réduire"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => appWindow.toggleMaximize()}
          className="h-full px-3 hover:bg-white/10 text-zinc-400 hover:text-zinc-200 transition-colors flex items-center justify-center"
          title="Agrandir"
        >
          <Square className="w-3 h-3" />
        </button>
        <button
          onClick={() => appWindow.close()}
          className="h-full px-3 hover:bg-red-600 hover:text-white text-zinc-400 transition-colors flex items-center justify-center"
          title="Fermer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
