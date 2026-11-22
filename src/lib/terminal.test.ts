import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionProfile } from '../types/index.ts';
import { canOpenTerminal, resolveTerminalTargetPath } from './pathUtils.ts';

describe('external terminal integration', () => {
  it('determines if a connection profile supports external terminal (SFTP only)', () => {
    const sftpProfile: ConnectionProfile = {
      id: 'p1',
      name: 'SFTP Host',
      type: 'sftp',
      host: '192.168.1.10',
      port: 22,
      username: 'root',
      status: 'connected',
      isFavorite: false,
    };

    const s3Profile: ConnectionProfile = {
      id: 'p2',
      name: 'S3 Storage',
      type: 's3',
      endpoint: 'https://s3.amazonaws.com',
      bucket: 'my-bucket',
      status: 'connected',
      isFavorite: false,
    };

    assert.equal(canOpenTerminal(sftpProfile), true);
    assert.equal(canOpenTerminal(s3Profile), false);
    assert.equal(canOpenTerminal(null), false);
    assert.equal(canOpenTerminal(undefined), false);
  });

  it('formats target path correctly for remote directory navigation', () => {
    assert.equal(resolveTerminalTargetPath(undefined, '/var/log'), '/var/log');
    assert.equal(resolveTerminalTargetPath('/etc/nginx', '/var/log'), '/etc/nginx');
    assert.equal(resolveTerminalTargetPath('/home/user/with space', '/'), '/home/user/with space');
    assert.equal(resolveTerminalTargetPath(undefined, '/'), '/');
  });

  it('handles adversarial path inputs without modifying raw values', () => {
    const maliciousPaths = [
      '/var/log/`id`',
      '/var/log/$(reboot)',
      '/var/log; rm -rf /',
      '/var/log & ping 127.0.0.1',
      '/var/log/with "quotes" and \'apostrophes\'',
      '../../../etc/shadow',
      '/srv/trailing space ',
      ' /srv/leading space',
    ];

    for (const p of maliciousPaths) {
      assert.equal(resolveTerminalTargetPath(p, '/default'), p);
    }
  });
});
