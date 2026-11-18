import { ConnectionProfile, FileEntry } from '../types';

export const MOCK_PROFILES: ConnectionProfile[] = [];

export const MOCK_REMOTE_FILES: Record<string, FileEntry[]> = {
  '/': [],
};

export const MOCK_LOCAL_FILES: FileEntry[] = [
  { name: 'Documents', path: '/Users/mac/Documents', is_dir: true, size: 0, modified_at: '2026-11-13T10:00:00Z' },
  { name: 'Downloads', path: '/Users/mac/Downloads', is_dir: true, size: 0, modified_at: '2026-11-13T19:10:00Z' },
  { name: 'Projects', path: '/Users/mac/Projects', is_dir: true, size: 0, modified_at: '2026-11-13T15:20:00Z' },
  { name: 'archive-v2.tar.gz', path: '/Users/mac/archive-v2.tar.gz', is_dir: false, size: 148500200, modified_at: '2026-11-12T18:00:00Z' },
  { name: 'export-data.csv', path: '/Users/mac/export-data.csv', is_dir: false, size: 684200, modified_at: '2026-11-13T14:40:00Z' },
  { name: 'screenshot-2026.png', path: '/Users/mac/screenshot-2026.png', is_dir: false, size: 840500, modified_at: '2026-11-13T19:05:00Z' },
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

