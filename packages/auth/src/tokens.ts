import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface IssuedToken {
  token: string;
  hash: string;
}

export function issueToken(): IssuedToken {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenHashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
