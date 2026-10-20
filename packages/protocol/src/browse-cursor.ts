export interface BrowseCursorPosition {
  entityType: 'item' | 'asset' | 'source';
  id: string;
}

function position(value: unknown): value is BrowseCursorPosition {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.entityType === 'string' &&
    ['item', 'asset', 'source'].includes(p.entityType) &&
    typeof p.id === 'string' &&
    p.id.length > 0 &&
    !p.id.includes('\0')
  );
}

export function encodeBrowseCursor(fingerprint: string, value: BrowseCursorPosition): string {
  if (!position(value)) throw new RangeError('Invalid browse position');
  const cursor = Buffer.from(JSON.stringify({ version: 1, fingerprint, position: value })).toString(
    'base64url',
  );
  if (cursor.length > 4096) throw new RangeError('Browse cursor exceeds limit');
  return cursor;
}

export function decodeBrowseCursor(
  cursor: string,
  fingerprint: string,
): BrowseCursorPosition | null {
  if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return decoded.version === 1 &&
      decoded.fingerprint === fingerprint &&
      position(decoded.position)
      ? { entityType: decoded.position.entityType, id: decoded.position.id }
      : null;
  } catch {
    return null;
  }
}
