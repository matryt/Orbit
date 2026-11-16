import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeS3Endpoint, isValidBucketName, formatS3Uri } from './s3Utils.ts';

describe('normalizeS3Endpoint', () => {
  it('returns undefined for empty or undefined input', () => {
    assert.equal(normalizeS3Endpoint(undefined), undefined);
    assert.equal(normalizeS3Endpoint(''), undefined);
    assert.equal(normalizeS3Endpoint('   '), undefined);
  });

  it('prepends https:// when scheme is missing', () => {
    assert.equal(
      normalizeS3Endpoint('abc12345.r2.cloudflarestorage.com'),
      'https://abc12345.r2.cloudflarestorage.com'
    );
    assert.equal(normalizeS3Endpoint('s3.fr-par.scw.cloud'), 'https://s3.fr-par.scw.cloud');
  });

  it('preserves existing http:// and https:// schemes', () => {
    assert.equal(normalizeS3Endpoint('http://localhost:9000'), 'http://localhost:9000');
    assert.equal(normalizeS3Endpoint('https://s3.eu-west-1.amazonaws.com'), 'https://s3.eu-west-1.amazonaws.com');
  });

  it('removes trailing slashes', () => {
    assert.equal(normalizeS3Endpoint('http://localhost:9000/'), 'http://localhost:9000');
    assert.equal(normalizeS3Endpoint('https://r2.cloudflare.com///'), 'https://r2.cloudflare.com');
  });
});

describe('isValidBucketName', () => {
  it('accepts valid S3 bucket names', () => {
    assert.equal(isValidBucketName('my-bucket'), true);
    assert.equal(isValidBucketName('production-assets-2026'), true);
    assert.equal(isValidBucketName('orbit.backup.bucket'), true);
    assert.equal(isValidBucketName('minio123'), true);
  });

  it('rejects bucket names that are too short or too long', () => {
    assert.equal(isValidBucketName('ab'), false);
    assert.equal(isValidBucketName('a'.repeat(64)), false);
  });

  it('rejects uppercase letters and invalid symbols', () => {
    assert.equal(isValidBucketName('MyBucket'), false);
    assert.equal(isValidBucketName('bucket_with_underscore'), false);
    assert.equal(isValidBucketName('bucket!special'), false);
  });

  it('rejects starting or ending with hyphen or dot', () => {
    assert.equal(isValidBucketName('-mybucket'), false);
    assert.equal(isValidBucketName('mybucket-'), false);
    assert.equal(isValidBucketName('.mybucket'), false);
    assert.equal(isValidBucketName('mybucket.'), false);
  });

  it('rejects adjacent periods or IP addresses', () => {
    assert.equal(isValidBucketName('my..bucket'), false);
    assert.equal(isValidBucketName('192.168.1.1'), false);
  });
});

describe('formatS3Uri', () => {
  it('formats root bucket URI', () => {
    assert.equal(formatS3Uri('my-bucket'), 's3://my-bucket');
    assert.equal(formatS3Uri('my-bucket', ''), 's3://my-bucket');
    assert.equal(formatS3Uri('my-bucket', '/'), 's3://my-bucket');
  });

  it('formats bucket with key path', () => {
    assert.equal(formatS3Uri('my-bucket', 'photos/cat.jpg'), 's3://my-bucket/photos/cat.jpg');
    assert.equal(formatS3Uri('my-bucket', '/photos/cat.jpg'), 's3://my-bucket/photos/cat.jpg');
    assert.equal(formatS3Uri('my-bucket', '///documents/report.pdf'), 's3://my-bucket/documents/report.pdf');
  });
});
