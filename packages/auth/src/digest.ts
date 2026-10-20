import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const DAV_REALM = 'Emulator Content Server WebDAV';
type Algorithm = 'MD5' | 'SHA-256';
export interface DigestVerifier {
  id: string;
  ha1Md5: string;
  ha1Sha256: string;
}
export type DigestResult =
  | { kind: 'ok'; credentialId: string }
  | { kind: 'invalid' | 'stale' | 'full' };
const hash = (algorithm: Algorithm, value: string) =>
  createHash(algorithm === 'MD5' ? 'md5' : 'sha256')
    .update(value)
    .digest('hex');
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function digestVerifiers(username: string, password: string) {
  const value = `${username}:${DAV_REALM}:${password}`;
  return { ha1Md5: hash('MD5', value), ha1Sha256: hash('SHA-256', value) };
}
export function responseDigest(
  algorithm: Algorithm,
  ha1: string,
  nonce: string,
  nc: string,
  cnonce: string,
  method: string,
  uri: string,
): string {
  return hash(
    algorithm,
    `${ha1}:${nonce}:${nc}:${cnonce}:auth:${hash(algorithm, `${method}:${uri}`)}`,
  );
}
function parse(header: string): Record<string, string> | null {
  if (header.length > 8192 || !/^Digest /i.test(header)) return null;
  const input = header.slice(7);
  const result: Record<string, string> = Object.create(null);
  let offset = 0;
  while (offset < input.length) {
    const match =
      /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\\r\n]|\\[\x20-\x7e])*)"|([A-Za-z0-9._~-]+))\s*(,|$)/.exec(
        input.slice(offset),
      );
    if (!match?.[1]) return null;
    const key = match[1].toLowerCase();
    if (Object.hasOwn(result, key)) return null;
    result[key] = (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1');
    offset += match[0].length;
    if (match[4] === ',' && offset === input.length) return null;
  }
  return result;
}
interface Replay {
  expires: number;
  highest: number;
  seen: bigint;
}
export class DigestAuthority {
  private readonly key: Buffer;
  private readonly now: () => number;
  private readonly replay = new Map<string, Replay>();
  constructor(options: { key?: Buffer; now?: () => number } = {}) {
    this.key = options.key ?? randomBytes(32);
    this.now = options.now ?? Date.now;
  }
  private sign(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('base64url');
  }
  challenges(stale = false): string[] {
    const value = `${this.now()}.${randomBytes(16).toString('hex')}`;
    const nonce = `${value}.${this.sign(`nonce:${value}`)}`;
    return (['SHA-256', 'MD5'] as const).map(
      (algorithm) =>
        `Digest realm="${DAV_REALM}", nonce="${nonce}", opaque="${this.sign(`opaque:${nonce}`)}", algorithm=${algorithm}, qop="auth", charset=UTF-8${stale ? ', stale=true' : ''}`,
    );
  }
  verify(
    input: { header: string; method: string; uri: string },
    lookup: (username: string) => DigestVerifier | null,
  ): DigestResult {
    const invalid = { kind: 'invalid' } as const;
    const p = parse(input.header);
    if (
      !p ||
      p.realm !== DAV_REALM ||
      p.uri !== input.uri ||
      p.qop !== 'auth' ||
      !p.username ||
      !p.cnonce ||
      p.cnonce.length > 128 ||
      !/^[\x20-\x7e]+$/.test(p.cnonce) ||
      !p.nc ||
      !/^[a-fA-F0-9]{8}$/.test(p.nc) ||
      parseInt(p.nc, 16) === 0 ||
      !p.nonce ||
      !p.opaque ||
      !p.response ||
      (p.userhash && p.userhash !== 'false')
    )
      return invalid;
    const algorithm = p.algorithm ?? 'MD5';
    if (algorithm !== 'MD5' && algorithm !== 'SHA-256') return invalid;
    const parts = /^(\d{13})\.([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/.exec(p.nonce);
    if (
      !parts ||
      !equal(parts[3] ?? '', this.sign(`nonce:${parts[1]}.${parts[2]}`)) ||
      !equal(p.opaque, this.sign(`opaque:${p.nonce}`))
    )
      return invalid;
    const issued = Number(parts[1]);
    const now = this.now();
    if (issued > now) return invalid;
    const credential = lookup(p.username);
    if (!credential) return invalid;
    const ha1 = algorithm === 'MD5' ? credential.ha1Md5 : credential.ha1Sha256;
    if (
      !new RegExp(`^[a-fA-F0-9]{${algorithm === 'MD5' ? 32 : 64}}$`).test(p.response) ||
      !equal(
        p.response.toLowerCase(),
        responseDigest(algorithm, ha1, p.nonce, p.nc, p.cnonce, input.method, input.uri),
      )
    )
      return invalid;
    if (issued + 300_000 < now) return { kind: 'stale' };
    for (const [key, value] of this.replay) if (value.expires < now) this.replay.delete(key);
    const key = JSON.stringify([credential.id, p.nonce, p.cnonce]);
    const prior = this.replay.get(key);
    const count = parseInt(p.nc, 16);
    if (!prior) {
      if (this.replay.size >= 10_000) return { kind: 'full' };
      this.replay.set(key, { highest: count, seen: 1n, expires: issued + 300_000 });
    } else if (count > prior.highest) {
      const shift = count - prior.highest;
      prior.seen = shift >= 64 ? 1n : ((prior.seen << BigInt(shift)) | 1n) & ((1n << 64n) - 1n);
      prior.highest = count;
    } else {
      const behind = prior.highest - count;
      if (behind >= 64 || (prior.seen & (1n << BigInt(behind))) !== 0n) return invalid;
      prior.seen |= 1n << BigInt(behind);
    }
    return { kind: 'ok', credentialId: credential.id };
  }
}
