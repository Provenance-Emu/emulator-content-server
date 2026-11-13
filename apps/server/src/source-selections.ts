import { createHash } from 'node:crypto';
import type { Actor, AssetKind, SourceDetails, SourceMatchRecord } from '@ecs/domain';
import {
  DomainError,
  FRONT_ARTWORK_MAX_BYTES,
  MANUAL_PROVIDER_ID,
  SOURCE_DETAIL_KEYS,
} from '@ecs/domain';
import { type MatchCandidate, patchFingerprint } from '@ecs/plugins/matching';
import { etagMatches, strongEtag, validateSystemIdentifier } from '@ecs/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canSeeSource } from './content.js';
import type { ServerContext } from './context.js';
import {
  jsonObject,
  requireActor,
  requireOwner,
  requireRevision,
  requireUser,
  sourceDecision,
} from './http.js';
import { imageType } from './matching-files.js';
import { visibleSource } from './source-groups.js';
import { runAutomaticOrganization } from './source-organization.js';

type Candidate = MatchCandidate & { providerId: string };
interface Dependencies {
  proposal(
    sourceId: string,
    ownerId: string,
    requestId: string,
    candidateId: string,
  ): { candidate: Candidate; pendingLocalKinds?: string[]; validate(actor: Actor): Promise<void> };
  resource(
    candidate: Candidate,
    sourceId: string,
    actor: Actor,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{
    bytes: Buffer;
    contentType: string;
    fileName: string;
    originKind: AssetKind | null;
  }>;
}
export function registerSourceSelections(
  app: FastifyInstance,
  context: ServerContext,
  dependencies: Dependencies,
  onIdentityChanged?: (rootId: string, sourceId: string) => void,
): void {
  function state(actor: Actor, sourceId: string, allArtwork = false) {
    const source = visibleSource(context, actor, sourceId);
    const saved = context.catalog.sourceMatches(sourceId);
    return {
      ...saved,
      ...(actor.kind === 'user' &&
      actor.isOwner &&
      !actor.localTrust &&
      actor.scopes.includes('admin') &&
      source.kind === 'rom'
        ? { lookupHints: context.catalog.sourceLookupHints(sourceId) }
        : {}),
      matches: saved.matches
        .filter(
          (match) =>
            (!match.originKind || canSeeSource(actor, source.libraryId, match.originKind)) &&
            (allArtwork || match.kind !== 'artwork' || (match.artworkRole ?? 'front') === 'front'),
        )
        .map(({ originKind, ...match }) => match),
    };
  }
  /** Access is decided before the body is read; a source the caller cannot read stays a 404. */
  function authorizeDetailsWrite(request: FastifyRequest): void {
    const actor = requireActor(request);
    const source = visibleSource(context, actor, (request.params as { sourceId: string }).sourceId);
    sourceDecision(context.catalog, actor, source);
    requireRevision(request);
  }
  const COVER_TYPES: Record<string, { type: string; extension: string }> = {
    'image/png': { type: 'image/png', extension: 'png' },
    'image/jpeg': { type: 'image/jpeg', extension: 'jpg' },
    'image/webp': { type: 'image/webp', extension: 'webp' },
  };
  app.register(async (scope) => {
    scope.addContentTypeParser(Object.keys(COVER_TYPES), (_request, payload, done) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let finished = false;
      payload.on('data', (chunk: Buffer) => {
        if (finished) return;
        size += chunk.length;
        if (size > FRONT_ARTWORK_MAX_BYTES) {
          finished = true;
          done(tooLarge());
          return;
        }
        chunks.push(chunk);
      });
      payload.on('end', () => {
        if (!finished) done(null, Buffer.concat(chunks));
      });
      payload.on('error', (error) => {
        if (!finished) done(error);
      });
    });
    scope.put(
      '/api/v1/sources/:sourceId/details',
      { bodyLimit: 64 * 1024, onRequest: async (request) => authorizeDetailsWrite(request) },
      async (request, reply) => {
        const actor = requireUser(request, 'write');
        const { sourceId } = request.params as { sourceId: string };
        visibleSource(context, actor, sourceId);
        const draft = parseDetailsDraft(request.body);
        const current = context.catalog
          .sourceMatches(sourceId)
          .matches.find((match) => match.kind === 'metadata');
        const details = mergeDetails(current?.metadata ?? {}, draft.details);
        const metadata: Record<string, string> = { title: draft.title, ...details };
        // The system a lookup recorded still describes the game; evidence about a lookup does not.
        if (current?.metadata.systemId) metadata.systemId = current.metadata.systemId;
        const id = `${MANUAL_PROVIDER_ID}:metadata:${createHash('sha256')
          .update(JSON.stringify([draft.title, details, metadata.systemId ?? null]))
          .digest('hex')
          .slice(0, 32)}`;
        context.catalog.saveSourceMatch(
          sourceId,
          requireRevision(request),
          'metadata',
          {
            id,
            providerId: MANUAL_PROVIDER_ID,
            kind: 'metadata',
            title: draft.title,
            confidence: 'local',
            metadata,
            originKind: null,
            contentAvailable: false,
            contentType: null,
            fileName: null,
            updatedAt: new Date().toISOString(),
          },
          null,
          actor.userId,
        );
        reply.header('cache-control', 'private, no-store');
        return state(actor, sourceId, includeArtworkRoles(request));
      },
    );
    scope.put(
      '/api/v1/sources/:sourceId/details/cover',
      {
        bodyLimit: FRONT_ARTWORK_MAX_BYTES,
        onRequest: async (request) => {
          authorizeDetailsWrite(request);
          const declared = String(request.headers['content-type'] ?? '')
            .split(';')[0]
            ?.trim()
            .toLowerCase();
          if (!declared || !COVER_TYPES[declared]) throw unsupportedCover();
          const length = Number(request.headers['content-length']);
          if (Number.isFinite(length) && length > FRONT_ARTWORK_MAX_BYTES) throw tooLarge();
        },
      },
      async (request, reply) => {
        const actor = requireUser(request, 'write');
        const { sourceId } = request.params as { sourceId: string };
        const source = visibleSource(context, actor, sourceId);
        const declared = String(request.headers['content-type'])
          .split(';')[0]
          ?.trim()
          .toLowerCase();
        const bytes = request.body;
        if (!Buffer.isBuffer(bytes) || bytes.length === 0 || imageType(bytes) !== declared)
          throw unsupportedCover();
        const cover = COVER_TYPES[declared as string] as { type: string; extension: string };
        const current = context.catalog
          .sourceMatches(sourceId)
          .matches.find((match) => match.kind === 'metadata');
        const digest = createHash('sha256').update(bytes).digest('hex');
        context.catalog.saveSourceMatch(
          sourceId,
          requireRevision(request),
          'artwork',
          {
            id: `${MANUAL_PROVIDER_ID}:artwork:${digest}`,
            providerId: MANUAL_PROVIDER_ID,
            kind: 'artwork',
            artworkRole: 'front',
            title: current?.title ?? source.title ?? source.displayName,
            confidence: 'local',
            metadata: { artworkRole: 'front' },
            originKind: null,
            contentAvailable: true,
            contentType: cover.type,
            fileName: `cover.${cover.extension}`,
            updatedAt: new Date().toISOString(),
          },
          bytes,
          actor.userId,
          'front',
        );
        reply.header('cache-control', 'private, no-store');
        return state(actor, sourceId, includeArtworkRoles(request));
      },
    );
  });
  app.get('/api/v1/sources/:sourceId/matches/selections', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    return state(
      requireActor(request),
      (request.params as { sourceId: string }).sourceId,
      includeArtworkRoles(request),
    );
  });
  app.put('/api/v1/sources/:sourceId/matches/lookup-hints', async (request, reply) => {
    const actor = requireOwner(request, 'Only the server owner can change lookup hints');
    const { sourceId } = request.params as { sourceId: string };
    const source = visibleSource(context, actor, sourceId);
    if (source.kind !== 'rom' || (source.groupAnchor && source.groupAnchor !== source.relativePath))
      throw new DomainError(
        'invalid-request',
        400,
        'Lookup hints belong to the game or its group entry.',
      );
    const body = jsonObject(request.body);
    if (
      Object.keys(body).some((key) => key !== 'title' && key !== 'systemId') ||
      (body.title !== null && typeof body.title !== 'string') ||
      (body.systemId !== null && typeof body.systemId !== 'string')
    )
      throw new DomainError(
        'invalid-request',
        400,
        'Supply a title and system identifier or null for either.',
      );
    const title =
      typeof body.title === 'string' ? body.title.trim().normalize('NFC') || null : null;
    const systemId = typeof body.systemId === 'string' ? body.systemId.trim() || null : null;
    if (
      (title &&
        (title.length > 160 ||
          [...title].some((char) => {
            const code = char.charCodeAt(0);
            return code < 32 || code === 127;
          }))) ||
      (systemId && validateSystemIdentifier(systemId))
    )
      throw new DomainError(
        'invalid-request',
        400,
        'Enter a title of up to 160 characters and a valid system identifier.',
      );
    if (
      context.catalog.setSourceLookupHints(
        sourceId,
        requireRevision(request),
        { title, systemId },
        actor.userId,
      )
    )
      onIdentityChanged?.(source.rootId, sourceId);
    reply.header('cache-control', 'private, no-store');
    return state(actor, sourceId, includeArtworkRoles(request));
  });

  function selectedPatch(actor: Actor, sourceId: string) {
    const selected = state(actor, sourceId).matches.find(
      (match) => match.kind === 'patch' && match.contentAvailable && match.contentType,
    );
    if (!selected) return null;
    const bytes = context.catalog.sourceMatchContent(sourceId, 'patch');
    const fingerprint = bytes && patchFingerprint(bytes);
    if (!bytes || !fingerprint) return null;
    return {
      selected,
      bytes,
      fingerprint,
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  app.get('/api/v1/sources/:sourceId/companions', async (request, reply) => {
    const { sourceId } = request.params as { sourceId: string };
    const patch = selectedPatch(requireActor(request), sourceId);
    reply.header('cache-control', 'private, no-store');
    if (!patch) return { supportedKinds: ['patch'], items: [] };
    const { selected, bytes, fingerprint, digest } = patch;
    return {
      supportedKinds: ['patch'],
      items: [
        {
          id: digest,
          kind: 'patch',
          required: false,
          filename: selected.fileName ?? `Patch.${fingerprint.format}`,
          sizeBytes: bytes.length,
          sha256: digest,
          format: fingerprint.format,
          contentPath: `/api/v1/sources/${encodeURIComponent(sourceId)}/companions/${digest}/content`,
          ...(fingerprint.sourceCrc32 === undefined || fingerprint.sourceSize === undefined
            ? {}
            : { base: { crc32: fingerprint.sourceCrc32, sizeBytes: fingerprint.sourceSize } }),
        },
      ],
    };
  });
  app.get('/api/v1/sources/:sourceId/companions/:id/content', async (request, reply) => {
    const { sourceId, id } = request.params as { sourceId: string; id: string };
    const patch = selectedPatch(requireActor(request), sourceId);
    if (!patch || patch.digest !== id)
      throw new DomainError('not-found', 404, 'Companion is not available');
    return sendSnapshot(
      request,
      reply,
      patch.bytes,
      patch.digest,
      patch.selected.contentType ?? 'application/octet-stream',
      patch.selected.fileName ?? `Patch.${patch.fingerprint.format}`,
    );
  });
  app.put('/api/v1/sources/:sourceId/matches/selections', async (request, reply) => {
    const actor = requireOwner(request, 'Only the server owner can save matches');
    const sourceId = (request.params as { sourceId: string }).sourceId;
    const source = visibleSource(context, actor, sourceId);
    const body = request.body as {
      requestId?: unknown;
      candidateId?: unknown;
      expectedRevision?: unknown;
    } | null;
    if (
      !body ||
      Array.isArray(body) ||
      typeof body.requestId !== 'string' ||
      body.requestId.length > 200 ||
      typeof body.candidateId !== 'string' ||
      body.candidateId.length > 200 ||
      !Number.isSafeInteger(body.expectedRevision) ||
      Number(body.expectedRevision) < 0
    )
      throw new DomainError(
        'invalid-request',
        400,
        'Select a candidate and supply the current matching revision',
      );
    const current = context.catalog.sourceMatches(sourceId);
    if (current.matches.some((match) => match.id === body.candidateId))
      return state(actor, sourceId, includeArtworkRoles(request));
    if (current.revision !== body.expectedRevision)
      throw new DomainError(
        'matching-conflict',
        409,
        'Saved matches changed. Refresh before replacing a selection.',
      );
    const proposed = dependencies.proposal(
      sourceId,
      actor.userId,
      body.requestId,
      body.candidateId,
    );
    await proposed.validate(actor);
    const candidate = proposed.candidate;
    if (candidate.metadata.systemId && validateSystemIdentifier(candidate.metadata.systemId))
      throw new DomainError(
        'invalid-match',
        400,
        'The provider returned an invalid system identifier',
      );
    if (candidate.kind === 'rom' && !candidate.metadata.systemId)
      throw new DomainError(
        'invalid-match',
        400,
        'A system match must include a system identifier',
      );
    const file = ['artwork', 'patch', 'cheats'].includes(candidate.kind)
      ? await dependencies.resource(candidate, sourceId, actor, request, reply)
      : null;
    await proposed.validate(actor);
    visibleSource(context, actor, sourceId);
    const selection: SourceMatchRecord = {
      id: candidate.id,
      providerId: candidate.providerId,
      kind: candidate.kind,
      title: candidate.title,
      confidence: candidate.confidence,
      metadata: candidate.metadata,
      // Owner-selected text becomes game metadata; binary snapshots retain source-kind access.
      originKind: file?.originKind ?? null,
      ...(candidate.fileId ? { originFileId: candidate.fileId } : {}),
      ...(candidate.url ? { originUrl: candidate.url } : {}),
      contentAvailable: !!file,
      contentType: file?.contentType ?? null,
      fileName: file?.fileName ?? null,
      updatedAt: new Date().toISOString(),
    };
    context.catalog.saveSourceMatch(
      sourceId,
      Number(body.expectedRevision),
      candidate.kind,
      selection,
      file?.bytes ?? null,
      actor.userId,
    );
    const automaticOrganization = ['rom', 'metadata', 'artwork'].includes(candidate.kind)
      ? await runAutomaticOrganization(
          context,
          actor,
          sourceId,
          proposed.pendingLocalKinds?.filter(
            (kind) =>
              !context.catalog
                .sourceMatches(sourceId)
                .matches.some((match) => matchSlot(match) === kind),
          ),
        )
      : undefined;
    if (candidate.kind === 'metadata' || candidate.kind === 'rom')
      onIdentityChanged?.(context.catalog.getSource(sourceId)?.rootId ?? source.rootId, sourceId);
    reply.header('cache-control', 'private, no-store');
    return {
      ...state(actor, sourceId, includeArtworkRoles(request)),
      ...(automaticOrganization ? { automaticOrganization } : {}),
    };
  });
  app.delete('/api/v1/sources/:sourceId/matches/selections/:kind', async (request, reply) => {
    const actor = requireOwner(request, 'Only the server owner can remove selected matches');
    const { sourceId, kind } = request.params as { sourceId: string; kind: string };
    visibleSource(context, actor, sourceId);
    context.catalog.saveSourceMatch(
      sourceId,
      requireRevision(request),
      kind,
      null,
      null,
      actor.userId,
      kind === 'artwork' ? artworkRole(request) : undefined,
    );
    reply.header('cache-control', 'private, no-store');
    return state(actor, sourceId, includeArtworkRoles(request));
  });
  app.get('/api/v1/sources/:sourceId/matches/selections/:kind/content', async (request, reply) => {
    const actor = requireActor(request);
    const { sourceId, kind } = request.params as { sourceId: string; kind: string };
    const role = artworkRole(request);
    const selected = state(actor, sourceId, true).matches.find(
      (match) =>
        match.kind === kind && (kind !== 'artwork' || (match.artworkRole ?? 'front') === role),
    );
    if (!selected?.contentAvailable || !selected.contentType)
      throw new DomainError('not-found', 404, 'Selected content not found');
    const bytes = context.catalog.sourceMatchContent(sourceId, kind, role);
    if (!bytes) throw new DomainError('not-found', 404, 'Selected content not found');
    return sendSnapshot(
      request,
      reply,
      bytes,
      createHash('sha256').update(bytes).digest('hex'),
      selected.contentType,
      selected.fileName ?? 'selected',
      kind === 'artwork' && selected.contentType !== 'application/pdf',
    );
  });
}

function sendSnapshot(
  request: FastifyRequest,
  reply: FastifyReply,
  bytes: Uint8Array,
  digest: string,
  contentType: string,
  fileName: string,
  inline = false,
) {
  // Authorization precedes validator evaluation.
  const etag = strongEtag(digest);
  reply.header('cache-control', 'private, no-cache');
  reply.header('etag', etag);
  const conditional = request.headers['if-none-match'];
  if (etagMatches(typeof conditional === 'string' ? conditional : undefined, etag))
    return reply.code(304).send();
  reply.header('x-content-type-options', 'nosniff');
  reply.header(
    'content-disposition',
    `${inline ? 'inline' : 'attachment'}; filename="selected"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  return reply.type(contentType).send(Buffer.from(bytes));
}

function includeArtworkRoles(request: FastifyRequest): boolean {
  const value = (request.query as Record<string, unknown>).includeArtworkRoles;
  if (value !== undefined && value !== 'true' && value !== 'false' && typeof value !== 'boolean')
    throw new DomainError('invalid-request', 400, 'Invalid artwork role selection');
  return value === true || value === 'true';
}
function artworkRole(request: FastifyRequest): NonNullable<SourceMatchRecord['artworkRole']> {
  const value = (request.query as Record<string, unknown>).artworkRole ?? 'front';
  if (
    typeof value !== 'string' ||
    !['front', 'back', 'disc', 'manual', 'title', 'screenshot', 'other'].includes(value)
  )
    throw new DomainError('invalid-request', 400, 'Invalid artwork role');
  return value as NonNullable<SourceMatchRecord['artworkRole']>;
}

export function matchSlot(candidate: {
  kind: string;
  metadata: Record<string, string>;
  artworkRole?: string;
}) {
  return candidate.kind === 'artwork'
    ? `artwork:${candidate.artworkRole ?? candidate.metadata.artworkRole ?? 'front'}`
    : candidate.kind;
}

function tooLarge(): DomainError {
  return new DomainError('matching-file-too-large', 413, 'Selected content is too large');
}
function unsupportedCover(): DomainError {
  return new DomainError('unsupported-artwork', 415, 'A cover must be a PNG, JPEG or WebP image');
}

const MAX_TITLE_LENGTH = 200;
const MAX_DETAIL_LENGTH = 2000;
function parseDetailsDraft(body: unknown): { title: string; details: Record<string, string> } {
  const record = jsonObject(body);
  if (Object.keys(record).some((key) => key !== 'title' && key !== 'details'))
    throw new DomainError('invalid-request', 400, 'Supply only a title and details.');
  const title = typeof record.title === 'string' ? record.title.trim().normalize('NFC') : '';
  if (
    !title ||
    title.length > MAX_TITLE_LENGTH ||
    [...title].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new DomainError(
      'invalid-request',
      400,
      `Enter a title of 1 to ${MAX_TITLE_LENGTH} characters.`,
    );
  const details: Record<string, string> = {};
  if (record.details !== undefined) {
    const supplied = jsonObject(record.details);
    for (const [key, value] of Object.entries(supplied)) {
      if (
        !(SOURCE_DETAIL_KEYS as readonly string[]).includes(key) ||
        typeof value !== 'string' ||
        value.trim().length > MAX_DETAIL_LENGTH
      )
        throw new DomainError(
          'invalid-request',
          400,
          `Details accept publisher, developer, year, genre, region, language and a description of up to ${MAX_DETAIL_LENGTH} characters.`,
        );
      details[key] = value.trim();
    }
  }
  return { title, details };
}
/** Saved details carry over; a supplied key replaces its field and an empty one clears it. */
function mergeDetails(
  saved: Record<string, string>,
  supplied: Record<string, string>,
): SourceDetails {
  const merged: Record<string, string> = {};
  for (const key of SOURCE_DETAIL_KEYS) {
    const value = key in supplied ? supplied[key] : saved[key]?.trim();
    if (value) merged[key] = value;
  }
  return merged;
}
