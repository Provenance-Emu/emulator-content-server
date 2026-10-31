import { hashToken, issueToken } from '@ecs/auth';
import { DomainError, type WorkflowLease, type WorkflowRunDraft } from '@ecs/domain';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './context.js';
import { jsonObject, requireOwner, withIdempotency } from './http.js';
import { visibleSource } from './source-groups.js';

export function workflowBody(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const body = jsonObject(value);
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new DomainError('invalid-request', 400, 'Unexpected workflow property');
  return body;
}
export function workflowString(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new DomainError('invalid-request', 400, 'Expected bounded workflow text');
  return value;
}
export function workflowInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new DomainError('invalid-request', 400, 'Expected bounded workflow integer');
  return Number(value);
}
export function workflowLease(value: unknown): WorkflowLease {
  const lease = workflowBody(value, ['runId', 'hostId', 'fence', 'expiresAt']);
  const result = {
    runId: workflowString(lease.runId),
    hostId: workflowString(lease.hostId),
    fence: workflowInteger(lease.fence, 1),
    expiresAt: workflowString(lease.expiresAt, 40),
  };
  if (!Number.isFinite(Date.parse(result.expiresAt)))
    throw new DomainError('invalid-request', 400, 'Invalid lease expiry');
  return result;
}
function draft(value: unknown): WorkflowRunDraft {
  const body = workflowBody(value, ['workflowId', 'workflowDigest', 'hostId', 'scope', 'options']);
  const scope = workflowBody(body.scope, ['libraryId', 'rootId', 'sourceIds', 'unassigned']);
  for (const field of ['libraryId', 'rootId'])
    if (scope[field] !== undefined) workflowString(scope[field]);
  if (scope.unassigned !== undefined && typeof scope.unassigned !== 'boolean')
    throw new DomainError('invalid-request', 400, 'Invalid workflow scope');
  if (scope.sourceIds !== undefined) {
    if (!Array.isArray(scope.sourceIds) || !scope.sourceIds.length || scope.sourceIds.length > 1000)
      throw new DomainError('invalid-request', 400, 'Invalid source selection');
    scope.sourceIds.forEach((id) => {
      workflowString(id);
    });
  }
  const options = workflowBody(body.options, [
    'online',
    'checksum',
    'shareImages',
    'providerIds',
    'reasonerConnectionId',
    'coverInspectorConnectionId',
  ]);
  for (const name of ['online', 'checksum', 'shareImages'])
    if (typeof options[name] !== 'boolean')
      throw new DomainError('invalid-request', 400, 'Workflow options must be explicit booleans');
  for (const name of ['reasonerConnectionId', 'coverInspectorConnectionId'])
    if (options[name] !== undefined) workflowString(options[name]);
  if (options.providerIds !== undefined) {
    if (!Array.isArray(options.providerIds) || options.providerIds.length > 32)
      throw new DomainError('invalid-request', 400, 'Invalid workflow provider selection');
    options.providerIds.forEach((id) => {
      workflowString(id);
    });
  }
  workflowString(body.workflowId);
  workflowString(body.workflowDigest, 64);
  workflowString(body.hostId);
  return body as unknown as WorkflowRunDraft;
}

export function registerWorkflowRoutes(app: FastifyInstance, context: ServerContext): void {
  const owner = 'Only the server owner can manage cleanup workflows';
  app.get('/api/v1/workflow-hosts', async (request, reply) => {
    requireOwner(request, owner);
    reply.header('cache-control', 'private, no-store');
    return { items: context.catalog.workflowIdentities.listHosts() };
  });
  app.post('/api/v1/workflow-hosts', async (request, reply) => {
    const actor = requireOwner(request, owner);
    const body = workflowBody(request.body, ['name']);
    const enrollment = issueToken();
    const host = context.catalog.workflowIdentities.createHost(
      actor.userId,
      workflowString(body.name, 80),
      enrollment.hash,
      Date.now() + 600_000,
    );
    reply.code(201).header('cache-control', 'private, no-store');
    return { host, enrollmentToken: enrollment.token };
  });
  app.delete('/api/v1/workflow-hosts/:hostId', async (request, reply) => {
    const actor = requireOwner(request, owner);
    context.catalog.workflowIdentities.revokeHost(
      (request.params as { hostId: string }).hostId,
      actor.userId,
    );
    return reply.code(204).send();
  });
  app.post(
    '/api/v1/workflow-workers/enroll',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = workflowBody(request.body, ['enrollmentToken']);
      const issued = issueToken();
      const host = context.catalog.workflowIdentities.enrollHost(
        hashToken(workflowString(body.enrollmentToken, 100)),
        issued.hash,
      );
      reply.header('cache-control', 'private, no-store');
      return { host, token: issued.token };
    },
  );
  app.get('/api/v1/workflow-runs', async (request, reply) => {
    requireOwner(request, owner);
    reply.header('cache-control', 'private, no-store');
    const query = request.query as {
      cursor?: string;
      limit?: string;
      libraryId?: string;
      rootId?: string;
      unassigned?: string;
    };
    if (query.unassigned !== undefined && query.unassigned !== 'true')
      throw new DomainError('invalid-request', 400, 'Invalid scope');
    return context.catalog.workflowRuns.listRuns(
      query.limit === undefined ? 20 : workflowInteger(Number(query.limit), 1, 100),
      query.cursor,
      { libraryId: query.libraryId, rootId: query.rootId, unassigned: query.unassigned === 'true' },
    );
  });
  app.post('/api/v1/workflow-runs', async (request, reply) => {
    const actor = requireOwner(request, owner);
    const input = draft(request.body);
    const response = await withIdempotency(context.catalog, actor, request, input, async () => {
      const host = context.catalog.workflowIdentities.getHost(input.hostId);
      if (!host?.enrolled || host.revokedAt)
        throw new DomainError(
          'workflow-host-unavailable',
          503,
          'Connect a workflow host before starting cleanup',
        );
      const key = request.headers['idempotency-key'];
      const run = context.catalog.workflowRuns.createRun(
        input,
        actor.userId,
        Date.now(),
        typeof key === 'string' ? key : undefined,
      );
      return { status: 201, body: { run } };
    });
    reply.code(response.status).header('cache-control', 'private, no-store');
    return response.body;
  });
  app.get('/api/v1/workflow-runs/:runId', async (request, reply) => {
    requireOwner(request, owner);
    reply.header('cache-control', 'private, no-store');
    const run = context.catalog.workflowRuns.getRun((request.params as { runId: string }).runId);
    if (!run) throw new DomainError('not-found', 404, 'Workflow run not found');
    return { run };
  });
  app.get('/api/v1/workflow-runs/:runId/findings', async (request, reply) => {
    requireOwner(request, owner);
    const id = (request.params as { runId: string }).runId;
    if (!context.catalog.workflowRuns.getRun(id))
      throw new DomainError('not-found', 404, 'Workflow run not found');
    const query = request.query as { cursor?: string; limit?: string };
    reply.header('cache-control', 'private, no-store');
    return context.catalog.workflowProposals.pageFindings(
      id,
      query.cursor,
      query.limit === undefined ? 20 : workflowInteger(Number(query.limit), 1, 100),
    );
  });
  app.get('/api/v1/workflow-runs/:runId/work', async (request, reply) => {
    requireOwner(request, owner);
    const id = (request.params as { runId: string }).runId;
    if (!context.catalog.workflowRuns.getRun(id))
      throw new DomainError('not-found', 404, 'Workflow run not found');
    const query = request.query as { cursor?: string; limit?: string };
    reply.header('cache-control', 'private, no-store');
    return context.catalog.workflowRuns.pageWork(
      id,
      query.cursor,
      query.limit === undefined ? 20 : workflowInteger(Number(query.limit), 1, 100),
    );
  });
  app.post('/api/v1/workflow-runs/:runId/findings/:findingId/decision', async (request, reply) => {
    const actor = requireOwner(request, owner);
    const { runId, findingId } = request.params as { runId: string; findingId: string };
    const finding = context.catalog.workflowProposals.getFinding(findingId);
    if (!finding || finding.runId !== runId)
      throw new DomainError('not-found', 404, 'Finding unavailable');
    const body = workflowBody(request.body, ['decision']);
    if (body.decision !== 'keep' && body.decision !== 'dismiss')
      throw new DomainError('invalid-request', 400, 'Invalid review decision');
    context.catalog.workflowProposals.recordDecision(findingId, body.decision, actor.userId);
    reply.header('cache-control', 'private, no-store');
    return { finding: { ...finding, dismissed: true } };
  });
  app.get('/api/v1/workflow-runs/:runId/proposals', async (request, reply) => {
    requireOwner(request, owner);
    const id = (request.params as { runId: string }).runId;
    if (!context.catalog.workflowRuns.getRun(id))
      throw new DomainError('not-found', 404, 'Workflow run not found');
    const query = request.query as { cursor?: string; limit?: string };
    reply.header('cache-control', 'private, no-store');
    const page = context.catalog.workflowProposals.pageProposals(
      id,
      query.cursor,
      query.limit === undefined ? 20 : workflowInteger(Number(query.limit), 1, 100),
    );
    const findings = [...new Set(page.items.map((p) => p.findingId))]
      .flatMap((id) => {
        const finding = context.catalog.workflowProposals.getFinding(id);
        return finding ? [finding] : [];
      })
      .map((f) => ({ ...f, dismissed: context.catalog.workflowProposals.isDismissed(f) }));
    return { ...page, findings };
  });
  app.get(
    '/api/v1/workflow-runs/:runId/sources/:sourceId/evidence/:evidenceId',
    async (request, reply) => {
      const actor = requireOwner(request, owner);
      const { runId, sourceId, evidenceId } = request.params as {
        runId: string;
        sourceId: string;
        evidenceId: string;
      };
      visibleSource(context, actor, sourceId);
      const evidence = context.catalog.workflowProposals.getEvidence(runId, sourceId, evidenceId);
      if (!evidence) throw new DomainError('not-found', 404, 'Evidence unavailable');
      const privatePayload = JSON.parse(evidence.payloadJson);
      const payload =
        privatePayload.type === 'facts'
          ? { type: 'facts', facts: privatePayload.facts }
          : privatePayload.type === 'candidate'
            ? {
                type: 'candidate',
                candidateId: privatePayload.candidate.id,
                title: privatePayload.candidate.title,
                kind: privatePayload.candidate.kind,
                providerId: privatePayload.candidate.providerId,
                evidence: privatePayload.candidate.metadata.matchEvidence ?? 'unverified',
              }
            : { type: 'observation' };
      reply.header('cache-control', 'private, no-store');
      return { evidence: { ...evidence, payloadJson: JSON.stringify(payload) } };
    },
  );
  app.get(
    '/api/v1/workflow-runs/:runId/sources/:sourceId/artifacts/:artifactId/metadata',
    async (request, reply) => {
      const actor = requireOwner(request, owner);
      const { runId, sourceId, artifactId } = request.params as {
        runId: string;
        sourceId: string;
        artifactId: string;
      };
      visibleSource(context, actor, sourceId);
      const content = context.catalog.workflowProposals.getArtifact(runId, sourceId, artifactId);
      if (!content) throw new DomainError('not-found', 404, 'Artifact unavailable');
      reply.header('cache-control', 'private, no-store');
      return { artifact: content.artifact };
    },
  );
  app.get(
    '/api/v1/workflow-runs/:runId/sources/:sourceId/artifacts/:artifactId',
    async (request, reply) => {
      const actor = requireOwner(request, owner);
      const { runId, sourceId, artifactId } = request.params as {
        runId: string;
        sourceId: string;
        artifactId: string;
      };
      if (!context.catalog.workflowRuns.sourceSnapshot(runId, sourceId))
        throw new DomainError('not-found', 404, 'Artifact unavailable');
      visibleSource(context, actor, sourceId);
      const content = context.catalog.workflowProposals.getArtifact(runId, sourceId, artifactId);
      if (!content) throw new DomainError('not-found', 404, 'Artifact unavailable');
      reply
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff');
      return reply.type(content.artifact.contentType).send(Buffer.from(content.bytes));
    },
  );
  for (const action of ['cancel', 'resume'] as const)
    app.post(`/api/v1/workflow-runs/:runId/${action}`, async (request) => {
      const actor = requireOwner(request, owner);
      workflowBody(request.body, []);
      const id = (request.params as { runId: string }).runId;
      return {
        run:
          action === 'cancel'
            ? context.catalog.workflowRuns.cancelRun(id, actor.userId)
            : context.catalog.workflowRuns.resumeRun(id, actor.userId),
      };
    });
}
