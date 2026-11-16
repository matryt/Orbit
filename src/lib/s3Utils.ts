/**
 * S3 utility functions for bucket validation and endpoint normalization.
 */

/**
 * Normalizes an S3 endpoint by ensuring it has an http(s) scheme and no trailing slash.
 */
export function normalizeS3Endpoint(endpoint?: string): string | undefined {
  if (!endpoint) return undefined;
  const trimmed = endpoint.trim();
  if (!trimmed) return undefined;

  let url = trimmed;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }
  return url.replace(/\/+$/, '');
}

/**
 * Validates S3 bucket naming according to AWS and S3-compatible rules:
 * - Between 3 and 63 characters long
 * - Consists only of lowercase letters, numbers, dots (.), and hyphens (-)
 * - Begins and ends with a letter or number
 * - Must not be formatted as an IP address
 */
export function isValidBucketName(bucket: string): boolean {
  if (!bucket || typeof bucket !== 'string') return false;
  const trimmed = bucket.trim();
  if (trimmed.length < 3 || trimmed.length > 63) return false;

  // Must consist only of lowercase letters, numbers, dots, and hyphens
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(trimmed)) return false;

  // Cannot contain two adjacent periods
  if (trimmed.includes('..')) return false;

  // Cannot be formatted as an IPv4 address
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)) return false;

  return true;
}

/**
 * Formats an S3 URI for display: s3://<bucket>/<path>
 */
export function formatS3Uri(bucket: string, key?: string): string {
  const cleanBucket = bucket.trim();
  if (!key) return `s3://${cleanBucket}`;
  const cleanKey = key.trim().replace(/^\/+/, '');
  return cleanKey ? `s3://${cleanBucket}/${cleanKey}` : `s3://${cleanBucket}`;
}
