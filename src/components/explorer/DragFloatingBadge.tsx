import React from 'react';
import { useOrbitStore } from '../../store/useOrbitStore';
import { FileIcon } from './FileIcon';

export const DragFloatingBadge: React.FC = () => {
  const activeDrag = useOrbitStore((s) => s.activeDrag);
  if (!activeDrag || !activeDrag.isDragging || activeDrag.files.length === 0) return null;

  const count = activeDrag.files.length;
  const firstFile = activeDrag.files[0];

  return (
    <div
      className="fixed pointer-events-none z-50 flex items-center gap-2.5 px-3 py-1.5 rounded-lg bg-[#141722]/95 border border-indigo-500/60 shadow-2xl text-white text-xs font-medium backdrop-blur-md select-none animate-in fade-in zoom-in-95 duration-75"
      style={{
        left: activeDrag.currentX + 14,
        top: activeDrag.currentY + 14,
      }}
    >
      <FileIcon name={firstFile.name} isDir={firstFile.is_dir} />
      <span className="truncate max-w-[170px] font-mono text-[11px] text-zinc-200">
        {firstFile.name}
      </span>
      {count > 1 && (
        <span className="px-1.5 py-0.5 rounded-full bg-indigo-600 text-indigo-100 text-[10px] font-bold shadow-sm">
          +{count - 1}
        </span>
      )}
    </div>
  );
};
