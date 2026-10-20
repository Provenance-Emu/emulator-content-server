import { stat } from 'node:fs/promises';
import { relative } from 'node:path';
import type { CatalogDatabase } from '@ecs/database';
import { type Actor, DomainError } from '@ecs/domain';
import {
  etagMatches,
  ifRangeMatches,
  isRestrictedAssetKind,
  parseSingleRange,
  strongEtag,
  validateAssetKind,
} from '@ecs/protocol';
import {
  blobPath,
  FileContentReader,
  locationOnline,
  probeFile,
  probeRoot,
  resolveInside,
} from '@ecs/storage';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from './context.js';
import { assetDecision, requireActor } from './http.js';
export async function blobRoot(context: ServerContext, sha256: string): Promise<string> {
  const record = context.catalog.blobRecord(sha256);
  if (!record?.locationId) return context.dataDir;
  const location = context.catalog.getStorageLocation(record.locationId);
  if (!location || !(await locationOnline(location.path))) {
    throw new DomainError(
      'location-offline',
      503,
      `Storage location ${location?.label ?? 'unknown'} is offline`,
    );
  }
  return location.path;
}

async function storedBlob(
  context: ServerContext,
  sha256: string,
): Promise<{ path: string; size: number }> {
  const root = await blobRoot(context, sha256);
  try {
    let path: string;
    try {
      path = await resolveInside(root, relative(root, blobPath(root, sha256)));
    } catch {
      throw new DomainError('not-found', 404, 'Stored bytes are unavailable');
    }
    return { path, size: (await stat(path)).size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DomainError('not-found', 404, 'Stored bytes are missing');
    }
    throw error;
  }
}

export function canSeeRoot(
  actor: Actor,
  libraryId: string | null,
  catalog: CatalogDatabase,
): boolean {
  if (actor.kind === 'guest') return libraryId === actor.libraryId;
  if (actor.isOwner || actor.localTrust === true) return true;
  if (libraryId === null) return false;
  return catalog.visibleLibraryIds(actor).includes(libraryId);
}

export function canSeeSource(actor: Actor, libraryId: string | null, kind: string): boolean {
  if (actor.kind !== 'guest') return true;
  if (libraryId !== actor.libraryId) return false;
  const parsed = validateAssetKind(kind);
  return !(
    parsed &&
    isRestrictedAssetKind(parsed) &&
    !actor.capabilities.includes('share_restricted')
  );
}

export async function sendSourceContent(
  context: ServerContext,
  request: FastifyRequest,
  reply: FastifyReply,
  resourceId: string,
): Promise<FastifyReply> {
  const actor = requireActor(request);
  if (actor.kind === 'user' && !actor.scopes.includes('read')) {
    throw new DomainError('forbidden', 403, 'This token cannot read');
  }
  const sourceId = resourceId;
  const source = context.catalog.getSource(sourceId);
  if (!source || !canSeeSource(actor, source.libraryId, source.kind)) {
    throw new DomainError('not-found', 404, 'Source file not found');
  }
  if (!canSeeRoot(actor, source.libraryId, context.catalog)) {
    throw new DomainError('not-found', 404, 'Source file not found');
  }
  const root = context.catalog.getContentRoot(source.rootId);
  if (!root) throw new DomainError('not-found', 404, 'Source file not found');
  const probe = await probeRoot(root.path);
  if (!probe.online) {
    context.catalog.markRootOffline(root.id);
    throw new DomainError('source-offline', 503, 'That disk is not connected');
  }
  let full: string;
  try {
    full = await resolveInside(root.path, source.relativePath);
  } catch {
    throw new DomainError('not-found', 404, 'Source file not found');
  }
  const live = await probeFile(full, probe.medium, true);
  context.catalog.updateSourcePresence(source.id, live);
  if (live.availability === 'evicted') {
    throw new DomainError('source-evicted', 409, 'That file is only a placeholder on this machine');
  }
  if (live.availability === 'offline') {
    throw new DomainError('source-offline', 503, 'That disk is not connected');
  }
  const etag = strongEtag(`source-${source.id}-${live.size}`);
  reply.header('accept-ranges', 'bytes');
  reply.header('etag', etag);
  if (etagMatches(headerString(request, 'if-none-match'), etag)) {
    return reply.status(304).send();
  }
  return sendRange(request, reply, { path: full, offset: 0, size: live.size, etag });
}

export async function sendContent(
  context: ServerContext,
  request: FastifyRequest,
  reply: FastifyReply,
  resourceId: string,
): Promise<FastifyReply> {
  const actor = requireActor(request);
  const asset = context.catalog.getAsset(resourceId);
  const item = asset ? context.catalog.getItem(asset.itemId) : null;
  if (!asset || !item) throw new DomainError('not-found', 404, 'File not found');
  assetDecision(context.catalog, actor, item, asset, 'read');
  const stored = await storedBlob(context, asset.sha256);
  const etag = strongEtag(asset.sha256);
  reply.header('accept-ranges', 'bytes');
  reply.header('etag', etag);
  if (etagMatches(headerString(request, 'if-none-match'), etag)) {
    return reply.status(304).send();
  }
  return sendRange(request, reply, {
    path: stored.path,
    offset: 0,
    size: stored.size,
    etag,
  });
}

export async function sendRange(
  request: FastifyRequest,
  reply: FastifyReply,
  source: { path: string; offset: number; size: number; etag: string },
): Promise<FastifyReply> {
  const { size } = source;
  const rangeHeader = headerString(request, 'range');
  let status = 200;
  let start = 0;
  let end = Math.max(size - 1, 0);
  if (rangeHeader && ifRangeMatches(headerString(request, 'if-range'), source.etag)) {
    const parsed = parseSingleRange(rangeHeader, size);
    if (parsed.type === 'invalid') {
      throw new DomainError('invalid-range', 400, 'Only one byte range is supported');
    }
    if (parsed.type === 'unsatisfiable') {
      return reply.status(416).header('content-range', `bytes */${size}`).send();
    }
    status = 206;
    start = parsed.start;
    end = parsed.end;
    reply.header('content-range', `bytes ${start}-${end}/${size}`);
  }
  const length = size === 0 ? 0 : end - start + 1;
  reply.header('content-type', 'application/octet-stream');
  reply.header('content-length', String(length));
  if (request.method === 'HEAD' || length === 0) return reply.status(status).send();
  const reader = new FileContentReader(source.path, source.offset + size);
  return reply.status(status).send(reader.openRange(source.offset + start, source.offset + end));
}

function headerString(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}
