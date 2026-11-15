export function isPermissionDeniedError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === 'object' && err !== null && 'type' in err && (err as { type: unknown }).type === 'PermissionDenied') {
    return true;
  }
  const msg = (
    typeof err === 'string'
      ? err
      : err instanceof Error
        ? err.message
        : typeof err === 'object' && 'message' in (err as Record<string, unknown>)
          ? String((err as Record<string, unknown>).message)
          : JSON.stringify(err)
  ).toLowerCase();

  return (
    msg.includes('permission denied') ||
    msg.includes('permission non accordée') ||
    msg.includes('accès refusé') ||
    msg.includes('eacces')
  );
}
