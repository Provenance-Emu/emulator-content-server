import { crc32 } from 'node:zlib';
import type { ProviderCapability } from './manifest.js';

export interface MatchCompanion {
  id: string;
  name: string;
  metadata?: Record<string, string>;
  cheats?: { count: number };
  patch?: { format: 'ips' | 'bps' | 'ups'; sourceCrc32?: string; sourceSize?: number };
}
export interface MatchingInput {
  name: string;
  systemId: string | null;
  size?: number;
  crc32?: string;
  md5?: string;
  online?: boolean;
  companions: MatchCompanion[];
}
export interface MatchCandidate {
  id: string;
  kind: ProviderCapability;
  title: string;
  confidence: 'checksum' | 'local' | 'name';
  metadata: Record<string, string>;
  fileId?: string;
  url?: string;
}
export interface MatchingProvider {
  id: string;
  name: string;
  capabilities: ProviderCapability[];
  network: boolean;
  search: (input: MatchingInput, signal?: AbortSignal) => Promise<MatchCandidate[]>;
}
export interface MatchingResult {
  candidates: (MatchCandidate & { providerId: string })[];
  problems: { providerId: string; code: 'provider-failed' }[];
}
export interface DatRecord {
  title: string;
  name: string;
  size: number;
  crc32?: string;
  md5?: string;
}

/** A manager coordinates providers; it never turns a filename hint into a verified match. */
export async function runMatching(
  input: MatchingInput,
  providers: MatchingProvider[],
  signal?: AbortSignal,
): Promise<MatchingResult> {
  const candidates: MatchingResult['candidates'] = [];
  const problems: MatchingResult['problems'] = [];
  await Promise.all(
    providers.slice(0, 32).map(async (provider) => {
      signal?.throwIfAborted();
      if (provider.network && !input.online) return;
      try {
        const timeout = AbortSignal.timeout(8_000);
        const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const result = await Promise.race([
          provider.search(input, bounded),
          new Promise<never>((_, reject) =>
            bounded.addEventListener('abort', () => reject(new Error('provider timed out')), {
              once: true,
            }),
          ),
        ]);
        const checked = validateCandidates(result, provider.capabilities);
        candidates.push(...checked.map((candidate) => ({ ...candidate, providerId: provider.id })));
      } catch {
        signal?.throwIfAborted();
        problems.push({ providerId: provider.id, code: 'provider-failed' });
      }
    }),
  );
  problems.sort((a, b) => a.providerId.localeCompare(b.providerId));
  const rank = { checksum: 0, local: 1, name: 2 };
  candidates.sort(
    (a, b) =>
      rank[a.confidence] - rank[b.confidence] ||
      a.providerId.localeCompare(b.providerId) ||
      a.id.localeCompare(b.id),
  );
  return { candidates: candidates.slice(0, 100), problems };
}

export function validateCandidates(
  value: unknown,
  capabilities: readonly ProviderCapability[],
): MatchCandidate[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid provider response');
  const ids = new Set<string>();
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid candidate');
    const c = raw as Record<string, unknown>;
    if (
      !text(c.id, 200) ||
      ids.has(c.id) ||
      !text(c.title, 512) ||
      !capabilities.includes(c.kind as ProviderCapability) ||
      !['checksum', 'local', 'name'].includes(String(c.confidence))
    )
      throw new Error('Invalid candidate');
    ids.add(c.id);
    if (!c.metadata || typeof c.metadata !== 'object' || Array.isArray(c.metadata))
      throw new Error('Invalid metadata');
    const metadata: Record<string, string> = {};
    const entries = Object.entries(c.metadata);
    if (entries.length > 24) throw new Error('Too much metadata');
    for (const [key, value] of entries) {
      if (!/^[a-z][a-zA-Z0-9]{0,31}$/.test(key) || !text(value, 4096))
        throw new Error('Invalid metadata');
      Object.defineProperty(metadata, key, { value, enumerable: true });
    }
    const candidate: MatchCandidate = {
      id: c.id,
      kind: c.kind as ProviderCapability,
      title: c.title,
      confidence: c.confidence as MatchCandidate['confidence'],
      metadata,
    };
    if (c.fileId !== undefined) {
      if (!text(c.fileId, 200)) throw new Error('Invalid file id');
      candidate.fileId = c.fileId;
    }
    if (c.url !== undefined) {
      if (!text(c.url, 2048)) throw new Error('Invalid link');
      const url = new URL(c.url);
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('Invalid link');
      candidate.url = url.href;
    }
    return candidate;
  });
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0)),
    )
  );
}

function stem(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .normalize('NFC')
    .toLowerCase();
}
export const localMatchingProvider: MatchingProvider = {
  id: 'org.ecs.local',
  name: 'Local files',
  capabilities: ['metadata', 'artwork', 'patch'],
  network: false,
  async search(input) {
    const matches: MatchCandidate[] = [];
    const target = stem(input.name);
    for (const companion of input.companions.slice(0, 100)) {
      const sameName =
        stem(companion.name).replace(/(?:[ ._-](?:cover|boxart|front))$/, '') === target;
      const sameBase =
        !!input.crc32 &&
        input.crc32.toLowerCase() === companion.patch?.sourceCrc32 &&
        input.size === companion.patch.sourceSize;
      if (!sameName && !sameBase) continue;
      const base = {
        id: companion.id,
        title: input.name.replace(/\.[^.]+$/, ''),
        fileId: companion.id,
      };
      if (companion.metadata) {
        matches.push({
          ...base,
          title: companion.metadata.title ?? base.title,
          kind: 'metadata',
          confidence: 'local',
          metadata: companion.metadata,
        });
      } else if (/\.(png|jpe?g|webp)$/i.test(companion.name)) {
        matches.push({ ...base, kind: 'artwork', confidence: 'local', metadata: {} });
      } else if (companion.patch) {
        const patch = companion.patch;
        // A checksummed patch for a different base is not a candidate, even with the same name.
        if (
          input.crc32 &&
          patch.sourceCrc32 &&
          (input.crc32.toLowerCase() !== patch.sourceCrc32 || input.size !== patch.sourceSize)
        )
          continue;
        const verified =
          !!input.crc32 &&
          input.crc32.toLowerCase() === patch.sourceCrc32 &&
          input.size === patch.sourceSize;
        matches.push({
          ...base,
          kind: 'patch',
          confidence: verified ? 'checksum' : 'name',
          metadata: {
            format: patch.format,
            verification: verified ? 'Base checksum and size match' : 'Base ROM not verified',
          },
        });
      }
    }
    return matches;
  },
};

/** Small clrmamepro tokenizer: quoted titles may themselves contain parentheses. */
export function parseLibretroDat(source: string): DatRecord[] {
  if (source.length > 16 * 1024 * 1024) throw new Error('DAT too large');
  const tokens = source.match(/"(?:\\.|[^"\\])*"|[()]|[^\s()"]+/g) ?? [];
  let at = 0;
  const scalar = (token: string): string =>
    token.startsWith('"') ? token.slice(1, -1).replace(/\\(["\\])/g, '$1') : token;
  type Block = { fields: Record<string, string>; children: { key: string; block: Block }[] };
  function block(depth: number): Block {
    if (depth > 8) throw new Error('DAT nesting too deep');
    const value: Block = { fields: {}, children: [] };
    while (at < tokens.length) {
      const key = tokens[at++];
      if (key === ')') return value;
      const next = tokens[at++];
      if (!key || next === undefined || next === ')') throw new Error('Malformed DAT');
      if (next === '(') value.children.push({ key, block: block(depth + 1) });
      else value.fields[key] = scalar(next);
    }
    if (depth > 0) throw new Error('Unclosed DAT block');
    return value;
  }
  const parsed = block(0);
  const records: DatRecord[] = [];
  for (const game of parsed.children.filter((child) => child.key === 'game')) {
    for (const rom of game.block.children.filter((child) => child.key === 'rom')) {
      const fields = rom.block.fields;
      const title = game.block.fields.name;
      const size = Number(fields.size);
      if (!title || !fields.name || !Number.isSafeInteger(size) || size < 0) continue;
      records.push({
        title,
        name: fields.name,
        size,
        ...(/^[0-9a-f]{8}$/i.test(fields.crc ?? '')
          ? { crc32: (fields.crc ?? '').toLowerCase() }
          : {}),
        ...(/^[0-9a-f]{32}$/i.test(fields.md5 ?? '')
          ? { md5: (fields.md5 ?? '').toLowerCase() }
          : {}),
      });
    }
  }
  return records;
}
export function matchLibretro(input: MatchingInput, records: DatRecord[]): MatchCandidate[] {
  const found: MatchCandidate[] = [];
  for (const [index, record] of records.entries()) {
    const checksum =
      input.size === record.size &&
      ((!!input.md5 && input.md5.toLowerCase() === record.md5) ||
        (!input.md5 && !!input.crc32 && input.crc32.toLowerCase() === record.crc32));
    if (
      !checksum &&
      stem(input.name) !== stem(record.name) &&
      stem(input.name) !== record.title.normalize('NFC').toLowerCase()
    )
      continue;
    found.push({
      id: `dat-${index}`,
      kind: 'metadata',
      title: record.title,
      confidence: checksum ? 'checksum' : 'name',
      metadata: {
        title: record.title,
        systemId: input.systemId ?? '',
        romName: record.name,
        source: 'Libretro database',
        ...(record.crc32 ? { crc32: record.crc32 } : {}),
      },
    });
  }
  return found
    .sort((a, b) => Number(b.confidence === 'checksum') - Number(a.confidence === 'checksum'))
    .slice(0, 30);
}

/** Reads patch identity only; never applies it or changes the source ROM. */
export function patchFingerprint(bytes: Uint8Array): MatchCompanion['patch'] | null {
  const buffer = Buffer.from(bytes);
  if (
    buffer.subarray(0, 5).toString() === 'PATCH' &&
    (buffer.subarray(-3).toString() === 'EOF' || buffer.subarray(-6, -3).toString() === 'EOF')
  )
    return { format: 'ips' };
  const signature = buffer.subarray(0, 4).toString();
  if (
    !['BPS1', 'UPS1'].includes(signature) ||
    buffer.length < 18 ||
    buffer.length > 256 * 1024 ||
    crc32(buffer.subarray(0, -4)) !== buffer.readUInt32LE(buffer.length - 4)
  )
    return null;
  let at = 4;
  function integer(): number {
    let value = 0;
    let shift = 1;
    for (let count = 0; count < 8; count++) {
      if (at >= buffer.length - 12) throw new Error('Invalid patch integer');
      const byte = buffer[at++];
      if (byte === undefined) throw new Error('Invalid patch byte');
      value += (byte & 127) * shift;
      if (!Number.isSafeInteger(value)) throw new Error('Invalid patch integer');
      if (byte & 128) return value;
      shift *= 128;
      value += shift;
    }
    throw new Error('Invalid patch integer');
  }
  try {
    const sourceSize = integer();
    integer();
    return {
      format: signature === 'BPS1' ? 'bps' : 'ups',
      sourceSize,
      sourceCrc32: buffer
        .readUInt32LE(buffer.length - 12)
        .toString(16)
        .padStart(8, '0'),
    };
  } catch {
    return null;
  }
}
