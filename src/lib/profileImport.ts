import type { ConnectionProfile, BastionConfig, ProxyConfig, SshAuthType, StorageType } from '../types/index.ts';

const MAX_HOST_LEN = 253;
const FORBIDDEN_HOST_CHARS = /[\s\x00-\x1f\x7f,#*?!\[\]@|\/\\;]/;

/**
 * Valide qu'un nom d'hôte SSH est sécurisé (conforme à `validate_ssh_host` côté Rust).
 * Rejette les caractères d'injection, les retours à la ligne, les espaces et les métacaractères.
 */
export function validateSshHostString(host: string): { valid: boolean; error?: string } {
  const trimmed = host.trim();
  if (!trimmed) {
    return { valid: false, error: "L'adresse de l'hôte est vide." };
  }
  if (trimmed.length > MAX_HOST_LEN) {
    return { valid: false, error: `L'adresse de l'hôte dépasse ${MAX_HOST_LEN} caractères.` };
  }
  if (FORBIDDEN_HOST_CHARS.test(trimmed)) {
    return { valid: false, error: "L'adresse de l'hôte contient un caractère interdit ou de contrôle." };
  }
  return { valid: true };
}

/**
 * Valide un endpoint S3 personnalisé contre les attaques SSRF (ex: AWS IMDSv1 169.254.169.254).
 */
export function validateS3EndpointUrl(endpoint: string | undefined): { valid: boolean; error?: string } {
  if (!endpoint || !endpoint.trim()) {
    return { valid: true };
  }
  const trimmed = endpoint.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: "Le protocole de l'endpoint S3 doit être http ou https." };
    }
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === '169.254.169.254' ||
      hostname === 'fd00:ec2::254' ||
      hostname === 'instance-data' ||
      hostname === 'metadata.google.internal'
    ) {
      return { valid: false, error: "L'endpoint cible une adresse de métadonnées d'instance interdite (SSRF)." };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "Format d'URL de l'endpoint S3 invalide." };
  }
}

/**
 * Vérifie qu'un ID de profil est sain et ne contient pas de ':' pour empêcher toute collision
 * avec les secrets de trousseau (`{id}:bastion` ou `{id}:proxy`).
 */
export function isSafeProfileId(id: string | undefined | null): boolean {
  if (!id || typeof id !== 'string') return false;
  return /^[a-zA-Z0-9_\-]+$/.test(id) && !id.includes(':');
}

/**
 * Valide qu'un numéro de port est un entier strict compris entre 1 et 65535.
 */
export function isValidPort(p: unknown): p is number {
  return typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65535;
}

/**
 * Génère un identifiant de profil sain sans collision possible.
 */
export function generateSafeProfileId(): string {
  const rand = Math.floor(Math.random() * 900000) + 100000;
  return `prof-${Date.now()}-${rand}`;
}

/**
 * Valide et assainit un profil importé (JSON ou converti).
 */
export function sanitizeImportedProfile(
  raw: any,
  existingIds: Set<string>
): { profile: ConnectionProfile | null; warnings: string[]; originalId?: string } {
  if (!raw || typeof raw !== 'object') {
    return { profile: null, warnings: ['Format de profil invalide (non-objet)'] };
  }

  const type: StorageType = raw.type === 's3' ? 's3' : 'sftp';
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Serveur importé';
  const warnings: string[] = [];

  // ID Validation & Collision Prevention
  const rawId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined;
  let id = rawId || '';
  if (!id || !isSafeProfileId(id) || existingIds.has(id)) {
    id = generateSafeProfileId();
  }

  const isFavorite = Boolean(raw.isFavorite ?? true);

  if (type === 'sftp') {
    const rawHost = typeof raw.host === 'string' ? raw.host : '';
    const hostCheck = validateSshHostString(rawHost);
    if (!hostCheck.valid) {
      warnings.push(`Profil '${name}' ignoré : ${hostCheck.error}`);
      return { profile: null, warnings, originalId: rawId };
    }

    const port = isValidPort(raw.port) ? raw.port : 22;
    const username = typeof raw.username === 'string' ? raw.username.trim() : undefined;
    const authType: SshAuthType | undefined =
      raw.authType === 'agent' || raw.authType === 'key' || raw.authType === 'password'
        ? raw.authType
        : undefined;
    const keyPath = typeof raw.keyPath === 'string' && raw.keyPath.trim() ? raw.keyPath.trim() : undefined;
    const agentSocket =
      typeof raw.agentSocket === 'string' && raw.agentSocket.trim() ? raw.agentSocket.trim() : undefined;
    const useSudo = raw.useSudo === true;

    let bastion: BastionConfig | undefined = undefined;
    if (raw.bastion && typeof raw.bastion === 'object' && raw.bastion.enabled) {
      const bHost = typeof raw.bastion.host === 'string' ? raw.bastion.host.trim() : undefined;
      const bPid = typeof raw.bastion.profileId === 'string' ? raw.bastion.profileId.trim() : undefined;
      const bAuthType: SshAuthType | undefined =
        raw.bastion.authType === 'agent' || raw.bastion.authType === 'key' || raw.bastion.authType === 'password'
          ? raw.bastion.authType
          : undefined;

      if (bHost) {
        const bHostCheck = validateSshHostString(bHost);
        if (!bHostCheck.valid) {
          warnings.push(`Bastion du profil '${name}' ignoré : ${bHostCheck.error}`);
        } else {
          bastion = {
            enabled: true,
            profileId: bPid || undefined,
            host: bHost,
            port: isValidPort(raw.bastion.port) ? raw.bastion.port : 22,
            username: typeof raw.bastion.username === 'string' ? raw.bastion.username.trim() : undefined,
            authType: bAuthType,
            keyPath: typeof raw.bastion.keyPath === 'string' ? raw.bastion.keyPath.trim() : undefined,
            agentSocket: typeof raw.bastion.agentSocket === 'string' ? raw.bastion.agentSocket.trim() : undefined,
          };
        }
      } else if (bPid) {
        bastion = {
          enabled: true,
          profileId: bPid,
        };
      }
    }

    let proxy: ProxyConfig | undefined = undefined;
    if (raw.proxy && typeof raw.proxy === 'object' && raw.proxy.enabled) {
      const pHost = typeof raw.proxy.host === 'string' ? raw.proxy.host.trim() : '';
      if (pHost) {
        proxy = {
          enabled: true,
          proxyType: raw.proxy.proxyType === 'http' ? 'http' : 'socks5',
          host: pHost,
          port: isValidPort(raw.proxy.port) ? raw.proxy.port : 1080,
          username: typeof raw.proxy.username === 'string' ? raw.proxy.username.trim() : undefined,
        };
      }
    }

    const profile: ConnectionProfile = {
      id,
      name,
      type: 'sftp',
      host: rawHost,
      port,
      username,
      authType,
      keyPath,
      agentSocket,
      isFavorite,
      status: 'idle',
      useSudo,
      bastion,
      proxy,
    };

    return { profile, warnings, originalId: rawId };
  } else {
    // S3 Profile
    const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim() : undefined;
    const epCheck = validateS3EndpointUrl(endpoint);
    if (!epCheck.valid) {
      warnings.push(`Profil S3 '${name}' ignoré : ${epCheck.error}`);
      return { profile: null, warnings, originalId: rawId };
    }

    const bucket = typeof raw.bucket === 'string' ? raw.bucket.trim() : '';
    const region = typeof raw.region === 'string' ? raw.region.trim() : undefined;
    const accessKey = typeof raw.accessKey === 'string' ? raw.accessKey.trim() : undefined;

    const profile: ConnectionProfile = {
      id,
      name,
      type: 's3',
      endpoint,
      bucket,
      region,
      accessKey,
      isFavorite,
      status: 'idle',
    };

    return { profile, warnings, originalId: rawId };
  }
}

/**
 * Analyse et valide une chaîne JSON contenant une liste de profils Orbit.
 */
export function parseAndValidateProfilesJson(
  jsonContent: string,
  existingProfiles: ConnectionProfile[]
): { profiles: ConnectionProfile[]; warnings: string[] } {
  const existingIds = new Set(existingProfiles.map((p) => p.id));
  const warnings: string[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonContent);
  } catch (err: any) {
    return {
      profiles: [],
      warnings: [`Erreur de syntaxe JSON : ${err.message || 'JSON invalide'}`],
    };
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  const validProfiles: ConnectionProfile[] = [];
  const idMapping = new Map<string, string>();

  for (const item of items) {
    const res = sanitizeImportedProfile(item, existingIds);
    if (res) {
      warnings.push(...res.warnings);
      if (res.profile) {
        if (res.originalId && res.originalId !== res.profile.id) {
          idMapping.set(res.originalId, res.profile.id);
        }
        validProfiles.push(res.profile);
        existingIds.add(res.profile.id);
      }
    }
  }

  // Remap bastion.profileId if the referenced ID was changed/regenerated in this batch
  for (const profile of validProfiles) {
    if (profile.bastion?.profileId) {
      if (idMapping.has(profile.bastion.profileId)) {
        profile.bastion.profileId = idMapping.get(profile.bastion.profileId);
      }
      // If the referenced profileId is still not safe, strip it
      if (!isSafeProfileId(profile.bastion.profileId)) {
        profile.bastion.profileId = undefined;
      }
    }
  }

  return { profiles: validProfiles, warnings };
}
