import type { ConnectionProfile } from '../types/index.ts';

/**
 * Nettoie un profil de connexion avant l'exportation JSON via une liste blanche stricte
 * afin d'exclure tous les secrets (mots de passe, phrases secrètes, clés secrètes S3)
 * et tout champ inattendu injecté.
 */
export function sanitizeProfileForExport(profile: ConnectionProfile): Partial<ConnectionProfile> {
  const exported: Partial<ConnectionProfile> = {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    isFavorite: Boolean(profile.isFavorite),
  };

  if (profile.type === 's3') {
    if (profile.endpoint) exported.endpoint = profile.endpoint;
    if (profile.bucket) exported.bucket = profile.bucket;
    if (profile.region) exported.region = profile.region;
    if (profile.accessKey) exported.accessKey = profile.accessKey;
  } else if (profile.type === 'sftp') {
    if (profile.host) exported.host = profile.host;
    if (profile.port) exported.port = profile.port;
    if (profile.username) exported.username = profile.username;
    if (profile.authType) exported.authType = profile.authType;
    if (profile.keyPath) exported.keyPath = profile.keyPath;
    if (profile.agentSocket) exported.agentSocket = profile.agentSocket;
    if (profile.useSudo !== undefined) exported.useSudo = profile.useSudo;
  }

  if (profile.bastion?.enabled) {
    exported.bastion = {
      enabled: true,
      ...(profile.bastion.profileId ? { profileId: profile.bastion.profileId } : {}),
      ...(profile.bastion.host ? { host: profile.bastion.host } : {}),
      ...(profile.bastion.port ? { port: profile.bastion.port } : {}),
      ...(profile.bastion.username ? { username: profile.bastion.username } : {}),
      ...(profile.bastion.authType ? { authType: profile.bastion.authType } : {}),
      ...(profile.bastion.keyPath ? { keyPath: profile.bastion.keyPath } : {}),
      ...(profile.bastion.agentSocket ? { agentSocket: profile.bastion.agentSocket } : {}),
    };
  }

  if (profile.proxy?.enabled) {
    exported.proxy = {
      enabled: true,
      ...(profile.proxy.proxyType ? { proxyType: profile.proxy.proxyType } : {}),
      ...(profile.proxy.host ? { host: profile.proxy.host } : {}),
      ...(profile.proxy.port ? { port: profile.proxy.port } : {}),
      ...(profile.proxy.username ? { username: profile.proxy.username } : {}),
    };
  }

  return exported;
}
