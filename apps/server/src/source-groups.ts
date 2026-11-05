import { createReadStream } from 'node:fs';
import { posix } from 'node:path';
import type { Actor, SourceFileRecord } from '@ecs/domain';
import { DomainError } from '@ecs/domain';
import { groupDiscs, probeFile, probeRoot, resolveInside, streamZip } from '@ecs/storage';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canSeeRoot, canSeeSource } from './content.js';
import type { ServerContext } from './context.js';
import { requireActor } from './http.js';

export function visibleSource(context: ServerContext, actor: Actor, id: string): SourceFileRecord {
  if (actor.kind === 'user' ? !actor.scopes.includes('read') : !actor.capabilities.includes('read'))
    throw new DomainError('forbidden', 403, 'Read permission is required');
  const source = context.catalog.getSource(id);
  if (
    !source ||
    !canSeeRoot(actor, source.libraryId, context.catalog) ||
    !canSeeSource(actor, source.libraryId, source.kind)
  )
    throw new DomainError('not-found', 404, 'Source file not found');
  return source;
}

export async function localSource(context: ServerContext, actor: Actor, id: string) {
  const source = visibleSource(context, actor, id);
  const root = context.catalog.getContentRoot(source.rootId);
  if (!root) throw new DomainError('not-found', 404, 'Source file not found');
  let path: string;
  try {
    path = await resolveInside(root.path, source.relativePath, { pinnedRoot: true });
  } catch {
    throw new DomainError('source-offline', 503, 'Source file is unavailable');
  }
  const medium = await probeRoot(root.path);
  const live = await probeFile(path, medium.medium, medium.online);
  if (live.availability !== 'local')
    throw new DomainError(
      live.availability === 'evicted' ? 'source-evicted' : 'source-offline',
      409,
      'Source file is not available locally',
    );
  return { source: { ...source, ...live }, root, path };
}

export function registerSourceGroups(app: FastifyInstance, context: ServerContext): void {
  const actorSource = (request: FastifyRequest) => {
    const actor = requireActor(request);
    const source = visibleSource(context, actor, (request.params as { sourceId: string }).sourceId);
    return { actor, source };
  };
  app.get('/api/v1/sources/:sourceId/group', async (request) => {
    const { actor, source } = actorSource(request);
    const files = context.catalog.sourceGroup(source.id);
    let base = posix.dirname(source.relativePath);
    for (const file of files)
      while (base !== '.' && !file.relativePath.startsWith(`${base}/`)) base = posix.dirname(base);
    return {
      sourceId: source.id,
      error: source.groupError ?? null,
      files: files.map((file) => {
        visibleSource(context, actor, file.id);
        return {
          id: file.id,
          name: file.displayName,
          relativePath: posix.relative(base, file.relativePath),
          size: file.size,
          availability: file.availability,
        };
      }),
    };
  });
  app.get('/api/v1/sources/:sourceId/bundle', async (request, reply) => {
    const { actor, source } = actorSource(request);
    if (source.groupError || !source.groupMembers?.length)
      throw new DomainError(
        'group-unavailable',
        409,
        'This file is not a complete disc group. Rescan its folder.',
      );
    const files = context.catalog.sourceGroup(source.id);
    if (files.length !== source.groupMembers.length)
      throw new DomainError('group-changed', 409, 'Disc group changed. Rescan its folder.');
    const local = [];
    for (const file of files) local.push(await localSource(context, actor, file.id));
    // A descriptor may have changed since scanning. Never serve a stale or incomplete set.
    const inspection = local.map((file) => ({ ...file.source }));
    const first = local[0];
    if (!first) throw new DomainError('group-changed', 409, 'Disc group is empty');
    await groupDiscs(first.root.path, inspection);
    const current = inspection.find((file) => file.id === source.id);
    if (
      !current ||
      current.groupError ||
      JSON.stringify(current.groupMembers) !== JSON.stringify(source.groupMembers)
    )
      throw new DomainError('group-changed', 409, 'Disc group changed. Rescan its folder.');
    const name = `${source.displayName.replace(/\.[^.]+$/, '')}.zip`;
    reply.header('content-type', 'application/zip');
    reply.header(
      'content-disposition',
      `attachment; filename="disc-set.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    reply.header('cache-control', 'private, no-store');
    reply.header('accept-ranges', 'none');
    return reply.send(
      streamZip(
        local.map((file) => ({
          name: file.source.relativePath,
          size: file.source.size,
          async open() {
            const checked = await localSource(context, actor, file.source.id);
            if (checked.source.size !== file.source.size)
              throw new DomainError('group-changed', 409, 'Disc file changed during download');
            return createReadStream(checked.path);
          },
        })),
      ),
    );
  });
}
