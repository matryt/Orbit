import React, { useState, useEffect, useRef } from 'react';
import { useOrbitStore } from '../../store/useOrbitStore';
import {
  Plus,
  Download,
  Server,
  Cloud,
  ShieldCheck,
  Loader2,
  Trash2,
  MoreVertical,
  Power,
  Play,
  Pencil,
} from 'lucide-react';

export const Sidebar: React.FC = () => {
  const {
    profiles,
    activeProfileId,
    setActiveProfile,
    deleteProfile,
    disconnectProfile,
    connectProfile,
    setEditingProfile,
    setNewConnectionModalOpen,
    setExportModalOpen,
    isConnecting,
  } = useOrbitStore();

  const [menuOpenProfileId, setMenuOpenProfileId] = useState<string | null>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);

  // Close context menu on outside click or Escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(e.target as Node)) {
        setMenuOpenProfileId(null);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpenProfileId(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <aside className="w-60 min-w-[240px] max-w-[240px] h-full flex flex-col bg-surface/80 backdrop-blur-2xl border-r border-border-subtle select-none">
      {/* Top draggable titlebar area for macOS */}
      <div
        data-tauri-drag-region
        className="h-11 flex-shrink-0 flex items-center px-4"
      >
        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider pl-16">
          Orbit
        </span>
      </div>

      {/* Profiles list header */}
      <div className="px-3 pt-2 pb-1 flex items-center justify-between">
        <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
          Connexions
        </span>
        <button
          onClick={() => setNewConnectionModalOpen(true)}
          className="p-1 rounded hover:bg-white/10 text-zinc-400 hover:text-zinc-200 transition-colors"
          title="Nouvelle connexion"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Profiles list */}
      <div ref={menuContainerRef} className="flex-1 overflow-y-auto px-2 space-y-0.5 relative">
        {profiles.length === 0 ? (
          <div className="h-44 flex flex-col items-center justify-center text-center px-3 py-6">
            <div className="w-10 h-10 rounded-full bg-white/5 border border-border-subtle flex items-center justify-center mb-2.5">
              <Server className="w-5 h-5 text-zinc-500" />
            </div>
            <p className="text-xs font-medium text-zinc-300">Aucune connexion</p>
            <p className="text-[11px] text-zinc-500 mt-1 mb-3 leading-relaxed">
              Ajoutez votre premier serveur SFTP ou bucket S3.
            </p>
            <button
              onClick={() => setNewConnectionModalOpen(true)}
              className="px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium shadow-sm transition-all flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Ajouter</span>
            </button>
          </div>
        ) : (
          profiles.map((profile) => {
            const isActive = profile.id === activeProfileId;
            const isThisConnecting = isActive && isConnecting;
            const isMenuOpen = menuOpenProfileId === profile.id;

            return (
              <div key={profile.id} className="relative">
                <div
                  onClick={() => setActiveProfile(profile.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenuOpenProfileId(isMenuOpen ? null : profile.id);
                  }}
                  className={`w-full group px-2.5 py-2 rounded-md flex items-center justify-between text-xs cursor-pointer transition-all ${
                    isActive
                      ? 'bg-surface-active text-white font-medium shadow-sm border border-border-light'
                      : 'text-zinc-400 hover:bg-surface-hover hover:text-zinc-200'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    {profile.type === 's3' ? (
                      <Cloud
                        className={`w-4 h-4 flex-shrink-0 ${
                          isActive ? 'text-amber-400' : 'text-zinc-500 group-hover:text-amber-400/80'
                        }`}
                      />
                    ) : (
                      <Server
                        className={`w-4 h-4 flex-shrink-0 ${
                          isActive ? 'text-sky-400' : 'text-zinc-500 group-hover:text-sky-400/80'
                        }`}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate leading-tight">{profile.name}</div>
                      <div className="text-[10px] text-zinc-500 truncate mt-0.5 font-mono">
                        {profile.bucket || profile.host || 'orbit-storage'}
                      </div>
                    </div>
                  </div>

                  {/* Protocol badge & Status indicator & Options menu button */}
                  <div className="flex items-center gap-1 flex-shrink-0 ml-1.5">
                    <span
                      className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-semibold uppercase tracking-wider ${
                        profile.type === 's3'
                          ? 'bg-amber-500/10 text-amber-400/90 border border-amber-500/20'
                          : 'bg-sky-500/10 text-sky-400/90 border border-sky-500/20'
                      }`}
                    >
                      {profile.type}
                    </span>

                    {isThisConnecting ? (
                      <Loader2 className="w-2.5 h-2.5 animate-spin text-sky-400" />
                    ) : profile.status === 'connected' ? (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
                    ) : profile.status === 'error' ? (
                      <span className="w-1.5 h-1.5 rounded-full bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.8)]" />
                    ) : null}

                    {/* 3-dots action button */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpenProfileId(isMenuOpen ? null : profile.id);
                      }}
                      className={`p-1 rounded hover:bg-white/10 text-zinc-400 hover:text-white transition-all ${
                        isMenuOpen ? 'opacity-100 bg-white/10 text-white' : 'opacity-0 group-hover:opacity-100'
                      }`}
                      title="Options de la connexion"
                    >
                      <MoreVertical className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Dropdown context menu */}
                {isMenuOpen && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-1 top-full mt-1 z-50 w-48 bg-[#141722] border border-border-light rounded-lg shadow-2xl py-1 text-xs text-zinc-300 animate-in fade-in duration-100"
                  >
                    {profile.status === 'connected' ? (
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpenProfileId(null);
                          disconnectProfile(profile.id);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/10 text-amber-300 transition-colors"
                      >
                        <Power className="w-3.5 h-3.5 text-amber-400" />
                        <span>Déconnecter</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpenProfileId(null);
                          connectProfile(profile.id);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/10 text-emerald-300 transition-colors"
                      >
                        <Play className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Connecter</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpenProfileId(null);
                        setEditingProfile(profile);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/10 hover:text-white transition-colors"
                    >
                      <Pencil className="w-3.5 h-3.5 text-sky-400" />
                      <span>Modifier...</span>
                    </button>

                    <div className="my-1 border-t border-border-subtle" />

                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpenProfileId(null);
                        if (window.confirm(`Supprimer la connexion "${profile.name}" ?`)) {
                          deleteProfile(profile.id);
                        }
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-red-500/10 text-red-400 hover:text-red-300 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-red-400" />
                      <span>Supprimer</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Bottom actions */}
      <div className="p-3 border-t border-border-subtle bg-surface-muted/50 flex flex-col gap-1.5">
        <button
          onClick={() => setNewConnectionModalOpen(true)}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md bg-white/[0.06] hover:bg-white/[0.1] text-xs font-medium text-zinc-200 hover:text-white border border-border-subtle transition-all"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Nouvelle connexion</span>
        </button>

        <div className="flex items-center gap-1 pt-1">
          <button
            onClick={() => setExportModalOpen(true)}
            className="flex-1 flex items-center justify-center gap-1 py-1 px-2 rounded text-[11px] text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors"
            title="Exporter les profils au format JSON"
          >
            <Download className="w-3 h-3" />
            <span>Exporter profils</span>
          </button>
          <div className="flex items-center text-[10px] text-zinc-600 px-1" title="Trousseau OS activé">
            <ShieldCheck className="w-3.5 h-3.5 text-zinc-500" />
          </div>
        </div>
      </div>
    </aside>
  );
};
