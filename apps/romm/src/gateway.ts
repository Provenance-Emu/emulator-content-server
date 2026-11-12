import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type {
  CompanionList,
  LibraryBrowseEntry,
  LibraryBrowsePage,
  LibraryList,
  Manifest,
  SourceGroup,
} from '@ecs/client';
import { PROVENANCE_SYSTEMS, validateSystemIdentifier } from '@ecs/protocol';
import { streamZip } from '@ecs/storage';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { IdIndex, type IndexEntry } from './ids.js';
import { type DownloadMember, manicPlaylist } from './playlist.js';
import { GatewayError, parseOrigin, readable, Upstream } from './upstream.js';

function platform(system: string, name = system) {
  return {
    system,
    name,
    slug: system.split('.').at(-1) ?? system,
    // Independent of catalogue population, listing order and process restarts.
    id: createHash('sha256').update(system).digest().readUIntBE(0, 6),
  };
}

const platforms = PROVENANCE_SYSTEMS.map((system) => platform(system.identifier, system.name));
const bySystem = new Map(platforms.map((platform) => [platform.system, platform]));
const byPlatform = new Map(platforms.map((platform) => [platform.id, platform.system]));
if (byPlatform.size !== platforms.length) throw new Error('Duplicate platform IDs');

interface Rom {
  id: number;
  name: string;
  fs_name: string;
  fs_size_bytes?: number;
  platform_id: number;
  platform_slug: string;
  platform_display_name: string;
  path_cover_large?: string;
}

interface Download {
  rom: Rom;
  path?: string;
  archive: boolean;
  members?: DownloadMember[];
  cover?: string;
}

function number(value: unknown, fallback: number, max: number, min = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new GatewayError(400, 'Invalid numeric parameter.');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new GatewayError(400, 'Numeric parameter out of range.');
  return n;
}

function filename(value: string): string {
  const name = posix
    .basename(value)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Exclude controls from download filenames.
    .replace(/[\\\x00-\x1f\x7f:]/g, '_')
    .trim();
  if (!name || name === '.' || name === '..') return 'Game';
  return name;
}

function archiveName(name: string): string {
  // Manic treats ZIPs named after known arcade sets as cartridge files.
  if (/\.zip$/i.test(name)) return `${filename(name).slice(0, -4)} (ROM set).zip`;
  return `${filename(name).replace(/\.(m3u8?|cue|gdi|ccd|mds|toc|zip|7z)$/i, '') || 'Game'}.zip`;
}

function rom(entry: IndexEntry, name: string, size?: number): Rom {
  const system = bySystem.get(entry.system) ?? platform(entry.system);
  return {
    id: entry.id,
    name: entry.title,
    fs_name: filename(name),
    ...(size === undefined ? {} : { fs_size_bytes: size }),
    platform_id: system.id,
    platform_slug: system.slug,
    platform_display_name: system.name,
    ...(entry.artwork ? { path_cover_large: `/assets/romm/ecs/${entry.id}/cover` } : {}),
  };
}

function sourcePath(id: string, suffix: string): string {
  return `sources/${encodeURIComponent(id)}/${suffix}`;
}

function assetPath(id: string): string {
  return `files/${encodeURIComponent(id)}/content`;
}

async function libraryIds(ecs: Upstream): Promise<string[]> {
  return (await ecs.json<LibraryList>('browse-libraries')).items
    .map((library) => library.id)
    .sort();
}

async function visiblePlatforms(ecs: Upstream, libraries: string[]) {
  const counts = new Map<string, number>();
  for (const libraryId of libraries) {
    const params = new URLSearchParams({ libraryId, category: 'games', limit: '1' });
    const page = await ecs.json<LibraryBrowsePage>(`browse?${params}`);
    for (const entry of page.systemCounts ?? []) {
      if (!validateSystemIdentifier(entry.systemId))
        counts.set(entry.systemId, (counts.get(entry.systemId) ?? 0) + entry.count);
    }
  }
  const extras = [...counts.keys()].filter((system) => !bySystem.has(system)).sort();
  const usedIds = new Set(byPlatform.keys());
  return [...platforms, ...extras.map((system) => platform(system))].flatMap((entry) => {
    const count = counts.get(entry.system);
    if (!count) return [];
    if (usedIds.has(entry.id) && byPlatform.get(entry.id) !== entry.system)
      throw new GatewayError(502, 'Duplicate platform IDs.');
    usedIds.add(entry.id);
    return [{ ...entry, rom_count: count }];
  });
}

async function resolve(ecs: Upstream, entry: IndexEntry): Promise<Download> {
  if (entry.kind === 'source') {
    const group = await ecs.json<SourceGroup>(sourcePath(entry.ecsId, 'group'));
    const primary = group.files[0];
    if (
      group.error ||
      group.sourceId !== entry.ecsId ||
      primary?.id !== entry.ecsId ||
      group.files.some((file) => file.availability !== 'local')
    )
      throw new GatewayError(409, 'The game set is incomplete or unavailable.');
    const archive = group.files.length > 1;
    return {
      rom: rom(
        entry,
        archive ? archiveName(primary.name) : primary.name,
        archive ? undefined : primary.size,
      ),
      path: sourcePath(entry.ecsId, archive ? 'bundle' : 'content'),
      archive,
      ...(archive && /\.m3u$/i.test(primary.name)
        ? {
            members: group.files.map((file) => ({
              name: file.relativePath ?? file.name,
              path: sourcePath(file.id, 'content'),
              size: file.size,
            })),
          }
        : {}),
      ...(entry.artwork
        ? { cover: sourcePath(entry.ecsId, 'matches/selections/artwork/content') }
        : {}),
    };
  }
  const id = encodeURIComponent(entry.ecsId);
  const manifest = await ecs.json<Manifest>(`items/${id}/manifest`);
  const files = manifest.files.filter((file) => file.kind === 'rom');
  const first = files[0];
  if (
    manifest.itemId !== entry.ecsId ||
    !first ||
    files.length > 512 ||
    manifest.files.some((file) => file.required && file.kind !== 'rom')
  )
    throw new GatewayError(409, 'The game has no compatible ROM download.');
  const artwork = manifest.files.find((file) => file.kind === 'artwork');
  const cover = artwork ? assetPath(artwork.id) : undefined;
  const archive = files.length > 1;
  return {
    rom: rom(
      { ...entry, artwork: Number(Boolean(cover)) },
      archive ? archiveName(entry.title) : first.relativePath,
      archive ? undefined : first.size,
    ),
    archive,
    ...(archive
      ? {
          members: files.map((file) => ({
            name: file.relativePath,
            path: assetPath(file.id),
            size: file.size,
          })),
        }
      : { path: assetPath(first.id) }),
    cover,
  };
}

async function browseRom(
  ecs: Upstream,
  index: IdIndex,
  row: LibraryBrowseEntry,
): Promise<Rom | null> {
  if (!row.systemId || validateSystemIdentifier(row.systemId)) return null;
  const common = { ecsId: row.id, system: row.systemId, title: row.name };
  if (row.entityType === 'source' && row.source) {
    const source = row.source;
    if (source.availability !== 'local' || source.groupError) return null;
    const archive = (source.groupFileCount ?? 0) > 1;
    const entry = index.assign({
      ...common,
      kind: 'source',
      artwork: Number(Boolean(source.artworkAvailable)),
    });
    return rom(
      entry,
      archive ? archiveName(source.name) : source.name,
      archive ? undefined : source.size,
    );
  }
  if (row.entityType === 'item') {
    const summary = row.romDownload;
    if (
      summary &&
      (summary.romFileCount < 1 || summary.romFileCount > 512 || summary.requiresSystemFiles)
    )
      return null;
    const entry = index.assign({
      ...common,
      kind: 'item',
      artwork: Number(Boolean(row.previewAsset)),
    });
    if (summary) {
      if (summary.romFileCount > 1) return rom(entry, archiveName(entry.title));
      if (summary.filename !== undefined) return rom(entry, summary.filename, summary.sizeBytes);
    }
    try {
      return (await resolve(ecs, entry)).rom;
    } catch (error) {
      if (error instanceof GatewayError && [403, 404, 409].includes(error.status)) return null;
      throw error;
    }
  }
  return null;
}

function rangeHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const name of ['range', 'if-range', 'if-none-match', 'if-modified-since']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  return headers;
}

async function relay(
  ecs: Upstream,
  path: string,
  request: FastifyRequest,
  reply: FastifyReply,
  options: { archive?: boolean; revalidate?: boolean } = {},
) {
  const head = request.method === 'HEAD';
  const response = await ecs.get(path, {
    head,
    headers: options.archive ? undefined : rangeHeaders(request),
  });
  if (!response.ok && ![304, 416].includes(response.status)) await ecs.reject(response);
  if (options.revalidate && (response.ok || response.status === 304))
    reply.header('cache-control', 'private, no-cache');
  reply.code(response.status);
  for (const name of ['content-type', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = response.headers.get(name);
    if (value) reply.header(name, value);
  }
  if (response.status === 416) {
    await response.body?.cancel();
    return reply.send();
  }
  const size = response.headers.get('content-length');
  if (size) reply.header('content-length', size);
  if (head || response.status === 304) {
    await response.body?.cancel();
    return reply.send();
  }
  return reply.send(readable(response));
}

export function openGateway(options: { origin: string; indexPath: string }) {
  const origin = parseOrigin(options.origin);
  const index = new IdIndex(options.indexPath, origin.origin);
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 1024 } });
  app.addHook('onClose', async () => index.close());
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof GatewayError ? error.status : 502;
    if (status === 401) reply.header('www-authenticate', 'Bearer');
    return reply
      .code(status)
      .send({ detail: error instanceof GatewayError ? error.message : 'Gateway request failed.' });
  });
  app.get('/health', async () => ({ status: 'ok', service: 'ecs-romm-gateway' }));
  app.get('/api/platforms', async (request, reply) => {
    const ecs = new Upstream(origin, request, reply);
    return (await visiblePlatforms(ecs, await libraryIds(ecs))).map(({ system, ...entry }) => ({
      ...entry,
      ecs_system_id: system,
    }));
  });
  app.get('/api/roms', async (request, reply) => {
    const ecs = new Upstream(origin, request, reply);
    const query = request.query as Record<string, unknown>;
    const limit = number(query.limit, 50, 250, 1);
    const offset = number(query.offset, 0, 100_000);
    const search = query.search_term ?? '';
    if (typeof search !== 'string' || [...search].length > 256)
      throw new GatewayError(400, 'Invalid search term.');
    const raw = query.platform_ids ?? query.platform_id;
    const platformIds =
      raw === undefined
        ? null
        : [
            ...new Set(
              (Array.isArray(raw) ? raw : [raw]).flatMap((value) => {
                if (typeof value !== 'string')
                  throw new GatewayError(400, 'Invalid platform selection.');
                return value.split(',').map((part) => number(part, 0, Number.MAX_SAFE_INTEGER, 1));
              }),
            ),
          ];
    if (platformIds && platformIds.length > 100) throw new GatewayError(400, 'Too many platforms.');
    const libraries = await libraryIds(ecs);
    const visible = platformIds?.some((id) => !byPlatform.has(id))
      ? new Map((await visiblePlatforms(ecs, libraries)).map(({ id, system }) => [id, system]))
      : undefined;
    const systems = platformIds?.flatMap((id) => {
      const system = byPlatform.get(id) ?? visible?.get(id);
      return system ? [system] : [];
    });
    if (systems?.length === 0) return { items: [], limit, offset, total: 0 };
    const items: Rom[] = [];
    let seen = 0;
    for (const libraryId of libraries) {
      const params = new URLSearchParams({
        libraryId,
        category: 'games',
        search,
        limit: String(Math.min(100, offset + limit + 1)),
        includeRomDownload: 'true',
      });
      if (systems) params.set('systemIds', systems.join(','));
      const cursors = new Set<string>();
      for (;;) {
        const page = await ecs.json<LibraryBrowsePage>(`browse?${params}`);
        for (const row of page.items) {
          const entry = await browseRom(ecs, index, row);
          if (!entry || seen++ < offset) continue;
          // Manic reads until a short page. One extra result proves there is another page.
          if (items.length === limit) return { items, limit, offset };
          items.push(entry);
        }
        if (!page.nextCursor) break;
        if (cursors.has(page.nextCursor))
          throw new GatewayError(502, 'Emulation Server repeated a page.');
        cursors.add(page.nextCursor);
        params.set('cursor', page.nextCursor);
      }
    }
    return { items, limit, offset, total: seen };
  });
  const game = (ecs: Upstream, id: unknown) =>
    resolve(ecs, index.find(number(id, 0, Number.MAX_SAFE_INTEGER, 1)));
  app.get('/api/roms/:id/ecs-companions', async (request, reply) => {
    const ecs = new Upstream(origin, request, reply);
    const { id } = request.params as { id: string };
    const entry = index.find(number(id, 0, Number.MAX_SAFE_INTEGER, 1));
    const prefix = entry.kind === 'source' ? 'sources' : 'items';
    const companions = await ecs.json<CompanionList>(
      `${prefix}/${encodeURIComponent(entry.ecsId)}/companions`,
    );
    return {
      supportedKinds: companions.supportedKinds,
      items: companions.items.map((item) => ({
        ...item,
        contentPath: `/api/roms/${entry.id}/ecs-companions/${encodeURIComponent(item.id)}/content`,
      })),
    };
  });
  app.get('/api/roms/:id/ecs-companions/:companionId/content', async (request, reply) => {
    const ecs = new Upstream(origin, request, reply);
    const { id, companionId } = request.params as { id: string; companionId: string };
    const entry = index.find(number(id, 0, Number.MAX_SAFE_INTEGER, 1));
    if (entry.kind !== 'source' || !/^[a-f0-9]{64}$/.test(companionId))
      throw new GatewayError(404, 'Companion is not available.');
    return relay(
      ecs,
      sourcePath(entry.ecsId, `companions/${companionId}/content`),
      request,
      reply,
      { revalidate: true },
    );
  });
  app.get(
    '/api/roms/:id',
    async (request, reply) =>
      (await game(new Upstream(origin, request, reply), (request.params as { id: string }).id)).rom,
  );
  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/roms/:id/content/:name',
    async handler(request, reply) {
      const ecs = new Upstream(origin, request, reply);
      const { id, name } = request.params as { id: string; name: string };
      const download = await game(ecs, id);
      if (name !== download.rom.fs_name) throw new GatewayError(404, 'ROM filename not found.');
      reply.header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
      // The upstream bundle's implicit HEAD drains the ZIP stream. Use the authorized group metadata.
      if (download.archive && request.method === 'HEAD')
        return reply.type('application/zip').header('accept-ranges', 'none').send();
      const open = async (file: DownloadMember) => {
        const response = await ecs.get(file.path);
        if (!response.ok) await ecs.reject(response);
        return readable(response);
      };
      const members = download.members;
      const playlist = members ? await manicPlaylist(ecs, members, open) : null;
      if (download.path && !playlist)
        return relay(ecs, download.path, request, reply, { archive: download.archive });
      reply.type('application/zip').header('accept-ranges', 'none');
      return reply.send(
        streamZip(
          playlist ??
            (members ?? []).map((file) => ({
              name: file.name,
              size: file.size,
              open: () => open(file),
            })),
        ),
      );
    },
  });
  app.route({
    method: ['GET', 'HEAD'],
    url: '/assets/romm/ecs/:id/cover',
    async handler(request, reply) {
      const ecs = new Upstream(origin, request, reply);
      const { id } = request.params as { id: string };
      const entry = index.find(number(id, 0, Number.MAX_SAFE_INTEGER, 1));
      const cover =
        entry.kind === 'source'
          ? sourcePath(entry.ecsId, 'matches/selections/artwork/content')
          : (await resolve(ecs, entry)).cover;
      if (!cover) throw new GatewayError(404, 'Artwork not found.');
      return relay(ecs, cover, request, reply, { revalidate: true });
    },
  });
  // Manic requests these during import even when no saves exist. Write methods remain absent.
  for (const path of ['/api/saves', '/api/states', '/api/play-sessions']) {
    app.get(path, async (request, reply) => {
      const ecs = new Upstream(origin, request, reply);
      await game(ecs, (request.query as { rom_id?: string }).rom_id);
      return [];
    });
  }
  return app;
}
