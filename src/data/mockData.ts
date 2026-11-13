import { ConnectionProfile, FileEntry, TransferItem } from '../types';

export const MOCK_PROFILES: ConnectionProfile[] = [
  {
    id: 'prof-1',
    name: 'AWS S3 Production',
    type: 's3',
    bucket: 'orbit-production-assets',
    region: 'eu-west-3',
    status: 'connected',
    isFavorite: true,
  },
  {
    id: 'prof-2',
    name: 'Cloudflare R2 (CDN)',
    type: 's3',
    endpoint: 'https://c3f...r2.cloudflarestorage.com',
    bucket: 'cdn-images',
    status: 'idle',
    isFavorite: true,
  },
  {
    id: 'prof-3',
    name: 'Hetzner Web Server',
    type: 'sftp',
    host: 'node1.infra.cloud',
    port: 22,
    username: 'deploy',
    status: 'idle',
    isFavorite: true,
  },
  {
    id: 'prof-4',
    name: 'Scaleway MinIO (Backups)',
    type: 's3',
    endpoint: 'https://s3.fr-par.scw.cloud',
    bucket: 'nightly-archives',
    region: 'fr-par',
    status: 'idle',
    isFavorite: false,
  },
];

export const MOCK_REMOTE_FILES: Record<string, FileEntry[]> = {
  '/': [
    { name: 'backup', path: '/backup', is_dir: true, size: 0, modified_at: '2026-11-10T14:30:00Z' },
    { name: 'configs', path: '/configs', is_dir: true, size: 0, modified_at: '2026-11-12T09:15:00Z' },
    { name: 'images', path: '/images', is_dir: true, size: 0, modified_at: '2026-11-13T16:00:00Z' },
    { name: 'app-config.json', path: '/app-config.json', is_dir: false, size: 4520, modified_at: '2026-11-13T18:45:00Z', permissions: 'rw-r--r--' },
    { name: 'deploy.sh', path: '/deploy.sh', is_dir: false, size: 1240, modified_at: '2026-11-09T11:20:00Z', permissions: 'rwxr-xr-x' },
    { name: 'README.md', path: '/README.md', is_dir: false, size: 3412, modified_at: '2026-11-12T20:10:00Z', permissions: 'rw-r--r--' },
    { name: 'access.log', path: '/access.log', is_dir: false, size: 284050, modified_at: '2026-11-13T19:20:00Z', permissions: 'rw-r--r--' },
    { name: 'logo-dark.png', path: '/logo-dark.png', is_dir: false, size: 52410, modified_at: '2026-11-11T13:40:00Z', permissions: 'rw-r--r--' },
  ],
  '/images': [
    { name: 'hero-banner.jpg', path: '/images/hero-banner.jpg', is_dir: false, size: 1420500, modified_at: '2026-11-12T10:00:00Z', permissions: 'rw-r--r--' },
    { name: 'avatar-user.png', path: '/images/avatar-user.png', is_dir: false, size: 84200, modified_at: '2026-11-13T08:30:00Z', permissions: 'rw-r--r--' },
    { name: 'icon-symbol.svg', path: '/images/icon-symbol.svg', is_dir: false, size: 12400, modified_at: '2026-11-08T15:00:00Z', permissions: 'rw-r--r--' },
  ],
  '/configs': [
    { name: 'production.env', path: '/configs/production.env', is_dir: false, size: 890, modified_at: '2026-11-10T12:00:00Z', permissions: 'rw-------' },
    { name: 'nginx.conf', path: '/configs/nginx.conf', is_dir: false, size: 2150, modified_at: '2026-11-11T17:25:00Z', permissions: 'rw-r--r--' },
  ],
};

export const MOCK_LOCAL_FILES: FileEntry[] = [
  { name: 'Documents', path: '/Users/mac/Documents', is_dir: true, size: 0, modified_at: '2026-11-13T10:00:00Z' },
  { name: 'Downloads', path: '/Users/mac/Downloads', is_dir: true, size: 0, modified_at: '2026-11-13T19:10:00Z' },
  { name: 'Projects', path: '/Users/mac/Projects', is_dir: true, size: 0, modified_at: '2026-11-13T15:20:00Z' },
  { name: 'archive-v2.tar.gz', path: '/Users/mac/archive-v2.tar.gz', is_dir: false, size: 148500200, modified_at: '2026-11-12T18:00:00Z' },
  { name: 'export-data.csv', path: '/Users/mac/export-data.csv', is_dir: false, size: 684200, modified_at: '2026-11-13T14:40:00Z' },
  { name: 'screenshot-2026.png', path: '/Users/mac/screenshot-2026.png', is_dir: false, size: 840500, modified_at: '2026-11-13T19:05:00Z' },
];

export const MOCK_TRANSFERS: TransferItem[] = [
  {
    id: 'tx-1',
    serverName: 'AWS S3 Production',
    serverType: 's3',
    fileName: 'archive-v2.tar.gz',
    remotePath: '/backup/archive-v2.tar.gz',
    localPath: '/Users/mac/archive-v2.tar.gz',
    direction: 'upload',
    bytesTransferred: 98500000,
    totalBytes: 148500200,
    speedBps: 28400000,
    status: 'transferring',
  },
  {
    id: 'tx-2',
    serverName: 'Cloudflare R2 (CDN)',
    serverType: 's3',
    fileName: 'hero-banner.jpg',
    remotePath: '/images/hero-banner.jpg',
    localPath: '/Users/mac/Downloads/hero-banner.jpg',
    direction: 'download',
    bytesTransferred: 1420500,
    totalBytes: 1420500,
    speedBps: 0,
    status: 'completed',
  },
];

export const MOCK_PREVIEWS: Record<string, string> = {
  '/app-config.json': JSON.stringify({
    appName: "Orbit Cloud Service",
    version: "2.4.0",
    cluster: "eu-west-3-prod",
    s3Bucket: "orbit-production-assets",
    features: {
      multipartUpload: true,
      concurrency: 8,
      compression: "gzip",
      encryption: "AES-256"
    },
    retries: 3,
    timeoutMs: 15000
  }, null, 2),
  '/README.md': `# Orbit Storage Documentation

Orbit est une application desktop ultra-rapide conçue pour gérer vos fichiers distants S3 et serveurs SFTP avec une esthétique native soignée.

## Fonctionnalités
- Support complet AWS S3, Cloudflare R2, Scaleway et MinIO
- SFTP 100% Rust sans dépendance externe
- Trousseau sécurisé macOS Keychain & Windows Credential Manager
- Navigation fluide et Quick Look natif (Espace)
`,
  '/deploy.sh': `#!/usr/bin/env bash
set -euo pipefail

echo "🚀 Déploiement de la version 2.4.0..."
export AWS_REGION="eu-west-3"
aws s3 sync ./dist s3://orbit-production-assets/ --delete

echo "✨ Déploiement terminé avec succès !"
`,
  '/access.log': `[2026-11-13 19:20:01] GET /api/v1/health HTTP/1.1 - 200 OK (2ms)
[2026-11-13 19:20:03] POST /api/v1/sync HTTP/1.1 - 200 OK (45ms)
[2026-11-13 19:20:08] GET /images/avatar-user.png HTTP/1.1 - 304 Not Modified (1ms)
[2026-11-13 19:20:15] GET /app-config.json HTTP/1.1 - 200 OK (3ms)
[2026-11-13 19:20:22] GET /configs/nginx.conf HTTP/1.1 - 200 OK (4ms)
`
};

