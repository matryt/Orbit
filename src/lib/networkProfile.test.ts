import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionProfile } from '../types/index.ts';
import { sanitizeProfileForExport } from './profileExport.ts';

describe('network profiles (bastion & proxy)', () => {
  it('sanitizes bastion and proxy configurations for export without leaking secrets', () => {
    const rawProfile: ConnectionProfile = {
      id: 'prof-1',
      name: 'Internal Server via Jump',
      type: 'sftp',
      host: '10.0.0.5',
      port: 22,
      username: 'ubuntu',
      status: 'idle',
      isFavorite: true,
      bastion: {
        enabled: true,
        host: 'bastion.corp.com',
        port: 2222,
        username: 'jumpuser',
        authType: 'password',
        password: 'SUPER_SECRET_BASTION_PASSWORD',
        passphrase: 'SHOULD_NOT_LEAK',
      },
      proxy: {
        enabled: true,
        proxyType: 'socks5',
        host: '127.0.0.1',
        port: 1080,
        username: 'proxyuser',
        password: 'SUPER_SECRET_PROXY_PASSWORD',
      },
    };

    const sanitized = sanitizeProfileForExport(rawProfile);
    const exportedJson = JSON.stringify(sanitized);

    assert.ok(!exportedJson.includes('SUPER_SECRET_BASTION_PASSWORD'));
    assert.ok(!exportedJson.includes('SHOULD_NOT_LEAK'));
    assert.ok(!exportedJson.includes('SUPER_SECRET_PROXY_PASSWORD'));
    assert.ok(exportedJson.includes('bastion.corp.com'));
    assert.ok(exportedJson.includes('socks5'));
  });

  it('correctly handles bastion referencing an existing profile ID during export', () => {
    const profileWithJumpRef: ConnectionProfile = {
      id: 'prof-2',
      name: 'Server with Jump Reference',
      type: 'sftp',
      host: 'db.internal',
      port: 22,
      username: 'postgres',
      status: 'idle',
      isFavorite: false,
      bastion: {
        enabled: true,
        profileId: 'bastion-prof-prod',
      },
      proxy: {
        enabled: false,
        proxyType: 'socks5',
        host: '127.0.0.1',
      },
    };

    const sanitized = sanitizeProfileForExport(profileWithJumpRef);
    assert.equal(sanitized.bastion?.enabled, true);
    assert.equal(sanitized.bastion?.profileId, 'bastion-prof-prod');
    assert.equal(sanitized.bastion?.host, undefined);
    assert.equal(sanitized.proxy, undefined);
  });
});
