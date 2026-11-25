import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSshHostString,
  validateS3EndpointUrl,
  isSafeProfileId,
  sanitizeImportedProfile,
  parseAndValidateProfilesJson,
} from './profileImport.ts';
import type { ConnectionProfile } from '../types/index.ts';

describe('profileImport security & validation', () => {
  it('validates safe SSH host strings and rejects injections', () => {
    assert.equal(validateSshHostString('192.168.1.1').valid, true);
    assert.equal(validateSshHostString('bastion.corp.internal').valid, true);
    assert.equal(validateSshHostString('2001:db8::1').valid, true);

    // Injection / control characters
    assert.equal(validateSshHostString('').valid, false);
    assert.equal(validateSshHostString('evil;host').valid, false);
    assert.equal(validateSshHostString('host\nwith\nnewline').valid, false);
    assert.equal(validateSshHostString('host with space').valid, false);
    assert.equal(validateSshHostString('host[with]brackets').valid, false);
    assert.equal(validateSshHostString('host/with/slash').valid, false);
  });

  it('validates S3 endpoints against SSRF metadata targets', () => {
    assert.equal(validateS3EndpointUrl('https://s3.eu-west-1.amazonaws.com').valid, true);
    assert.equal(validateS3EndpointUrl('http://minio.local:9000').valid, true);
    assert.equal(validateS3EndpointUrl(undefined).valid, true);

    // SSRF AWS IMDSv1
    const imds = validateS3EndpointUrl('http://169.254.169.254/latest/meta-data/');
    assert.equal(imds.valid, false);
    assert.ok(imds.error?.includes('SSRF'));

    // GCP metadata
    const gcp = validateS3EndpointUrl('http://metadata.google.internal/computeMetadata/v1/');
    assert.equal(gcp.valid, false);

    // Non-HTTP protocol
    const file = validateS3EndpointUrl('file:///etc/passwd');
    assert.equal(file.valid, false);
  });

  it('prevents keyring key collision by checking for colons in profile IDs', () => {
    assert.equal(isSafeProfileId('prof-12345'), true);
    assert.equal(isSafeProfileId('bastion_prod-1'), true);

    // Dangerous IDs containing colons (would collide with {id}:bastion or {id}:proxy)
    assert.equal(isSafeProfileId('prod:bastion'), false);
    assert.equal(isSafeProfileId('server:proxy'), false);
    assert.equal(isSafeProfileId(''), false);
  });

  it('sanitizes imported profile and regenerates ID if dangerous or duplicate', () => {
    const existing = new Set(['existing-id']);
    const rawWithColon = {
      id: 'prod:bastion',
      name: 'Malicious Injected ID',
      type: 'sftp',
      host: '10.0.0.1',
      port: 22,
    };

    const res = sanitizeImportedProfile(rawWithColon, existing);
    assert.ok(res);
    assert.notEqual(res.profile.id, 'prod:bastion');
    assert.ok(!res.profile.id.includes(':'));
    assert.equal(res.profile.host, '10.0.0.1');

    // Duplicate ID regeneration
    const rawDuplicate = {
      id: 'existing-id',
      name: 'Duplicate ID',
      type: 'sftp',
      host: '10.0.0.2',
    };
    const resDup = sanitizeImportedProfile(rawDuplicate, existing);
    assert.ok(resDup);
    assert.notEqual(resDup.profile.id, 'existing-id');
  });

  it('parses and validates JSON profiles string safely', () => {
    const jsonStr = JSON.stringify([
      {
        id: 'clean-1',
        name: 'Valid SFTP',
        type: 'sftp',
        host: 'sftp.example.com',
        port: 2222,
        username: 'app',
        authType: 'key',
        keyPath: '~/.ssh/id_ed25519',
        bastion: {
          enabled: true,
          host: 'jump.example.com',
          port: 22,
        },
      },
      {
        id: 'bad-host',
        name: 'Bad Host Name',
        type: 'sftp',
        host: 'bad\nhost',
      },
    ]);

    const existing: ConnectionProfile[] = [];
    const { profiles, warnings } = parseAndValidateProfilesJson(jsonStr, existing);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, 'Valid SFTP');
    assert.equal(profiles[0].bastion?.enabled, true);
    assert.equal(profiles[0].bastion?.host, 'jump.example.com');
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('Bad Host Name'));
  });

  it('strictly validates useSudo boolean and port ranges', () => {
    const raw = {
      id: 'prof-test-sudo',
      name: 'Test Sudo',
      type: 'sftp',
      host: '10.0.0.5',
      port: 22.5, // float -> fallback to 22
      useSudo: 'false', // string truthy -> must be false
    };

    const res = sanitizeImportedProfile(raw, new Set());
    assert.ok(res.profile);
    assert.equal(res.profile.port, 22);
    assert.equal(res.profile.useSudo, false);

    const rawTrue = {
      id: 'prof-test-sudo-true',
      name: 'Test Sudo True',
      type: 'sftp',
      host: '10.0.0.5',
      port: 65536, // out of range -> fallback to 22
      useSudo: true,
    };
    const resTrue = sanitizeImportedProfile(rawTrue, new Set());
    assert.ok(resTrue.profile);
    assert.equal(resTrue.profile.port, 22);
    assert.equal(resTrue.profile.useSudo, true);
  });

  it('remaps bastion.profileId when duplicate or unsafe IDs are regenerated in a batch', () => {
    const jsonStr = JSON.stringify([
      {
        id: 'unsafe:bastion:id',
        name: 'Jump Server',
        type: 'sftp',
        host: 'jump.corp.com',
      },
      {
        id: 'target-1',
        name: 'Target Behind Jump',
        type: 'sftp',
        host: 'internal.corp.com',
        bastion: {
          enabled: true,
          profileId: 'unsafe:bastion:id',
        },
      },
    ]);

    const { profiles } = parseAndValidateProfilesJson(jsonStr, []);
    assert.equal(profiles.length, 2);
    const jump = profiles.find((p) => p.name === 'Jump Server')!;
    const target = profiles.find((p) => p.name === 'Target Behind Jump')!;

    assert.ok(!jump.id.includes(':'));
    assert.equal(target.bastion?.profileId, jump.id);
  });
});
