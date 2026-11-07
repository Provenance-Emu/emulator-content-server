import { createHash } from 'node:crypto';
import { DomainError } from '@ecs/domain';
import { PLAYER_PACKAGE_LIMIT, parseManifest, parsePlayerPackage } from '@ecs/plugins';
import type { TrustedPlayer } from './player-catalog.js';
import { catalogJson } from './player-catalog-snapshot.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Shared by network redirects and operator-selected catalog validation. */
function assertDownloadUrl(url: string, source: 'package' | 'upstream') {
  const parsed = new URL(url);
  const trusted =
    source === 'upstream'
      ? parsed.hostname === 'web.libretro.com' &&
        /^\/[A-Za-z0-9_]+_libretro\.(?:js|wasm)$/.test(parsed.pathname) &&
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
}

/** Validate complete data-only descriptors without downloading or executing software. */
export function validateCatalogPlayerDescriptor(entry: TrustedPlayer): void {
  if (entry.upstream) {
    if (entry.url !== null || entry.sha256 !== null) throw new Error('Ambiguous player source');
    const { manifest, resources } = checkedUpstream(entry);
    if (catalogJson(manifest.player?.systems) !== catalogJson(entry.systems))
      throw new Error('Player systems do not match the manifest');
    for (const resource of resources) assertDownloadUrl(resource.url, 'upstream');
  } else if (entry.url !== null || entry.sha256 !== null || entry.available) {
    if (
      !entry.url ||
      !entry.sha256 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.downloadBytes) ||
      (entry.downloadBytes ?? 0) < 1 ||
      (entry.downloadBytes ?? 0) > PLAYER_PACKAGE_LIMIT
    )
      throw new Error('Invalid player package pin');
    assertDownloadUrl(entry.url, 'package');
  } else if (entry.downloadBytes !== null)
    throw new Error('Unavailable player has no download source');
}

/** Download only server-curated, byte-pinned software. Never accepts a client URL. */
export async function downloadCatalogPlayer(entry: TrustedPlayer): Promise<Buffer> {
  if (!entry.available)
    throw new DomainError('not-found', 404, 'This emulator is not available to install yet');
  if (entry.upstream) {
    const { resources } = checkedUpstream(entry);
    const files: Buffer[] = [];
    for (const resource of resources) {
      const bytes = await downloadPlayer(resource.url, resource.sizeBytes, 'upstream');
      if (hash(bytes) !== resource.sha256)
        throw new DomainError('invalid-request', 400, 'Emulator download checksum mismatch');
      files.push(bytes);
    }
    return buildUpstreamPlayerPackage(entry, files);
  }
  if (!entry.url || !entry.sha256)
    throw new DomainError('not-found', 404, 'This emulator is not available to install yet');
  const bytes = await downloadPlayer(entry.url, entry.downloadBytes ?? 0, 'package');
  verifyCatalogPlayerPackage(entry, bytes);
  return bytes;
}

/** Assemble only catalog-pinned resource bytes, including recovered official archive members. */
export function buildUpstreamPlayerPackage(entry: TrustedPlayer, files: Buffer[]): Buffer {
  const { manifest, resources } = checkedUpstream(entry);
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
  verifyCatalogPlayerPackage(entry, bytes);
  return bytes;
}

/** Validate cached bytes against trusted metadata, never the cached header alone. */
export function verifyCatalogPlayerPackage(entry: TrustedPlayer, bytes: Buffer): void {
  try {
    validateCatalogPlayerPackage(entry, bytes);
  } catch {
    throw new DomainError(
      'invalid-request',
      400,
      'Emulator package does not match its catalog snapshot',
    );
  }
}

function validateCatalogPlayerPackage(entry: TrustedPlayer, bytes: Buffer): void {
  if (!entry.available) throw new Error('Emulator is unavailable');
  const parsed = parsePlayerPackage(bytes);
  if (parsed.manifest.id !== entry.id) throw new Error('Emulator download identifier mismatch');
  if (!entry.upstream) {
    if (
      !entry.url ||
      !entry.sha256 ||
      bytes.length !== entry.downloadBytes ||
      hash(bytes) !== entry.sha256
    )
      throw new Error('Emulator download checksum mismatch');
    return;
  }
  const { manifest, resources } = checkedUpstream(entry);
  if (catalogJson(parsed.manifest) !== catalogJson(manifest))
    throw new Error('Emulator manifest does not match catalog snapshot');
  for (const resource of resources) {
    const file = parsed.files.get(resource.file);
    if (!file || file.length !== resource.sizeBytes || hash(file) !== resource.sha256)
      throw new Error('Emulator resource does not match catalog snapshot');
  }
}

function checkedUpstream(entry: TrustedPlayer) {
  if (!entry.upstream) throw new Error('Upstream descriptor required');
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
  return { manifest, resources };
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
      assertDownloadUrl(url, source);
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
      if (!response.ok || !response.body)
        throw new DomainError(
          'invalid-request',
          400,
          `Emulator download is unavailable (HTTP ${response.status})`,
        );
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
            throw new DomainError(
              'invalid-request',
              400,
              'The upstream emulator download changed and does not match its pinned size. Its replacement was not installed.',
            );
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      if (total !== size)
        throw new DomainError(
          'invalid-request',
          400,
          'The upstream emulator download was incomplete or changed its pinned size. Refresh emulators and retry.',
        );
      return Buffer.concat(chunks, total);
    }
    throw new Error('Too many redirects');
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (controller.signal.aborted)
      throw new DomainError(
        'invalid-request',
        400,
        'The emulator download timed out. Refresh emulators and retry.',
      );
    throw new DomainError(
      'invalid-request',
      400,
      'Emulator download failed; retry later or install a verified package file',
    );
  } finally {
    clearTimeout(timer);
  }
}
