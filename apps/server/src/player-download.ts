import { createHash } from 'node:crypto';
import { DomainError } from '@ecs/domain';
import { PLAYER_PACKAGE_LIMIT, parseManifest, parsePlayerPackage } from '@ecs/plugins';
import type { TrustedPlayer } from './player-catalog.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Download only server-curated, byte-pinned software. Never accepts a client URL. */
export async function downloadCatalogPlayer(entry: TrustedPlayer): Promise<Buffer> {
  if (!entry.available)
    throw new DomainError('not-found', 404, 'This emulator is not available to install yet');
  if (entry.upstream) {
    const { resources } = entry.upstream;
    const manifest = parseManifest(entry.upstream.manifest);
    const web = manifest.player?.web;
    if (!web || manifest.id !== entry.id || manifest.entry)
      throw new DomainError('invalid-request', 400, 'Invalid upstream emulator manifest');
    const specs = [web.loader, web.wasm, ...web.assets];
    if (resources.length !== specs.length)
      throw new DomainError('invalid-request', 400, 'Invalid upstream resource table');
    let total = 0;
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i],
        resource = resources[i];
      if (!spec || !resource)
        throw new DomainError('invalid-request', 400, 'Invalid upstream resource table');
      const cap = (i === 0 ? 8 : i === 1 ? 64 : 32) * 1024 * 1024;
      if (
        resource.file !== spec.file ||
        resource.sha256 !== spec.sha256 ||
        !Number.isSafeInteger(resource.sizeBytes) ||
        resource.sizeBytes < 1 ||
        resource.sizeBytes > cap
      )
        throw new DomainError('invalid-request', 400, 'Invalid upstream emulator resource');
      total += resource.sizeBytes;
    }
    if (total > PLAYER_PACKAGE_LIMIT - 65540 || total !== entry.downloadBytes)
      throw new DomainError('invalid-request', 400, 'Invalid upstream emulator size');
    const files: Buffer[] = [];
    for (const resource of resources) {
      const bytes = await downloadPlayer(resource.url, resource.sizeBytes, 'upstream');
      if (hash(bytes) !== resource.sha256)
        throw new DomainError('invalid-request', 400, 'Emulator download checksum mismatch');
      files.push(bytes);
    }
    const header = Buffer.from(
      JSON.stringify({
        manifest,
        files: resources.map((resource) => ({ name: resource.file, size: resource.sizeBytes })),
      }),
    );
    if (header.length > 65536)
      throw new DomainError('invalid-request', 400, 'Emulator header exceeds limit');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(header.length);
    const bytes = Buffer.concat([prefix, header, ...files]);
    parsePlayerPackage(bytes);
    return bytes;
  }
  if (!entry.url || !entry.sha256)
    throw new DomainError('not-found', 404, 'This emulator is not available to install yet');
  const bytes = await downloadPlayer(entry.url, entry.downloadBytes ?? 0, 'package');
  if (hash(bytes) !== entry.sha256)
    throw new DomainError('invalid-request', 400, 'Emulator download checksum mismatch');
  if (parsePlayerPackage(bytes).manifest.id !== entry.id)
    throw new DomainError('invalid-request', 400, 'Emulator download identifier mismatch');
  return bytes;
}

async function downloadPlayer(
  initial: string,
  size: number,
  source: 'package' | 'upstream',
): Promise<Buffer> {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 120000);
  try {
    if (!Number.isSafeInteger(size) || size < 1 || size > PLAYER_PACKAGE_LIMIT)
      throw new Error('Invalid size');
    let url = initial;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const parsed = new URL(url);
      const trusted =
        source === 'upstream'
          ? parsed.hostname === 'web.libretro.com' &&
            /^\/[a-z0-9_]+_libretro\.(?:js|wasm)$/.test(parsed.pathname) &&
            !parsed.search
          : ['github.com', 'release-assets.githubusercontent.com'].includes(parsed.hostname);
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.port ||
        parsed.hash ||
        !trusted
      )
        throw new Error('Untrusted emulator download');
      const response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'application/octet-stream' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Error('Missing download location');
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok || !response.body) throw new Error('Emulator download unavailable');
      const chunks: Buffer[] = [];
      let total = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > size) {
            await reader.cancel();
            throw new Error('Emulator download exceeds limit');
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      if (total !== size) throw new Error('Incomplete emulator download');
      return Buffer.concat(chunks, total);
    }
    throw new Error('Too many redirects');
  } catch {
    throw new DomainError(
      'invalid-request',
      400,
      'Emulator download failed; retry later or install a verified package file',
    );
  } finally {
    clearTimeout(timer);
  }
}
