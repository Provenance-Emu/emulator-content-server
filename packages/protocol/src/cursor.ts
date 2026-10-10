export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 512) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded || decoded.includes('\0')) return null;
  return decoded;
}

export function parseChangeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0;
  if (!/^[0-9]+$/.test(cursor)) return Number.NaN;
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0) return Number.NaN;
  return value;
}
