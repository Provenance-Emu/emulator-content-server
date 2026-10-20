import { createHash } from 'node:crypto';
import { authorize } from '@ecs/auth';
import type { BrowseRecord, BrowseSelection } from '@ecs/database';
import { type Actor, DomainError, type ItemRecord } from '@ecs/domain';
import { decodeBrowseCursor, encodeBrowseCursor } from '@ecs/protocol';
import { probeFile, probeRoot, resolveInside } from '@ecs/storage';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerContext } from './context.js';
import {
  assetDecision,
  itemDecision,
  jsonObject,
  libraryDecision,
  requireActor,
  requiredString,
  requireOwner,
  requireRevision,
} from './http.js';

export interface BrowseProbes {
  root: typeof probeRoot;
  file: typeof probeFile;
}

function query(request: FastifyRequest, key: string): string | undefined {
  const value = (request.query as Record<string, unknown>)[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || (value === '' && key !== 'search'))
    throw new DomainError('invalid-query', 400, `Invalid ${key}`);
  return value;
}
function scope(request: FastifyRequest, optional = false): string | null | undefined {
  const libraryId = query(request, 'libraryId');
  const unassigned = query(request, 'unassigned');
  if (
    (unassigned !== undefined && unassigned !== 'true') ||
    (libraryId !== undefined && unassigned !== undefined) ||
    (!optional && libraryId === undefined && unassigned === undefined)
  )
    throw new DomainError('invalid-query', 400, 'Choose one library scope');
  return unassigned ? null : libraryId;
}
function actualOwner(actor: Actor): boolean {
  return (
    actor.kind === 'user' && actor.isOwner && !actor.localTrust && actor.scopes.includes('admin')
  );
}
function canWrite(catalog: ServerContext['catalog'], actor: Actor, item: ItemRecord): boolean {
  try {
    itemDecision(catalog, actor, item, 'write');
    libraryDecision(catalog, actor, item.libraryId, 'write');
    return true;
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
}
function canCreate(catalog: ServerContext['catalog'], actor: Actor, libraryId: string): boolean {
  if (actor.kind === 'guest' && actor.itemId) return false;
  return authorize({
    actor,
    action: 'write',
    libraryId,
    membership: actor.kind === 'user' ? catalog.membership(actor.userId, libraryId) : null,
  });
}
async function bounded<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      for (;;) {
        const item = items[i++];
        if (item === undefined) return;
        await work(item);
      }
    }),
  );
}

export function registerLibraryBrowse(
  app: FastifyInstance,
  context: ServerContext,
  probes: BrowseProbes = { root: probeRoot, file: probeFile },
): void {
  const { catalog } = context;
  app.get('/api/v1/browse-libraries', async (request) => {
    const actor = requireActor(request);
    return {
      items: catalog
        .listBrowseLibraries(actor)
        .map((library) => ({ ...library, canCreateItems: canCreate(catalog, actor, library.id) })),
      nextCursor: null,
    };
  });
  app.get('/api/v1/browse', async (request) => {
    const actor = requireActor(request);
    const libraryId = scope(request) ?? null;
    if (libraryId === null && !actualOwner(actor))
      throw new DomainError(
        'forbidden',
        403,
        'Only the server owner can browse unassigned folders',
      );
    if (
      (actor.kind === 'user' && !actor.scopes.includes('read')) ||
      (actor.kind === 'guest' && !actor.capabilities.includes('read'))
    )
      throw new DomainError('forbidden', 403, 'Read permission is required');
    if (
      libraryId !== null &&
      !catalog.listBrowseLibraries(actor).some((library) => library.id === libraryId)
    )
      throw new DomainError('not-found', 404, 'Library is not available');
    const category = query(request, 'category');
    if (!category || !['games', 'saves', 'media', 'system_files'].includes(category))
      throw new DomainError('invalid-query', 400, 'Invalid category');
    const sort = query(request, 'sort') ?? 'name_asc';
    if (sort !== 'name_asc' && sort !== 'name_desc')
      throw new DomainError('invalid-query', 400, 'Invalid sort');
    const limit = Number(query(request, 'limit') ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new DomainError('invalid-query', 400, 'limit must be 1-100');
    const rawSearch = query(request, 'search') ?? '';
    if ([...rawSearch].length > 256)
      throw new DomainError('invalid-query', 400, 'Search is too long');
    const search = rawSearch.normalize('NFC').toLowerCase();
    const rootId = query(request, 'rootId');
    const systemId = query(request, 'systemId');
    if (rootId) {
      const root = catalog.getContentRoot(rootId);
      if (
        !root ||
        root.libraryId !== libraryId ||
        (actor.kind === 'guest' && actor.itemId) ||
        (actor.kind === 'user' &&
          !actor.isOwner &&
          !actor.localTrust &&
          !catalog.membership(actor.userId, libraryId ?? ''))
      )
        throw new DomainError('not-found', 404, 'Folder is not available');
    }
    const selection: BrowseSelection = {
      actor,
      libraryId,
      category: category as BrowseSelection['category'],
      rootId,
      systemId,
      search,
      sort,
      limit,
    };
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          libraryId,
          category,
          rootId: rootId ?? null,
          systemId: systemId ?? null,
          search,
          sort,
          limit,
          actor:
            actor.kind === 'user'
              ? [
                  actor.kind,
                  actor.userId,
                  actor.localTrust ?? false,
                  actor.tokenKind,
                  actor.deviceId,
                ]
              : [actor.kind, actor.grantId],
        }),
      )
      .digest('hex');
    const cursor = query(request, 'cursor');
    if (cursor) {
      selection.position = decodeBrowseCursor(cursor, fingerprint);
      if (!selection.position)
        throw new DomainError('invalid-cursor', 400, 'This page has changed. Refresh the library.');
    }
    const page = catalog.browseLibrary(selection);
    const sourceRows = page.items.filter(
      (row): row is Extract<BrowseRecord, { entityType: 'source' }> => row.entityType === 'source',
    );
    const roots = new Map(
      sourceRows.map((row) => [row.source.rootId, catalog.getContentRoot(row.source.rootId)]),
    );
    const rootChecks = new Map<string, Awaited<ReturnType<typeof probeRoot>>>();
    await bounded([...roots.entries()], async ([id, root]) => {
      if (!root) return;
      let pinned = true;
      try {
        await resolveInside(root.path, '.ecs-browse-check', { pinnedRoot: true });
      } catch {
        pinned = false;
      }
      const live = pinned
        ? await probes.root(root.path)
        : { online: false, medium: 'internal' as const };
      rootChecks.set(id, live);
      catalog.recordRootCheck({
        rootId: id,
        availability: live.online ? 'online' : 'offline',
        medium: live.medium,
      });
    });
    const sources = new Map<string, unknown>();
    await bounded(sourceRows, async ({ source }) => {
      const root = roots.get(source.rootId);
      const check = rootChecks.get(source.rootId);
      let availability = source.availability;
      let size = source.size;
      if (!check?.online) {
        availability = 'offline';
        catalog.updateSourcePresence(source.id, { availability, size, blocks: source.blocks });
      } else if (root) {
        let full: string | null = null;
        try {
          full = await resolveInside(root.path, source.relativePath, { pinnedRoot: true });
        } catch {
          availability = 'offline';
          catalog.updateSourcePresence(source.id, { availability, size, blocks: source.blocks });
        }
        if (full) {
          const live = await probes.file(full, check.medium, true);
          availability = live.availability;
          size = live.size;
          catalog.updateSourcePresence(source.id, live);
        }
      }
      sources.set(source.id, {
        id: source.id,
        rootId: source.rootId,
        libraryId: source.libraryId,
        name: source.displayName,
        kind: source.kind,
        size,
        systemId: source.systemId,
        availability,
        medium: check?.medium ?? 'local',
        contentPath: `/api/v1/sources/${source.id}/content`,
      });
    });
    return {
      items: page.items.map((row) => {
        if (row.entityType === 'item') {
          itemDecision(catalog, actor, row.item, 'read');
          if (row.previewAsset) assetDecision(catalog, actor, row.item, row.previewAsset, 'read');
          return {
            entityType: 'item',
            id: row.item.id,
            name: row.item.title,
            libraryId: row.item.libraryId,
            systemId: row.item.systemIdentifier,
            item: row.item,
            ...(row.previewAsset ? { previewAsset: row.previewAsset } : {}),
            canUpload: canWrite(catalog, actor, row.item),
            canAdopt: false,
          };
        }
        if (row.entityType === 'asset') {
          assetDecision(catalog, actor, row.item, row.asset, 'read');
          let canAdopt = false;
          if (row.asset.conflictOf) {
            try {
              assetDecision(catalog, actor, row.item, row.asset, 'write');
              canAdopt = true;
            } catch (error) {
              if (!(error instanceof DomainError)) throw error;
            }
          }
          return {
            entityType: 'asset',
            id: row.asset.id,
            name: row.asset.displayName,
            libraryId: row.item.libraryId,
            systemId: row.item.systemIdentifier,
            asset: row.asset,
            parentItem: row.item,
            canUpload: canWrite(catalog, actor, row.item),
            canAdopt,
          };
        }
        return {
          entityType: 'source',
          id: row.source.id,
          name: row.source.displayName,
          libraryId: row.source.libraryId,
          systemId: row.source.systemId,
          source: sources.get(row.source.id),
          canUpload: false,
          canAdopt: false,
        };
      }),
      nextCursor: page.next ? encodeBrowseCursor(fingerprint, page.next) : null,
    };
  });
  app.get('/api/v1/root-summaries', async (request) => {
    const actor = requireOwner(request, 'Only the server owner can read folder summaries');
    const libraryId = scope(request, true);
    if (libraryId && !catalog.getLibrary(libraryId))
      throw new DomainError('not-found', 404, 'Library not found');
    return {
      items: catalog.listContentRootSummaries({ actor, libraryId }).map((row) => ({
        root: {
          id: row.id,
          path: row.path,
          label: row.label,
          libraryId: row.libraryId,
          createdAt: row.createdAt,
        },
        indexedFileCount: row.indexedFileCount,
        scanState: row.scanState,
        lastScanAt: row.lastScanCompletedAt,
        lastCheckAt: row.lastCheckedAt,
        online: row.availability === 'unknown' ? null : row.availability === 'online',
        medium: row.medium,
      })),
    };
  });
  app.patch('/api/v1/libraries/:libraryId', async (request, reply) => {
    const actor = requireOwner(request, 'Only the server owner can rename libraries');
    const name = requiredString(jsonObject(request.body), 'name').trim();
    if (name.length > 80) throw new DomainError('invalid-body', 400, 'Library name is too long');
    const library = catalog.renameLibrary({
      id: (request.params as { libraryId: string }).libraryId,
      name,
      baseRevision: requireRevision(request),
      actorId: actor.userId,
      deviceId: actor.deviceId,
    });
    return reply.header('etag', `"rev-${library.revision}"`).send(library);
  });
  app.put('/api/v1/roots/:rootId/library', async (request) => {
    const actor = requireOwner(request, 'Only the server owner can assign folders');
    return catalog.assignUnassignedRoot({
      rootId: (request.params as { rootId: string }).rootId,
      libraryId: requiredString(jsonObject(request.body), 'libraryId'),
      actorId: actor.userId,
      deviceId: actor.deviceId,
    });
  });
}
