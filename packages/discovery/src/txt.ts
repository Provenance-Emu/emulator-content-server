export const SERVICE_TYPE = 'pvcontent';
export const SERVICE_PROTOCOL = 'tcp';

const ALLOWED_KEYS = new Set(['id', 'v', 'tls', 'pair', 'name']);

export interface DiscoveryTxt {
  id: string;
  v: '1';
  tls: '0' | '1';
  pair: '0' | '1';
  name: string;
}

export function buildDiscoveryTxt(input: {
  serverId: string;
  displayName: string;
  tls: boolean;
  pairing: boolean;
}): DiscoveryTxt {
  if (!/^[0-9a-f-]{36}$/i.test(input.serverId)) {
    throw new Error('Discovery server id must be a UUID');
  }
  const name = input.displayName.trim();
  if (name.length < 1 || name.length > 63) throw new Error('Display name must be 1-63 characters');
  return {
    id: input.serverId,
    v: '1',
    tls: input.tls ? '1' : '0',
    pair: input.pairing ? '1' : '0',
    name,
  };
}

export function assertPublicTxt(record: object): void {
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`Discovery TXT key ${key} is not public`);
  }
}
