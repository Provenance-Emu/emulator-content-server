import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 10 * 60 * 1000;
const MAX_METADATA_BYTES = 4096;
const MAX_MEMORY_ENTRIES = 128;
const MAX_MEMORY_BYTES = 32 * 1024 * 1024;
interface CacheEntry {
  url: string;
  status: 200 | 404;
  storedAt: number;
  ttl: number;
  body: string;
  bytes: number;
}

interface DiskMetadata {
  version: 1;
  url: string;
  status: 200 | 404;
  storedAt: number;
  ttl: number;
  bytes: number;
  bodySha256: string | null;
}

export interface CatalogLoader {
  load(url: string, signal?: AbortSignal, maxBytes?: number): Promise<string | null>;
}

export function createCatalogLoader(
  fetcher: typeof fetch = fetch,
  cacheDirectory?: string,
): CatalogLoader {
  const memoryCache = new Map<string, CacheEntry>();
  let memoryBytes = 0;
  return { load: (url, signal, maxBytes = DEFAULT_MAX_BYTES) => load(url, signal, maxBytes) };

  async function load(
    url: string,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<string | null> {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new RangeError('maxBytes must be a non-negative safe integer');
    let parsed: URL;
    try {
      parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new TypeError('Catalog URL must be a public HTTP(S) URL without credentials');
      }
    } catch (error) {
      if (error instanceof TypeError && error.message.startsWith('Catalog URL')) throw error;
      throw new TypeError('Invalid catalog URL');
    }
    const normalizedUrl = parsed.href;
    const now = Date.now();
    const cached = memoryCache.get(normalizedUrl);
    if (cached && isFresh(cached, now) && cached.bytes <= maxBytes) {
      memoryCache.delete(normalizedUrl);
      memoryCache.set(normalizedUrl, cached);
      signal?.throwIfAborted();
      return cached.status === 200 ? cached.body : null;
    }

    if (cacheDirectory) {
      const disk = await readDisk(cacheDirectory, normalizedUrl, maxBytes, now);
      signal?.throwIfAborted();
      if (disk) {
        remember(normalizedUrl, disk);
        return disk.status === 200 ? disk.body : null;
      }
    }

    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetcher(normalizedUrl, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        signal,
        headers: { accept: 'text/plain, application/octet-stream;q=0.9, */*;q=0.1' },
      });
    } catch {
      signal?.throwIfAborted();
      throw new Error('Public catalog request failed');
    }
    if (signal?.aborted) {
      await response.body?.cancel().catch(() => {});
      signal.throwIfAborted();
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      const entry: CacheEntry = {
        url: normalizedUrl,
        status: 404,
        storedAt: Date.now(),
        ttl: NOT_FOUND_TTL_MS,
        body: '',
        bytes: 0,
      };
      remember(normalizedUrl, entry);
      if (cacheDirectory) await writeDisk(cacheDirectory, entry);
      signal?.throwIfAborted();
      return null;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Public catalog request returned HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw new Error('Public catalog response exceeds maxBytes');
    }
    const bytes = await readBounded(response, maxBytes, signal);
    signal?.throwIfAborted();
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const entry: CacheEntry = {
      url: normalizedUrl,
      status: 200,
      storedAt: Date.now(),
      ttl: SUCCESS_TTL_MS,
      body,
      bytes: bytes.byteLength,
    };
    remember(normalizedUrl, entry);
    if (cacheDirectory) await writeDisk(cacheDirectory, entry);
    signal?.throwIfAborted();
    return body;
  }

  function remember(url: string, entry: CacheEntry): void {
    memoryBytes -= (memoryCache.get(url)?.bytes ?? 0) * 2;
    memoryCache.delete(url);
    if (entry.bytes * 2 <= MAX_MEMORY_BYTES) {
      memoryCache.set(url, entry);
      memoryBytes += entry.bytes * 2;
    }
    while (memoryCache.size > MAX_MEMORY_ENTRIES || memoryBytes > MAX_MEMORY_BYTES) {
      const oldest = memoryCache.keys().next().value;
      if (oldest === undefined) break;
      memoryBytes -= (memoryCache.get(oldest)?.bytes ?? 0) * 2;
      memoryCache.delete(oldest);
    }
  }
}

function isFresh(entry: CacheEntry, now: number): boolean {
  return (
    Number.isFinite(entry.storedAt) &&
    Number.isFinite(entry.ttl) &&
    entry.storedAt <= now + 60_000 &&
    now - entry.storedAt < entry.ttl
  );
}

async function readBounded(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Public catalog response has no body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Public catalog response exceeds maxBytes');
      }
      chunks.push(value);
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function cachePaths(directory: string, url: string): { body: string; metadata: string } {
  const name = createHash('sha256').update(url).digest('hex');
  return { body: join(directory, `${name}.body`), metadata: join(directory, `${name}.json`) };
}

function noFollowFlag(): number {
  return constants.O_NOFOLLOW ?? 0;
}

async function readRegularFile(path: string, maxBytes: number): Promise<Buffer | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | noFollowFlag());
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) return null;
      offset += read.bytesRead;
    }
    return bytes;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readDisk(
  directory: string,
  url: string,
  maxBytes: number,
  now: number,
): Promise<CacheEntry | null> {
  try {
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory()) return null;
  } catch {
    return null;
  }
  const paths = cachePaths(directory, url);
  const rawMetadata = await readRegularFile(paths.metadata, MAX_METADATA_BYTES);
  if (!rawMetadata) return null;
  try {
    const metadata = JSON.parse(rawMetadata.toString('utf8')) as DiskMetadata;
    if (
      metadata.version !== 1 ||
      metadata.url !== url ||
      (metadata.status !== 200 && metadata.status !== 404) ||
      !Number.isSafeInteger(metadata.bytes) ||
      metadata.bytes < 0 ||
      metadata.bytes > maxBytes ||
      !Number.isSafeInteger(metadata.storedAt) ||
      metadata.storedAt > now + 60_000 ||
      (metadata.ttl !== SUCCESS_TTL_MS && metadata.ttl !== NOT_FOUND_TTL_MS) ||
      now - metadata.storedAt >= metadata.ttl ||
      (metadata.status === 404 && (metadata.bytes !== 0 || metadata.bodySha256 !== null)) ||
      (metadata.status === 200 && !/^[a-f0-9]{64}$/.test(metadata.bodySha256 ?? ''))
    )
      return null;
    const bodyBytes =
      metadata.status === 200 ? await readRegularFile(paths.body, maxBytes) : Buffer.alloc(0);
    if (
      !bodyBytes ||
      bodyBytes.byteLength !== metadata.bytes ||
      (metadata.status === 200 &&
        createHash('sha256').update(bodyBytes).digest('hex') !== metadata.bodySha256)
    )
      return null;
    return {
      url,
      status: metadata.status,
      storedAt: metadata.storedAt,
      ttl: metadata.ttl,
      body: new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes),
      bytes: metadata.bytes,
    };
  } catch {
    return null;
  }
}

async function writeDisk(directory: string, entry: CacheEntry): Promise<void> {
  const paths = cachePaths(directory, entry.url);
  const metadata: DiskMetadata = {
    version: 1,
    url: entry.url,
    status: entry.status,
    storedAt: entry.storedAt,
    ttl: entry.ttl,
    bytes: entry.bytes,
    bodySha256: entry.status === 200 ? createHash('sha256').update(entry.body).digest('hex') : null,
  };
  const metadataText = JSON.stringify(metadata);
  const files: Array<[string, string]> = [];
  if (entry.status === 200) files.push([paths.body, entry.body]);
  files.push([paths.metadata, metadataText]);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) return;
    for (const [destination, contents] of files) {
      const temporary = `${destination}.${randomUUID()}.tmp`;
      let handle: FileHandle | undefined;
      try {
        handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
          0o600,
        );
        await handle.writeFile(contents);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, destination);
      } finally {
        await handle?.close().catch(() => {});
        await unlink(temporary).catch(() => {});
      }
    }
  } catch {
    // Cache persistence is best-effort; a public fetch remains usable without it.
  }
}
