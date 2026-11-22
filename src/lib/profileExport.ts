import type { ConnectionProfile } from '../types/index.ts';

/**
 * Nettoie un profil de connexion avant l'exportation JSON afin d'exclure
 * tous les secrets (mots de passe, phrases secrètes, clés secrètes S3).
 */
export function sanitizeProfileForExport(profile: ConnectionProfile): Partial<ConnectionProfile> {
  const { isFavorite, ...rest } = profile;
  return {
    ...rest,
    ...(profile.bastion?.enabled
      ? {
          bastion: {
            enabled: true,
            profileId: profile.bastion.profileId,
            host: profile.bastion.host,
            port: profile.bastion.port,
            username: profile.bastion.username,
            authType: profile.bastion.authType,
            keyPath: profile.bastion.keyPath,
          },
        }
      : { bastion: undefined }),
    ...(profile.proxy?.enabled
      ? {
          proxy: {
            enabled: true,
            proxyType: profile.proxy.proxyType,
            host: profile.proxy.host,
            port: profile.proxy.port,
            username: profile.proxy.username,
          },
        }
      : { proxy: undefined }),
    isFavorite,
  };
}
