import { extname } from 'node:path';
import { type Actor, DomainError } from '@ecs/domain';
import { probeRoot } from '@ecs/storage';
import type { FastifyInstance } from 'fastify';
import { blobRoot, storedBlob } from './content.js';
import type { ServerContext } from './context.js';
import { assetDecision, itemDecision, jsonObject, requireActor, requireOwner } from './http.js';
import { localSource, visibleSource } from './source-groups.js';

interface Copy {
  id: string;
  kind: 'asset' | 'source';
  name: string;
  format: string;
  sizeBytes: number;
  contentPath: string;
  availability: 'local' | 'evicted' | 'offline';
  medium: 'internal' | 'removable' | 'network' | 'icloud' | 'unknown';
  grouped: boolean;
}
const extension = (name: string) => extname(name).slice(1).toLowerCase();

function capabilities(input: unknown) {
  if (!Array.isArray(input) || input.length > 100)
    throw new DomainError('invalid-body', 400, 'Expected up to 100 supported systems');
  const systems = new Map<string, string[]>();
  for (const entry of input) {
    const { systemId, formats } = jsonObject(entry);
    if (
      typeof systemId !== 'string' ||
      systemId.length > 120 ||
      !/^[A-Za-z0-9]+(?:\.[A-Za-z0-9_-]+)+$/.test(systemId) ||
      systems.has(systemId) ||
      !Array.isArray(formats) ||
      formats.length > 32 ||
      formats.some((value: unknown) => typeof value !== 'string' || !/^[a-z0-9]{1,16}$/.test(value))
    )
      throw new DomainError('invalid-body', 400, 'Invalid system or format preferences');
    systems.set(systemId, [...new Set(formats)] as string[]);
  }
  return systems;
}

async function copies(context: ServerContext, actor: Actor, itemId: string, refresh: boolean) {
  const { catalog } = context;
  const item = catalog.getItem(itemId);
  if (!item) throw new DomainError('not-found', 404, 'Game not found');
  itemDecision(catalog, actor, item, 'read');
  const results: Copy[] = [];
  const media = (catalog.manifest(itemId)?.files ?? []).filter((file) => file.kind === 'rom');
  const hasDescriptor = media.some((file) =>
    /\.(cue|gdi|m3u|ccd|mds|toc)$/i.test(file.relativePath),
  );
  for (const file of media) {
    const format = extension(file.relativePath);
    // Uploaded descriptor sets use the existing manifest flow. Individual tracks are not copies.
    if (
      !format ||
      ['cue', 'gdi', 'm3u', 'ccd', 'mds', 'toc'].includes(format) ||
      (hasDescriptor && ['bin', 'img', 'raw', 'wav', 'mdf', 'iso'].includes(format)) ||
      (media.length > 1 && /(?:\(|[ ._-])(?:disc|disk|cd)[ ._-]*\d/i.test(file.relativePath))
    )
      continue;
    try {
      assetDecision(catalog, actor, item, file, 'read');
    } catch (error) {
      if (error instanceof DomainError) continue;
      throw error;
    }
    let availability: Copy['availability'] = 'local';
    let medium: Copy['medium'] = 'internal';
    if (refresh) {
      try {
        await storedBlob(context, file.sha256);
        medium = (await probeRoot(await blobRoot(context, file.sha256))).medium;
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        availability = 'offline';
      }
    }
    results.push({
      id: file.id,
      kind: 'asset',
      name: file.displayName,
      format,
      sizeBytes: file.size,
      contentPath: `/api/v1/files/${file.id}/content`,
      availability,
      medium,
      grouped: false,
    });
  }
  for (const indexed of catalog.gameSourceCopies(itemId)) {
    if (indexed.systemId !== item.systemIdentifier) continue;
    let source: ReturnType<typeof visibleSource>;
    try {
      source = visibleSource(context, actor, indexed.id);
    } catch (error) {
      if (error instanceof DomainError) continue;
      throw error;
    }
    const format = extension(source.relativePath);
    if (!format) continue;
    let availability = source.availability;
    let sizeBytes = source.size;
    const root = catalog.getContentRoot(source.rootId);
    let medium: Copy['medium'] =
      ((root && catalog.contentRootMedium(root.id)) as Copy['medium']) ?? 'unknown';
    const members = source.groupMembers?.length ? catalog.sourceGroup(source.id) : [source];
    if (refresh) {
      try {
        const live = await localSource(context, actor, source.id);
        sizeBytes = live.source.size;
        availability = 'local';
        medium = (await probeRoot(live.root.path)).medium;
        for (const member of members) {
          if (member.id !== source.id) await localSource(context, actor, member.id);
        }
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        availability = error.code === 'source-evicted' ? 'evicted' : 'offline';
      }
    }
    if (source.groupError || (source.groupMembers?.length ?? 0) > members.length)
      availability = 'offline';
    const grouped = members.length > 1;
    if (grouped)
      sizeBytes += members
        .filter((member) => member.id !== source.id)
        .reduce((sum, member) => sum + member.size, 0);
    results.push({
      id: source.id,
      kind: 'source',
      name: source.displayName,
      format,
      sizeBytes,
      contentPath: `/api/v1/sources/${source.id}/${grouped ? 'bundle' : 'content'}`,
      availability,
      medium,
      grouped,
    });
  }
  return { systemId: item.systemIdentifier, items: results };
}

export function registerGameCopies(app: FastifyInstance, context: ServerContext) {
  const itemId = (params: unknown) => (params as { itemId: string }).itemId;
  app.get('/api/v1/items/:itemId/rom-copies', async (request) =>
    copies(context, requireActor(request), itemId(request.params), false),
  );
  app.post('/api/v1/items/:itemId/rom-selection', async (request) => {
    const actor = requireActor(request);
    const { systems, maxBytes, allowDiscBundles } = jsonObject(request.body);
    const supported = capabilities(systems);
    if (allowDiscBundles !== undefined && typeof allowDiscBundles !== 'boolean')
      throw new DomainError('invalid-body', 400, 'Invalid disc bundle preference');
    if (
      maxBytes !== undefined &&
      (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    )
      throw new DomainError('invalid-body', 400, 'Invalid maximum ROM size');
    const { systemId, items } = await copies(context, actor, itemId(request.params), true);
    const order = supported.get(systemId) ?? [];
    const location = (copy: Copy) => Number(copy.medium === 'network' || copy.medium === 'icloud');
    const result = items
      .filter(
        (copy) =>
          (allowDiscBundles === true || !copy.grouped) &&
          copy.availability === 'local' &&
          copy.sizeBytes > 0 &&
          order.includes(copy.format) &&
          (maxBytes === undefined || copy.sizeBytes <= maxBytes),
      )
      .sort(
        (a, b) =>
          location(a) - location(b) ||
          order.indexOf(a.format) - order.indexOf(b.format) ||
          a.sizeBytes - b.sizeBytes ||
          a.id.localeCompare(b.id),
      );
    return { systemId, copy: result[0] };
  });
  app.put('/api/v1/sources/:sourceId/game', async (request) => {
    const actor = requireOwner(request, 'Only the server owner can link game copies');
    const source = visibleSource(context, actor, (request.params as { sourceId: string }).sourceId);
    const { itemId, title } = jsonObject(request.body);
    if (itemId === null || typeof itemId === 'string') {
      context.catalog.linkGameSource(source.id, itemId, actor.userId);
      return { itemId };
    }
    if (
      itemId !== undefined ||
      typeof title !== 'string' ||
      !title.trim() ||
      title.length > 256 ||
      !source.libraryId ||
      !source.systemId ||
      source.kind !== 'rom' ||
      source.groupAnchor
    )
      throw new DomainError('invalid-body', 400, 'Choose a game or supply a title for a new game');
    const existing = context.catalog.gameForSource(source.id);
    if (existing?.libraryId === source.libraryId && existing.systemIdentifier === source.systemId)
      return { itemId: existing.id };
    const game = context.catalog.createItem({
      libraryId: source.libraryId,
      systemIdentifier: source.systemId,
      title: title.trim(),
      md5: null,
      crc: null,
      actorId: actor.userId,
      sourceId: source.id,
    });
    return { itemId: game.id };
  });
}
