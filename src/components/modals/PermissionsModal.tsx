import React, { useEffect, useState, useRef, useMemo } from 'react';
import { FileEntry } from '../../types';
import {
  bitsToMode,
  modeToBits,
  modeToOctal,
  octalToMode,
  modeToSymbolic,
  parsePermissionsString,
  PermissionMatrix,
} from '../../lib/permissions';
import { storageApi } from '../../services/storageApi';
import { KeyRound, X, AlertTriangle, Loader2, Folder, FileText, ChevronDown, Check } from 'lucide-react';

interface ComboboxSelectProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
}

const ComboboxSelect: React.FC<ComboboxSelectProps> = ({
  id,
  value,
  onChange,
  options,
  placeholder,
  disabled,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredOptions = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return options;
    return options.filter((opt) => opt.toLowerCase().includes(q));
  }, [options, value]);

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="relative flex items-center">
        <input
          id={id}
          type="text"
          value={value}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value);
            if (!isOpen) setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          list={`${id}-datalist`}
          placeholder={placeholder}
          className="w-full pl-3 pr-8 py-1.5 rounded-lg bg-surface-muted border border-white/10 text-xs text-white placeholder-zinc-500 font-mono focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors disabled:opacity-50"
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          onClick={() => setIsOpen(!isOpen)}
          className="absolute right-1.5 p-1 rounded hover:bg-white/10 text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
          title="Afficher les suggestions"
        >
          <ChevronDown
            className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180 text-white' : ''}`}
          />
        </button>
      </div>

      <datalist id={`${id}-datalist`}>
        {options.map((opt) => (
          <option key={opt} value={opt} />
        ))}
      </datalist>

      {isOpen && filteredOptions.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full max-h-40 overflow-y-auto rounded-lg bg-[#141722]/95 backdrop-blur-xl border border-white/10 shadow-2xl py-1 text-xs select-none">
          {filteredOptions.map((opt) => (
            <li
              key={opt}
              onClick={() => {
                onChange(opt);
                setIsOpen(false);
              }}
              className={`px-3 py-1.5 flex items-center justify-between font-mono cursor-pointer transition-colors ${
                opt === value
                  ? 'bg-indigo-600/20 text-indigo-300 font-semibold'
                  : 'text-zinc-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              <span>{opt}</span>
              {opt === value && <Check className="w-3.5 h-3.5 text-indigo-400" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

interface PermissionsModalProps {
  file: FileEntry | null;
  isOpen: boolean;
  isLocal?: boolean;
  profileId?: string;
  directoryFiles?: FileEntry[];
  onClose: () => void;
  onSave: (
    mode: number,
    owner: string | null,
    group: string | null,
    recursive: boolean
  ) => Promise<void>;
}

export const PermissionsModal: React.FC<PermissionsModalProps> = ({
  file,
  isOpen,
  isLocal = false,
  profileId,
  directoryFiles = [],
  onClose,
  onSave,
}) => {
  const [matrix, setMatrix] = useState<PermissionMatrix>(() =>
    modeToBits(parsePermissionsString(file?.permissions, file?.is_dir))
  );
  const [octalInput, setOctalInput] = useState<string>(() =>
    modeToOctal(parsePermissionsString(file?.permissions, file?.is_dir))
  );
  const [ownerInput, setOwnerInput] = useState<string>(file?.owner || '');
  const [groupInput, setGroupInput] = useState<string>(file?.group || '');
  const [userOptions, setUserOptions] = useState<string[]>([]);
  const [groupOptions, setGroupOptions] = useState<string[]>([]);
  const [octalError, setOctalError] = useState<boolean>(false);
  const [recursive, setRecursive] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (file && isOpen) {
      const initialMode = parsePermissionsString(file.permissions, file.is_dir);
      setMatrix(modeToBits(initialMode));
      setOctalInput(modeToOctal(initialMode));
      setOwnerInput(file.owner || '');
      setGroupInput(file.group || '');
      setOctalError(false);
      setRecursive(false);
      setIsSubmitting(false);
      setSubmitError(null);

      // Extract existing users and groups from the current directory
      const initialUsers = Array.from(
        new Set(
          directoryFiles
            .map((f) => f.owner)
            .filter((o): o is string => Boolean(o && o.trim()))
        )
      );
      if (file.owner && !initialUsers.includes(file.owner)) {
        initialUsers.push(file.owner);
      }

      const initialGroups = Array.from(
        new Set(
          directoryFiles
            .map((f) => f.group)
            .filter((g): g is string => Boolean(g && g.trim()))
        )
      );
      if (file.group && !initialGroups.includes(file.group)) {
        initialGroups.push(file.group);
      }

      setUserOptions(initialUsers.sort());
      setGroupOptions(initialGroups.sort());

      // Fetch full system user/group lists
      const req = isLocal
        ? storageApi.listLocalIdentities()
        : storageApi.listIdentities(profileId);

      req
        .then((res) => {
          const mergedUsers = Array.from(new Set([...initialUsers, ...res.users])).sort();
          const mergedGroups = Array.from(new Set([...initialGroups, ...res.groups])).sort();
          setUserOptions(mergedUsers);
          setGroupOptions(mergedGroups);
        })
        .catch(() => {
          // Keep whatever was found in directoryFiles
        });
    }
  }, [file, isOpen, isLocal, profileId, directoryFiles]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape' && !isSubmitting) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSubmitting, onClose]);

  if (!isOpen || !file) return null;

  const currentMode = bitsToMode(matrix);
  const symbolic = modeToSymbolic(currentMode, file.is_dir);

  const handleCheckboxChange = (
    category: 'user' | 'group' | 'others',
    permission: 'read' | 'write' | 'execute'
  ) => {
    const updated: PermissionMatrix = {
      ...matrix,
      [category]: {
        ...matrix[category],
        [permission]: !matrix[category][permission],
      },
    };
    setMatrix(updated);
    const newMode = bitsToMode(updated);
    setOctalInput(modeToOctal(newMode));
    setOctalError(false);
  };

  const handleOctalChange = (value: string) => {
    setOctalInput(value);
    const parsed = octalToMode(value);
    if (parsed !== null) {
      setMatrix(modeToBits(parsed));
      setOctalError(false);
    } else {
      setOctalError(true);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (octalError || isSubmitting) return;

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const owner = ownerInput.trim();
      const group = groupInput.trim();
      await onSave(
        currentMode,
        owner || null,
        group || null,
        file.is_dir && recursive
      );
      onClose();
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : err?.message || JSON.stringify(err);
      setSubmitError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-[#161926] border border-white/10 rounded-xl shadow-2xl overflow-hidden flex flex-col text-zinc-200"
      >
        {/* Header */}
        <div className="h-14 px-5 border-b border-border-subtle flex items-center justify-between bg-surface-muted/60 select-none flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 flex-shrink-0">
              <KeyRound className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-white truncate">Permissions et droits</h3>
              <p className="text-[11px] text-zinc-400 truncate max-w-[280px]">
                {file.name}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="p-1.5 rounded-md hover:bg-white/10 text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {submitError && (
            <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>{submitError}</span>
            </div>
          )}

          {/* Item Meta Bar */}
          <div className="flex items-center justify-between p-2.5 rounded-lg bg-white/5 border border-white/5 text-xs">
            <div className="flex items-center gap-2 min-w-0">
              {file.is_dir ? (
                <Folder className="w-4 h-4 text-indigo-400 flex-shrink-0" />
              ) : (
                <FileText className="w-4 h-4 text-zinc-400 flex-shrink-0" />
              )}
              <span className="font-medium text-white truncate max-w-[200px]" title={file.path}>
                {file.name}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-zinc-400 font-mono">
              {file.owner && <span>u: {file.owner}</span>}
              {file.group && <span>g: {file.group}</span>}
            </div>
          </div>

          {/* Matrix Checkboxes */}
          <div className="border border-white/10 rounded-lg overflow-hidden bg-black/20">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="border-b border-white/10 bg-white/5 text-zinc-400 text-[11px]">
                  <th className="py-2 px-3 font-medium">Classe</th>
                  <th className="py-2 px-3 text-center font-medium">Lecture (r)</th>
                  <th className="py-2 px-3 text-center font-medium">Écriture (w)</th>
                  <th className="py-2 px-3 text-center font-medium">Exécution (x)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {/* Propriétaire */}
                <tr>
                  <td className="py-2 px-3 font-medium text-zinc-300">
                    Propriétaire
                    <span className="text-[10px] text-zinc-500 block font-mono">user</span>
                  </td>
                  <td className="py-2 px-3 text-center">
                    <input
                      type="checkbox"
                      checked={matrix.user.read}
                      onChange={() => handleCheckboxChange('user', 'read')}
                      className="rounded border-zinc-700 bg-surface-muted text-indigo-500 focus:ring-indigo-500/20 focus:ring-offset-0 cursor-pointer"
                    />
                  </td>
                  <td className="py-2 px-3 text-center">
                    <input
                      type="checkbox"
                      checked={matrix.user.write}
                      onChange={() => handleCheckboxChange('user', 'write')}
                      className="rounded border-zinc-700 bg-surface-muted text-indigo-500 focus:ring-indigo-500/20 focus:ring-offset-0 cursor-pointer"
                    />
                  </td>
                  <td className="py-2 px-3 text-center">
                    <input
                      type="checkbox"
                      checked={matrix.user.execute}
                      onChange={() => handleCheckboxChange('user', 'execute')}
                      className="rounded border-zinc-700 bg-surface-muted text-indigo-500 focus:ring-indigo-500/20 focus:ring-offset-0 cursor-pointer"
                    />
                  </td>
                </tr>

                {/* Groupe */}
                <tr>
                  <td className="py-2 px-3 font-medium text-zinc-300">
                    Groupe
                    <span className="text-[10px] text-zinc-500 block font-mono">group</span>
                  </td>
                  <td className="py-2 px-3 text-center">
                    <input
                      type="checkbox"
                      checked={matrix.group.read}
                      onChange={() => handleCheckboxChange('group', 'read')}
                      className="rounded border-zinc-700 bg-surface-muted text-indigo-500 focus:ring-indigo-500/20 focus:ring-offset-0 cursor-pointer"
                    />
                  </td>
                  <td className="py-2 px-3 text-center">
                    <input
                      type="checkbox"
                      checked={matrix.group.write}
                      onChange={() => handleCheckboxChange('group', 'write')}
                      className="rounded border-zinc-700 bg-surface-muted text-indigo-500 focus:ring-indigo-500/20 focus:ring-offset-0 cursor-pointer"
                    />
                  </td>
                  <td className="py-2 px-3 text-center">
                    <input
                      type="checkbox"
                      checked={matrix.group.execute}
                      onChange={() => handleCheckboxChange('group', 'execute')}
                      className="rounded border-zinc-700 bg-surface-muted text-indigo-500 focus:ring-indigo-500/20 focus:ring-offset-0 cursor-pointer"
                    />
                  </td>
                </tr>

                {/* Autres / Public */}
                <tr>
                  <td className="py-2 px-3 font-medium text-zinc-300">
                    Autres
                    <span className="text-[10px] text-zinc-500 block font-mono">others</span>
                  </td>
                  <td className="py-2 px-3 text-center">
                    <input
                      type="checkbox"
                      checked={matrix.others.read}
                      onChange={() => handleCheckboxChange('others', 'read')}
                      className="rounded border-zinc-700 bg-surface-muted text-indigo-500 focus:ring-indigo-500/20 focus:ring-offset-0 cursor-pointer"
                    />
                  </td>
                  <td className="py-2 px-3 text-center">
                    <input
                      type="checkbox"
                      checked={matrix.others.write}
                      onChange={() => handleCheckboxChange('others', 'write')}
                      className="rounded border-zinc-700 bg-surface-muted text-indigo-500 focus:ring-indigo-500/20 focus:ring-offset-0 cursor-pointer"
                    />
                  </td>
                  <td className="py-2 px-3 text-center">
                    <input
                      type="checkbox"
                      checked={matrix.others.execute}
                      onChange={() => handleCheckboxChange('others', 'execute')}
                      className="rounded border-zinc-700 bg-surface-muted text-indigo-500 focus:ring-indigo-500/20 focus:ring-offset-0 cursor-pointer"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Octal & Symbolic values */}
          <div className="grid grid-cols-2 gap-3 items-center">
            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                Valeur octale
              </label>
              <input
                type="text"
                value={octalInput}
                onChange={(e) => handleOctalChange(e.target.value)}
                maxLength={4}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className={`w-full px-3 py-1.5 rounded-lg bg-surface-muted border text-xs text-white font-mono focus:outline-none transition-colors ${
                  octalError
                    ? 'border-red-500 focus:border-red-500'
                    : 'border-white/10 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500'
                }`}
                placeholder="0755"
              />
              {octalError && (
                <span className="text-[10px] text-red-400 mt-0.5 block">Format invalide (ex: 0755, 644)</span>
              )}
            </div>

            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                Notation symbolique
              </label>
              <div className="px-3 py-1.5 rounded-lg bg-surface-muted border border-white/10 text-xs font-mono text-zinc-300 select-all">
                {symbolic}
              </div>
            </div>
          </div>

          {/* Owner & Group Editable Comboboxes */}
          <div className="grid grid-cols-2 gap-3 items-start">
            <div>
              <label htmlFor="owner-combobox" className="block text-[11px] font-medium text-zinc-400 mb-1">
                propriétaire (UID ou nom)
              </label>
              <ComboboxSelect
                id="owner-combobox"
                value={ownerInput}
                onChange={setOwnerInput}
                options={userOptions}
                placeholder="ex: root, 1000"
                disabled={isSubmitting}
              />
            </div>

            <div>
              <label htmlFor="group-combobox" className="block text-[11px] font-medium text-zinc-400 mb-1">
                groupe (GID ou nom)
              </label>
              <ComboboxSelect
                id="group-combobox"
                value={groupInput}
                onChange={setGroupInput}
                options={groupOptions}
                placeholder="ex: staff, 1000"
                disabled={isSubmitting}
              />
            </div>
          </div>

          {/* Recursive Option for Directories */}
          {file.is_dir && (
            <div className="pt-1">
              <label className="flex items-start gap-2 p-2 rounded-lg bg-white/5 border border-white/5 cursor-pointer hover:bg-white/[0.07] transition-colors">
                <input
                  type="checkbox"
                  checked={recursive}
                  onChange={(e) => setRecursive(e.target.checked)}
                  className="rounded border-zinc-700 bg-surface-muted text-indigo-500 focus:ring-indigo-500/20 focus:ring-offset-0 cursor-pointer mt-0.5"
                />
                <div className="text-xs">
                  <span className="font-medium text-white block">
                    Appliquer récursivement
                  </span>
                  <span className="text-[11px] text-zinc-400 block mt-0.5">
                    Modifie également les permissions et propriétaires des sous-dossiers et fichiers contenus.
                  </span>
                </div>
              </label>
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/10">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-3 py-1.5 rounded-md hover:bg-white/10 text-xs text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={isSubmitting || octalError}
              className="px-4 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              {isSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>Appliquer</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
