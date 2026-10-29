import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createLibretroMatcher,
  type DatRecord,
  type MatchCandidate,
  type MatchingInput,
  type MatchingProvider,
  matchLibretro,
  reconcileCandidates,
  validateCandidates,
} from './matching.js';
import { createCatalogLoader } from './public-catalog.js';

export type HostedCatalogKind = 'metadata' | 'cheats' | 'patch';
export interface HostedCatalogPin {
  url: string;
  sha256: string;
  bytes: number;
  release: string;
}
export interface HostedCatalogSource {
  id: string;
  name: string;
  url: string;
  revision: string;
  license: string;
  notice?: string;
}
export interface HostedCatalogShardDescriptor {
  id: string;
  kind: HostedCatalogKind;
  systemId: string;
  url: string;
  sha256: string;
  bytes: number;
  records: number;
  sourceIds: string[];
}
export interface HostedCatalogIndex {
  version: 1;
  release: string;
  sources: HostedCatalogSource[];
  shards: HostedCatalogShardDescriptor[];
}
export interface HostedCatalogResource {
  url: string;
  sha256: string;
  bytes: number;
  format: 'retroarch-cht' | 'bps' | 'ups' | 'ips';
}
export interface HostedCatalogRecord extends DatRecord {
  id: string;
  sourceIds: string[];
  metadata?: Record<string, string>;
  resource?: HostedCatalogResource;
}
export interface HostedCatalogShard {
  version: 1;
  release: string;
  kind: HostedCatalogKind;
  systemId: string;
  records: HostedCatalogRecord[];
}
export interface HostedCatalogResourceRef {
  release: string;
  shardId: string;
  recordId: string;
}
export interface HostedCatalogResourceReply {
  bytes: Uint8Array;
  kind: 'cheats' | 'patch';
  format: HostedCatalogResource['format'];
  sha256: string;
  release: string;
}
export interface HostedCatalogSync {
  release: string;
  shards: number;
  records: number;
}
export interface HostedCatalogClient {
  providers(): MatchingProvider[];
  metadata(input: MatchingInput, signal?: AbortSignal): Promise<MatchCandidate[] | null>;
  index(signal?: AbortSignal): Promise<HostedCatalogIndex>;
  sync(options?: { systemIds?: string[] }, signal?: AbortSignal): Promise<HostedCatalogSync>;
  resource(
    ref: HostedCatalogResourceRef,
    signal?: AbortSignal,
  ): Promise<HostedCatalogResourceReply>;
}
export const HOSTED_CATALOG_LIMITS = {
  index: 256 * 1024,
  shard: 16 * 1024 * 1024,
  cheats: 256 * 1024,
  patch: 2 * 1024 * 1024,
} as const;
const kinds = ['metadata', 'cheats', 'patch'] as const;
const metadataKeys = new Set([
  'developer',
  'publisher',
  'year',
  'genre',
  'description',
  'region',
  'language',
  'revision',
  'patchType',
  'license',
]);
const hashLengths = { md5: 32, sha1: 40, crc32: 8 } as const;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function invalid(): never {
  throw new Error('Invalid hosted catalog');
}
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !allowed.includes(key))) invalid();
  return row;
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !Array.from(value).some(
      (char) =>
        char.charCodeAt(0) === 127 ||
        (char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0))),
    )
  );
}
function id(value: unknown): value is string {
  return text(value, 120) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
}
function system(value: unknown): value is string {
  return text(value, 120) && /^[a-zA-Z0-9]+(?:\.[a-zA-Z0-9_-]+)+$/.test(value);
}
function integer(value: unknown, max: number, min = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}
function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value;
}
function strings(value: unknown, max: number, length: number): string[] {
  const values = list(value, max).map((item) => {
    if (!text(item, length)) invalid();
    return item;
  });
  if (new Set(values).size !== values.length) invalid();
  return values;
}
function sourceIds(value: unknown, allowed: Set<string>): string[] {
  const values = strings(value, 16, 120);
  if (!values.length || values.some((value) => !allowed.has(value))) invalid();
  return values;
}
function sourceUrl(value: unknown): string {
  if (!text(value, 2048)) invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || /[\s\\]/.test(value))
    invalid();
  return url.href;
}
/** Fetch targets are pinned GitHub release assets or commit-addressed raw files, never caller URLs. */
export function validateHostedCatalogUrl(value: unknown): string {
  if (!text(value, 2048)) invalid();
  const url = new URL(sourceUrl(value));
  if (url.search || url.hash) invalid();
  let parts: string[];
  try {
    parts = url.pathname
      .split('/')
      .slice(1)
      .map((part) => decodeURIComponent(part));
  } catch {
    return invalid();
  }
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[/\\]/.test(part) ||
        Array.from(part).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    )
  )
    invalid();
  const repo = /^[a-zA-Z0-9_.-]+$/;
  if (!repo.test(parts[0] ?? '') || !repo.test(parts[1] ?? '')) invalid();
  if (url.hostname === 'raw.githubusercontent.com') {
    if (!/^[a-f0-9]{40}$/i.test(parts[2] ?? '') || parts.length < 4) invalid();
  } else if (url.hostname === 'github.com') {
    if (
      parts.length !== 6 ||
      parts[2] !== 'releases' ||
      parts[3] !== 'download' ||
      !id(parts[4]) ||
      parts[4] === 'latest'
    )
      invalid();
  } else invalid();
  return url.href;
}
export function validateHostedCatalogPin(value: unknown): HostedCatalogPin {
  const row = object(value, ['url', 'sha256', 'bytes', 'release']);
  if (
    !sha256(row.sha256) ||
    !integer(row.bytes, HOSTED_CATALOG_LIMITS.index, 1) ||
    !id(row.release)
  )
    invalid();
  return {
    url: validateHostedCatalogUrl(row.url),
    sha256: row.sha256,
    bytes: row.bytes,
    release: row.release,
  };
}
export function validateHostedCatalogIndex(value: unknown): HostedCatalogIndex {
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > HOSTED_CATALOG_LIMITS.index) invalid();
  } catch {
    invalid();
  }
  const root = object(value, ['version', 'release', 'sources', 'shards']);
  if (root.version !== 1 || !id(root.release)) invalid();
  const sources = list(root.sources, 64).map((value) => {
    const row = object(value, ['id', 'name', 'url', 'revision', 'license', 'notice']);
    if (
      !id(row.id) ||
      !text(row.name, 160) ||
      !text(row.revision, 160) ||
      !text(row.license, 160) ||
      (row.notice !== undefined && !text(row.notice, 4096))
    )
      invalid();
    return {
      id: row.id,
      name: row.name,
      url: sourceUrl(row.url),
      revision: row.revision,
      license: row.license,
      ...(row.notice === undefined ? {} : { notice: row.notice }),
    };
  });
  const sourceKeys = new Set(sources.map((source) => source.id));
  if (!sources.length || sourceKeys.size !== sources.length) invalid();
  const shards = list(root.shards, 256).map((value) => {
    const row = object(value, [
      'id',
      'kind',
      'systemId',
      'url',
      'sha256',
      'bytes',
      'records',
      'sourceIds',
    ]);
    if (
      !id(row.id) ||
      !kinds.includes(row.kind as HostedCatalogKind) ||
      !system(row.systemId) ||
      !sha256(row.sha256) ||
      !integer(row.bytes, HOSTED_CATALOG_LIMITS.shard, 1) ||
      !integer(row.records, 100000)
    )
      invalid();
    return {
      id: row.id,
      kind: row.kind as HostedCatalogKind,
      systemId: row.systemId,
      url: validateHostedCatalogUrl(row.url),
      sha256: row.sha256,
      bytes: row.bytes,
      records: row.records,
      sourceIds: sourceIds(row.sourceIds, sourceKeys),
    };
  });
  if (
    new Set(shards.map((shard) => shard.id)).size !== shards.length ||
    shards.reduce((sum, shard) => sum + shard.bytes, 0) > 512 * 1024 * 1024
  )
    invalid();
  return { version: 1, release: root.release, sources, shards };
}
export function validateHostedCatalogShard(
  value: unknown,
  descriptor: HostedCatalogShardDescriptor,
  index: HostedCatalogIndex,
): HostedCatalogShard {
  const root = object(value, ['version', 'release', 'kind', 'systemId', 'records']);
  if (
    root.version !== 1 ||
    root.release !== index.release ||
    root.kind !== descriptor.kind ||
    root.systemId !== descriptor.systemId
  )
    invalid();
  const allowedSources = new Set(descriptor.sourceIds);
  const records = list(root.records, 100000).map((value) => {
    const row = object(value, [
      'id',
      'sourceIds',
      'title',
      'name',
      'aliases',
      'systemId',
      'source',
      'size',
      'md5',
      'sha1',
      'crc32',
      'serials',
      'setIds',
      'media',
      'metadata',
      'resource',
    ]);
    if (
      !id(row.id) ||
      !text(row.title, 512) ||
      !text(row.name, 512) ||
      (row.systemId !== undefined && row.systemId !== descriptor.systemId) ||
      (row.source !== undefined && !text(row.source, 512)) ||
      (row.size !== undefined && !integer(row.size, Number.MAX_SAFE_INTEGER)) ||
      (row.media !== undefined && !['rom', 'disk'].includes(String(row.media)))
    )
      invalid();
    const hashes: Pick<DatRecord, 'md5' | 'sha1' | 'crc32'> = {};
    for (const algorithm of ['md5', 'sha1', 'crc32'] as const) {
      const hash = row[algorithm];
      if (hash !== undefined) {
        if (
          typeof hash !== 'string' ||
          !new RegExp(`^[a-f0-9]{${hashLengths[algorithm]}}$`, 'i').test(hash)
        )
          invalid();
        hashes[algorithm] = hash.toLowerCase();
      }
    }
    const metadata: Record<string, string> = {};
    if (row.metadata !== undefined) {
      const values = object(row.metadata, [...metadataKeys]);
      if (Object.keys(values).length > 6) invalid();
      for (const [key, value] of Object.entries(values)) {
        if (!text(value, 4096)) invalid();
        if (key === 'patchType' && !['translation', 'rom-hack', 'patch'].includes(value)) invalid();
        metadata[key] = value;
      }
    }
    let resource: HostedCatalogResource | undefined;
    if (row.resource !== undefined) {
      const file = object(row.resource, ['url', 'sha256', 'bytes', 'format']);
      const formats = descriptor.kind === 'cheats' ? ['retroarch-cht'] : ['bps', 'ups', 'ips'];
      if (
        descriptor.kind === 'metadata' ||
        !formats.includes(String(file.format)) ||
        !sha256(file.sha256) ||
        !integer(
          file.bytes,
          descriptor.kind === 'cheats' ? HOSTED_CATALOG_LIMITS.cheats : HOSTED_CATALOG_LIMITS.patch,
          1,
        )
      )
        invalid();
      resource = {
        url: validateHostedCatalogUrl(file.url),
        sha256: file.sha256,
        bytes: file.bytes,
        format: file.format as HostedCatalogResource['format'],
      };
    }
    if (descriptor.kind !== 'metadata' && !resource) invalid();
    return {
      id: row.id,
      title: row.title,
      name: row.name,
      sourceIds: sourceIds(row.sourceIds, allowedSources),
      ...hashes,
      ...(row.systemId === undefined ? {} : { systemId: row.systemId as string }),
      ...(row.source === undefined ? {} : { source: row.source as string }),
      ...(row.size === undefined ? {} : { size: row.size as number }),
      ...(row.media === undefined ? {} : { media: row.media as 'rom' | 'disk' }),
      ...(row.aliases === undefined ? {} : { aliases: strings(row.aliases, 16, 512) }),
      ...(row.serials === undefined ? {} : { serials: strings(row.serials, 16, 160) }),
      ...(row.setIds === undefined ? {} : { setIds: strings(row.setIds, 16, 160) }),
      ...(row.metadata === undefined ? {} : { metadata }),
      ...(resource ? { resource } : {}),
    };
  });
  if (
    records.length !== descriptor.records ||
    new Set(records.map((record) => record.id)).size !== records.length
  )
    invalid();
  return {
    version: 1,
    release: index.release,
    kind: descriptor.kind,
    systemId: descriptor.systemId,
    records,
  };
}

function redirectedUrl(value: string, current: string): string {
  const url = new URL(value, current);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.href.length > 8192
  )
    invalid();
  if (['github.com', 'raw.githubusercontent.com'].includes(url.hostname))
    return validateHostedCatalogUrl(url.href);
  if (
    !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(
      url.hostname,
    )
  )
    invalid();
  return url.href;
}
function safeFetcher(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    let target = validateHostedCatalogUrl(String(input));
    const timeout = AbortSignal.timeout(8000);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      const response = await fetcher(target, {
        ...init,
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        signal,
        headers: { accept: 'application/json, application/octet-stream;q=0.9' },
      });
      if (response.redirected || (response.url && response.url !== target)) {
        await response.body?.cancel().catch(() => {});
        throw new Error('Unexpected hosted catalog redirect');
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location || redirects === 3) throw new Error('Too many hosted catalog redirects');
      target = redirectedUrl(location, target);
    }
    throw new Error('Hosted catalog unavailable');
  };
}
async function boundedBytes(
  response: Response,
  max: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Hosted resource unavailable');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await response.body.cancel().catch(() => {});
    throw new Error('Hosted resource too large');
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > max) throw new Error('Hosted resource too large');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total);
}
function verify(bytes: Uint8Array, expected: { bytes: number; sha256: string }): void {
  if (bytes.byteLength !== expected.bytes || digest(bytes) !== expected.sha256)
    throw new Error('Hosted catalog integrity mismatch');
}
interface ParsedShard {
  shard: HostedCatalogShard;
  identity: DatRecord[];
  match?: ReturnType<typeof createLibretroMatcher>;
  weight: number;
}
/** Immutable pinned public data only; no ROM bytes, paths, credentials or search terms are uploaded. */
export function createHostedCatalog(options: {
  pin: HostedCatalogPin | null;
  fetcher?: typeof fetch;
  cacheDirectory?: string;
}): HostedCatalogClient {
  const pin = options.pin === null ? null : validateHostedCatalogPin(options.pin);
  const fetcher = safeFetcher(options.fetcher ?? fetch);
  const loader = createCatalogLoader(fetcher, options.cacheDirectory);
  let manifest: HostedCatalogIndex | undefined,
    manifestPending: Promise<HostedCatalogIndex> | undefined;
  const parsed = new Map<string, ParsedShard>(),
    pending = new Map<string, Promise<ParsedShard>>();
  let parsedWeight = 0;
  const activeSystems = new Map<string, true>();
  const touchSystem = (systemId: string) => {
    activeSystems.delete(systemId);
    activeSystems.set(systemId, true);
  };
  function evictSystem(systemId: string) {
    for (const [key, entry] of parsed)
      if (entry.shard.systemId === systemId) {
        parsedWeight -= entry.weight;
        parsed.delete(key);
      }
    activeSystems.delete(systemId);
  }
  const providers: MatchingProvider[] = kinds.map((kind) => ({
    id: `org.ecs.catalog.${kind === 'patch' ? 'patches' : kind}`,
    name: {
      metadata: 'Hosted game metadata',
      cheats: 'Hosted cheat catalog',
      patch: 'Hosted patch catalog',
    }[kind],
    capabilities: [kind],
    network: true,
    search: (input, signal) => search(kind, input, signal),
  }));
  if (pin)
    for (const provider of providers)
      provider.name = `${provider.name} · ${pin.release}`.slice(0, 80);
  return { providers: () => [...providers], metadata, index, sync, resource };
  async function pinnedText(
    expected: { url: string; bytes: number; sha256: string },
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    if (options.cacheDirectory) {
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        // Public loader bodies are safe indefinitely when an immutable pin revalidates them.
        const name = createHash('sha256').update(expected.url).digest('hex');
        file = await open(
          join(options.cacheDirectory, `${name}.body`),
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        );
        const stat = await file.stat();
        if (stat.isFile() && stat.size === expected.bytes) {
          const bytes = Buffer.alloc(expected.bytes);
          let offset = 0;
          while (offset < bytes.length) {
            signal?.throwIfAborted();
            const part = await file.read(bytes, offset, bytes.length - offset, offset);
            if (!part.bytesRead) break;
            offset += part.bytesRead;
          }
          if (offset === bytes.length && digest(bytes) === expected.sha256) {
            signal?.throwIfAborted();
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          }
        }
      } catch {
        signal?.throwIfAborted();
      } finally {
        await file?.close().catch(() => {});
      }
    }
    const text = await loader.load(expected.url, signal, expected.bytes);
    if (text === null) throw new Error('Hosted catalog unavailable');
    verify(Buffer.from(text), expected);
    return text;
  }
  async function index(signal?: AbortSignal): Promise<HostedCatalogIndex> {
    signal?.throwIfAborted();
    if (!pin) throw new Error('Hosted catalog is not configured');
    if (manifest) return manifest;
    if (!manifestPending)
      manifestPending = (async () => {
        const text = await pinnedText(pin, signal);
        const value = validateHostedCatalogIndex(JSON.parse(text));
        if (value.release !== pin.release) throw new Error('Hosted catalog release mismatch');
        for (const source of value.sources) Object.freeze(source);
        for (const shard of value.shards) {
          Object.freeze(shard.sourceIds);
          Object.freeze(shard);
        }
        Object.freeze(value.sources);
        Object.freeze(value.shards);
        Object.freeze(value);
        manifest = value;
        return value;
      })();
    try {
      const value = await manifestPending;
      signal?.throwIfAborted();
      return value;
    } finally {
      manifestPending = undefined;
    }
  }
  async function shard(
    descriptor: HostedCatalogShardDescriptor,
    manifest: HostedCatalogIndex,
    signal?: AbortSignal,
  ): Promise<ParsedShard> {
    signal?.throwIfAborted();
    const key = `${descriptor.id}:${descriptor.sha256}`;
    const cached = parsed.get(key);
    if (cached) {
      parsed.delete(key);
      parsed.set(key, cached);
      touchSystem(cached.shard.systemId);
      return cached;
    }
    let loading = pending.get(key);
    if (!loading) {
      loading = (async () => {
        const text = await pinnedText(descriptor, signal);
        const value = validateHostedCatalogShard(JSON.parse(text), descriptor, manifest);
        const identity = value.records.map((record) => ({
          ...record,
          systemId: descriptor.systemId,
          source: record.sourceIds
            .map((id) => manifest.sources.find((source) => source.id === id)?.name ?? id)
            .join('; '),
        }));
        const entry: ParsedShard = {
          shard: value,
          identity,
          weight: text.length * 2 + value.records.length * 1024,
        };
        if (entry.weight <= 64 * 1024 * 1024) {
          parsed.set(key, entry);
          parsedWeight += entry.weight;
          touchSystem(entry.shard.systemId);
          while (activeSystems.size > 2) {
            const oldest = activeSystems.keys().next().value;
            if (oldest === undefined) break;
            evictSystem(oldest);
          }
          while (parsedWeight > 64 * 1024 * 1024) {
            if (activeSystems.size > 1) {
              const oldest = activeSystems.keys().next().value;
              if (oldest === undefined) break;
              evictSystem(oldest);
            } else {
              // A single oversized system can retain only its hottest bounded shards.
              const oldest = parsed.keys().next().value;
              if (oldest === undefined) break;
              parsedWeight -= parsed.get(oldest)?.weight ?? 0;
              parsed.delete(oldest);
            }
          }
        }
        return entry;
      })();
      pending.set(key, loading);
    }
    try {
      const value = await loading;
      signal?.throwIfAborted();
      return value;
    } finally {
      pending.delete(key);
    }
  }
  async function sync(
    options: { systemIds?: string[] } = {},
    signal?: AbortSignal,
  ): Promise<HostedCatalogSync> {
    if (
      options.systemIds !== undefined &&
      (!Array.isArray(options.systemIds) ||
        options.systemIds.length > 64 ||
        options.systemIds.some((value) => !system(value)))
    )
      invalid();
    const value = await index(signal),
      selected = value.shards.filter(
        (row) => !options.systemIds || options.systemIds.includes(row.systemId),
      );
    let records = 0;
    for (const descriptor of selected) {
      signal?.throwIfAborted();
      records += (await shard(descriptor, value, signal)).shard.records.length;
    }
    return { release: value.release, shards: selected.length, records };
  }
  async function resource(
    ref: HostedCatalogResourceRef,
    signal?: AbortSignal,
  ): Promise<HostedCatalogResourceReply> {
    const checked = object(ref, ['release', 'shardId', 'recordId']);
    if (!id(checked.release) || !id(checked.shardId) || !id(checked.recordId)) invalid();
    const value = await index(signal);
    if (checked.release !== value.release) throw new Error('Hosted catalog release changed');
    const descriptor = value.shards.find((row) => row.id === checked.shardId);
    if (!descriptor || descriptor.kind === 'metadata') throw new Error('Unknown hosted resource');
    const data = await shard(descriptor, value, signal),
      record = data.shard.records.find((row) => row.id === checked.recordId);
    if (!record?.resource) throw new Error('Unknown hosted resource');
    const bytes = await boundedBytes(
      await fetcher(record.resource.url, { signal }),
      record.resource.bytes,
      signal,
    );
    verify(bytes, record.resource);
    return {
      bytes,
      kind: descriptor.kind,
      format: record.resource.format,
      sha256: record.resource.sha256,
      release: value.release,
    };
  }
  async function metadata(
    input: MatchingInput,
    signal?: AbortSignal,
  ): Promise<MatchCandidate[] | null> {
    if (!pin || !input.systemId) return null;
    const value = await index(signal);
    if (!value.shards.some((row) => row.kind === 'metadata' && row.systemId === input.systemId))
      return null;
    return search('metadata', input, signal);
  }
  async function search(
    kind: HostedCatalogKind,
    input: MatchingInput,
    signal?: AbortSignal,
  ): Promise<MatchCandidate[]> {
    if (!pin || !input.online || !input.systemId) return [];
    const value = await index(signal),
      candidates: MatchCandidate[] = [];
    for (const descriptor of value.shards.filter(
      (row) => row.kind === kind && row.systemId === input.systemId,
    )) {
      const data = await shard(descriptor, value, signal);
      const indices = new Set<number>();
      data.match ??= createLibretroMatcher(data.identity);
      for (const candidate of data.match(input)) {
        const take = (id: unknown) => {
          if (typeof id === 'string' && /^dat-\d+$/.test(id)) indices.add(Number(id.slice(4)));
        };
        take(candidate.id);
        if (candidate.metadata.matchProvenance) {
          const original: unknown = JSON.parse(candidate.metadata.matchProvenance);
          if (Array.isArray(original))
            for (const row of original)
              if (row && typeof row === 'object' && 'id' in row) take(row.id);
        }
      }
      for (const index of indices) {
        const record = data.shard.records[index],
          identity = data.identity[index];
        if (!record || !identity) continue;
        const proof = matchLibretro(input, [identity])[0];
        if (!proof) continue;
        const metadata: Record<string, string> = {
          ...proof.metadata,
          catalogRelease: value.release,
          catalogShard: descriptor.id,
          catalogRecord: record.id,
          catalogSourceIds: JSON.stringify(record.sourceIds),
          ...(record.resource
            ? {
                resourceSha256: record.resource.sha256,
                resourceBytes: String(record.resource.bytes),
                format: record.resource.format,
              }
            : {}),
        };
        // Identity/resource proofs take precedence over optional descriptive fields.
        for (const [key, value] of Object.entries(record.metadata ?? {}))
          if (Object.keys(metadata).length < 24) metadata[key] = value;
        const candidate: MatchCandidate = {
          ...proof,
          id: `catalog-${digest(Buffer.from(`${descriptor.id}\0${record.id}`)).slice(0, 32)}`,
          kind,
          title: record.title,
          metadata,
          ...(record.resource ? { url: record.resource.url } : {}),
        };
        validateCandidates([candidate], [kind]);
        candidates.push(candidate);
        if (Buffer.byteLength(JSON.stringify(candidates)) > 96 * 1024) {
          candidates.pop();
          break;
        }
      }
      if (candidates.length >= 60) break;
    }
    return reconcileCandidates(input, candidates).slice(0, 60);
  }
}
