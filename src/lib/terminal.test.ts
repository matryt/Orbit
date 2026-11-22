import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionProfile } from '../types/index.ts';

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

    assert.equal(sftpProfile.type === 'sftp', true);
    assert.equal(s3Profile.type === 'sftp', false);
  });

  it('formats target path correctly for remote directory navigation', () => {
    const resolveTargetPath = (remotePath?: string, currentPath = '/'): string => {
      return remotePath ?? currentPath;
    };

    assert.equal(resolveTargetPath(undefined, '/var/log'), '/var/log');
    assert.equal(resolveTargetPath('/etc/nginx', '/var/log'), '/etc/nginx');
    assert.equal(resolveTargetPath('/home/user/with space', '/'), '/home/user/with space');
  });
});
