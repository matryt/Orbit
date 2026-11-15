import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPermissionDeniedError } from './permissionError.ts';

describe('isPermissionDeniedError', () => {
  it('detects structured AppError PermissionDenied', () => {
    assert.equal(isPermissionDeniedError({ type: 'PermissionDenied', message: 'Access denied' }), true);
  });

  it('detects case-insensitive permission denied string in message', () => {
    assert.equal(isPermissionDeniedError({ message: 'Failed to open directory: Permission Denied' }), true);
    assert.equal(isPermissionDeniedError(new Error('permission denied')), true);
    assert.equal(isPermissionDeniedError('Permission denied: cannot access /root'), true);
  });

  it('detects EACCES error code and French access refuse', () => {
    assert.equal(isPermissionDeniedError({ message: 'EACCES: permission denied, scandir /root' }), true);
    assert.equal(isPermissionDeniedError('Error: EACCES'), true);
    assert.equal(isPermissionDeniedError('Accès refusé par le système'), true);
  });

  it('returns false for unrelated errors', () => {
    assert.equal(isPermissionDeniedError(new Error('Connection reset by peer')), false);
    assert.equal(isPermissionDeniedError({ type: 'NotFound', message: 'No such file or directory' }), false);
    assert.equal(isPermissionDeniedError(null), false);
    assert.equal(isPermissionDeniedError(undefined), false);
  });
});
