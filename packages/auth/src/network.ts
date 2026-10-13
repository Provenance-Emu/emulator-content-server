export type AccessMode = 'lan' | 'token' | 'subnets';

/** Loopback may edit accounts. Any other trusted address may use the library. */
export type TrustLevel = 'owner' | 'member';

type Address = { version: 4; value: number } | { version: 6; value: bigint };

const V4_BITS = 32;
const V6_BITS = 128;

/**
 * Who this socket may be without a token.
 *
 * `lan` trusts loopback and private ranges. `subnets` trusts loopback plus the
 * listed networks. `token` trusts nobody. Loopback is the owner either way it
 * is trusted, because the menu bar on this machine is what edits accounts, and
 * a TCP peer cannot pretend to be 127.0.0.1 from another host.
 */
export function trustedLevel(
  mode: AccessMode,
  subnets: readonly string[],
  ip: string,
): TrustLevel | null {
  if (mode === 'token') return null;
  const address = parseAddress(ip);
  if (!address) return null;
  if (isLoopback(address)) return 'owner';
  if (mode === 'lan' && isPrivateLan(address)) return 'member';
  if (mode === 'subnets' && subnets.some((cidr) => contains(address, cidr))) return 'member';
  return null;
}

/**
 * A network an operator is allowed to name. The whole internet is refused, and
 * the result is the network address, so `192.168.1.50/24` is stored as
 * `192.168.1.0/24`.
 */
export function canonicalCidr(input: string): string | null {
  const parsed = parseCidr(input.trim());
  if (!parsed || parsed.bits === 0) return null;
  return formatCidr(parsed);
}

function isLoopback(address: Address): boolean {
  const v4 = v4of(address);
  if (v4 !== null) return (v4 >>> 24) === 127;
  return address.version === 6 && address.value === 1n;
}

function isPrivateLan(address: Address): boolean {
  const v4 = v4of(address);
  if (v4 !== null) {
    const a = v4 >>> 24;
    const b = (v4 >>> 16) & 0xff;
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (address.version !== 6) return false;
  // fc00::/7 unique local, fe80::/10 link local.
  const value = address.value;
  if (value >> 121n === 0b1111110n) return true;
  return value >> 118n === 0b1111111010n;
}

function v4of(address: Address): number | null {
  if (address.version === 4) return address.value;
  return mappedV4(address.value);
}

function contains(address: Address, cidr: string): boolean {
  const parsed = parseCidr(cidr);
  if (!parsed) return false;
  if (address.version === 4 && parsed.version === 4) {
    return masked(BigInt(address.value), parsed.bits, V4_BITS) === parsed.network;
  }
  if (address.version === 6 && parsed.version === 6) {
    return masked(address.value, parsed.bits, V6_BITS) === parsed.network;
  }
  if (address.version === 6 && parsed.version === 4) {
    const v4 = mappedV4(address.value);
    if (v4 === null) return false;
    return masked(BigInt(v4), parsed.bits, V4_BITS) === parsed.network;
  }
  return false;
}

function masked(value: bigint, bits: number, width: number): bigint {
  if (bits >= width) return value;
  const shift = BigInt(width - bits);
  return (value >> shift) << shift;
}

type Cidr = { version: 4 | 6; network: bigint; bits: number };

function parseCidr(input: string): Cidr | null {
  const slash = input.lastIndexOf('/');
  if (slash <= 0) return null;
  const address = parseAddress(input.slice(0, slash));
  const bits = Number(input.slice(slash + 1));
  if (!address || !Number.isInteger(bits) || bits < 0) return null;
  const width = address.version === 4 ? V4_BITS : V6_BITS;
  if (bits > width) return null;
  const network = masked(
    address.version === 4 ? BigInt(address.value) : address.value,
    bits,
    width,
  );
  return { version: address.version, network, bits };
}

function formatCidr(cidr: Cidr): string {
  if (cidr.version === 4) return `${formatV4(Number(cidr.network))}/${cidr.bits}`;
  return `${formatV6(cidr.network)}/${cidr.bits}`;
}

function parseAddress(input: string): Address | null {
  let text = input.trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (text.includes('.')) {
    const mapped = text.startsWith('::ffff:') ? text.slice('::ffff:'.length) : null;
    const v4 = ipv4(mapped ?? text);
    if (v4 === null) return null;
    if (mapped !== null) return { version: 6, value: (0xffffn << 32n) | BigInt(v4) };
    if (text.includes(':')) return null;
    return { version: 4, value: v4 };
  }
  const v6 = ipv6(text);
  return v6 === null ? null : { version: 6, value: v6 };
}

function ipv4(input: string): number | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function ipv6(input: string): bigint | null {
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const expand = (side: string): number[] | null => {
    if (side.length === 0) return [];
    const groups = side.split(':');
    const values: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      values.push(Number.parseInt(group, 16));
    }
    return values;
  };
  const left = expand(halves[0] ?? '');
  const right = halves.length === 2 ? expand(halves[1] ?? '') : [];
  if (!left || !right) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length > 7) return null;
  const groups = [
    ...left,
    ...Array(8 - left.length - right.length).fill(0),
    ...right,
  ] as number[];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

function mappedV4(value: bigint): number | null {
  if (value >> 32n !== 0xffffn) return null;
  return Number(value & 0xffffffffn);
}

function formatV4(value: number): string {
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

function formatV6(value: bigint): string {
  const groups: number[] = [];
  for (let shift = 112; shift >= 0; shift -= 16) {
    groups.push(Number((value >> BigInt(shift)) & 0xffffn));
  }
  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  for (let index = 0; index <= groups.length; index += 1) {
    if (index < groups.length && groups[index] === 0) {
      if (start < 0) start = index;
    } else if (start >= 0) {
      const length = index - start;
      if (length > bestLength) {
        bestStart = start;
        bestLength = length;
      }
      start = -1;
    }
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLength).join(':');
  return `${left}::${right}`;
}
