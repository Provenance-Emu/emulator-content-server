import type { Actor, AssetKind, SourceMatchRecord } from '@ecs/domain';
import { DomainError } from '@ecs/domain';
import type { MatchCandidate } from '@ecs/plugins/matching';
import { validateSystemIdentifier } from '@ecs/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canSeeSource } from './content.js';
import type { ServerContext } from './context.js';
import { requireActor, requireOwner, requireRevision } from './http.js';
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
): void {
  function state(actor: Actor, sourceId: string, allArtwork = false) {
    const source = visibleSource(context, actor, sourceId);
    const saved = context.catalog.sourceMatches(sourceId);
    return {
      ...saved,
      matches: saved.matches
        .filter(
          (match) =>
            (!match.originKind || canSeeSource(actor, source.libraryId, match.originKind)) &&
            (allArtwork || match.kind !== 'artwork' || (match.artworkRole ?? 'front') === 'front'),
        )
        .map(({ originKind, ...match }) => match),
    };
  }
  app.get('/api/v1/sources/:sourceId/matches/selections', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    return state(
      requireActor(request),
      (request.params as { sourceId: string }).sourceId,
      includeArtworkRoles(request),
    );
  });
  app.put('/api/v1/sources/:sourceId/matches/selections', async (request, reply) => {
    const actor = requireOwner(request, 'Only the server owner can save matches');
    const sourceId = (request.params as { sourceId: string }).sourceId;
    visibleSource(context, actor, sourceId);
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
              !context.catalog.sourceMatches(sourceId).matches.some((match) => match.kind === kind),
          ),
        )
      : undefined;
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
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header(
      'content-disposition',
      `${kind === 'artwork' && selected.contentType !== 'application/pdf' ? 'inline' : 'attachment'}; filename="selected"; filename*=UTF-8''${encodeURIComponent(selected.fileName ?? 'selected')}`,
    );
    return reply.type(selected.contentType).send(Buffer.from(bytes));
  });
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
