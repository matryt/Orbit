import React from 'react';
import {
  Folder,
  FileText,
  FileCode,
  Image,
  Archive,
  Terminal,
  FileJson,
  FileSpreadsheet,
  File,
} from 'lucide-react';

interface FileIconProps {
  name: string;
  isDir: boolean;
  className?: string;
}

export const FileIcon: React.FC<FileIconProps> = ({ name, isDir, className = 'w-4 h-4' }) => {
  if (isDir) {
    return <Folder className={`${className} text-amber-400/90 fill-amber-400/20`} />;
  }

  const ext = name.split('.').pop()?.toLowerCase();

  switch (ext) {
    case 'json':
      return <FileJson className={`${className} text-yellow-400`} />;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'svg':
    case 'webp':
    case 'gif':
      return <Image className={`${className} text-purple-400`} />;
    case 'md':
    case 'txt':
    case 'log':
      return <FileText className={`${className} text-blue-400`} />;
    case 'sh':
    case 'bash':
    case 'zsh':
      return <Terminal className={`${className} text-emerald-400`} />;
    case 'js':
    case 'ts':
    case 'tsx':
    case 'jsx':
    case 'rs':
    case 'py':
    case 'conf':
    case 'env':
      return <FileCode className={`${className} text-cyan-400`} />;
    case 'zip':
    case 'tar':
    case 'gz':
    case 'tgz':
    case '7z':
      return <Archive className={`${className} text-orange-400`} />;
    case 'csv':
    case 'xlsx':
      return <FileSpreadsheet className={`${className} text-green-400`} />;
    default:
      return <File className={`${className} text-zinc-400`} />;
  }
};

