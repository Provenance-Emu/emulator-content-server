import { hashToken, issueToken } from '@ecs/auth';
import {
  type InvestigatorOperation,
  type InvestigatorPrincipal,
  investigatorHostId,
  investigatorOperations,
} from '@ecs/database';
import {
  DomainError,
  type WorkflowFinding,
  type WorkflowProposal,
  type WorkflowRun,
} from '@ecs/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerContext } from './context.js';
import { requireOwner } from './http.js';
import type { SourceMatchingService } from './source-matching.js';
import { createWorkflowEvidenceService } from './workflow-evidence.js';
import { workflowBody, workflowInteger, workflowString } from './workflow-routes.js';
import { workflowHash } from './workflow-values.js';

const api = '/api/v1/investigator';
const management = '/api/v1/investigators';
const workflowId = 'org.ecs.investigator-cleanup';
const workflowDigest = workflowHash([workflowId, 1]);
const noStore = 'private, no-store';

function unavailable(): never {
  throw new DomainError('not-found', 404, 'Resource is unavailable to this investigator');
}
function requireOperation(
  request: FastifyRequest,
  operation: InvestigatorOperation,
): InvestigatorPrincipal {
  const grant = request.investigator;
  if (!grant?.operations.includes(operation))
    throw new DomainError('forbidden', 403, 'Investigator grant lacks this operation');
  return grant;
}
function stringList(value: unknown, max: number) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > max ||
    new Set(value).size !== value.length
  )
    throw new DomainError('invalid-request', 400, 'Expected a bounded list of unique values');
  return value.map((id) => workflowString(id));
}
function page(request: FastifyRequest) {
  const query = workflowBody(request.query, ['cursor', 'limit']);
  const cursor = query.cursor === undefined ? undefined : workflowString(query.cursor, 160);
  const limit =
    query.limit === undefined ? 10 : workflowInteger(Number(workflowString(query.limit, 2)), 1, 20);
  return { cursor, limit };
}
function runSummary(run: WorkflowRun) {
  return { id: run.id, state: run.state, createdAt: run.createdAt, updatedAt: run.updatedAt };
}
function findingSummary(finding: WorkflowFinding) {
  const { id, sourceId, kind, evidenceIds, dismissed } = finding;
  return { id, sourceId, kind, evidenceIds, dismissed, reason: finding.reason.slice(0, 512) };
}
function proposalSummary(proposal: WorkflowProposal) {
  const { id, version, sourceId, findingId, evidenceClass, digest, change } = proposal;
  return { id, version, sourceId, findingId, evidenceClass, digest, action: change.action };
}

export function registerInvestigatorRoutes(
  app: FastifyInstance,
  context: ServerContext,
  matching: SourceMatchingService,
) {
  const { catalog } = context;
  const repo = catalog.investigators;
  const ownerMessage = 'Only the server owner can manage investigators';
  const abort = new AbortController();
  app.addHook('preClose', async () => abort.abort());

  function library(grant: InvestigatorPrincipal, id: string) {
    const entry = grant.libraryIds.includes(id) ? catalog.getLibrary(id) : null;
    return entry ?? unavailable();
  }
  function run(grant: InvestigatorPrincipal, id: string): WorkflowRun {
    const result = catalog.workflowRuns.getRun(id);
    if (result?.hostId !== investigatorHostId(grant.id) || !result.scope.libraryId) unavailable();
    library(grant, result.scope.libraryId);
    return result;
  }
  function isCurrent(run: WorkflowRun, sourceId: string): boolean {
    const source = catalog.getSource(sourceId);
    return (
      !!source &&
      source.libraryId === run.scope.libraryId &&
      catalog.workflowRuns.sourceIsCurrent(run.id, sourceId)
    );
  }
  function evidenceFor(grant: InvestigatorPrincipal) {
    return createWorkflowEvidenceService(context, matching, (original, sourceId) => {
      if (!repo.isActive(grant.id))
        throw new DomainError('unauthorized', 401, 'Investigator token is invalid or expired');
      const current = run(grant, original.id);
      if (!isCurrent(current, sourceId)) unavailable();
      if (current.state !== 'running')
        throw new DomainError('workflow-state-conflict', 409, 'Investigation is no longer active');
      abort.signal.throwIfAborted();
    });
  }

  app.post(management, async (request, reply) => {
    const owner = requireOwner(request, ownerMessage);
    const body = workflowBody(request.body, ['libraryIds', 'operations', 'ttlSeconds']);
    const libraryIds = stringList(body.libraryIds, 20);
    if (libraryIds.some((id) => !catalog.getLibrary(id))) unavailable();
    const operations = stringList(
      body.operations,
      investigatorOperations.length,
    ) as InvestigatorOperation[];
    if (operations.some((operation) => !investigatorOperations.includes(operation)))
      throw new DomainError('invalid-request', 400, 'Unknown investigator operation');
    const ttl = workflowInteger(body.ttlSeconds, 60, 86_400);
    const token = `ecs_inv_${issueToken().token}`;
    const credential = repo.create(owner.userId, hashToken(token), { libraryIds, operations }, ttl);
    reply.code(201).header('cache-control', noStore);
    return { credential, token };
  });
  app.get(management, async (request, reply) => {
    const owner = requireOwner(request, ownerMessage);
    reply.header('cache-control', noStore);
    return { items: repo.list(owner.userId) };
  });
  app.delete(`${management}/:credentialId`, async (request, reply) => {
    const owner = requireOwner(request, ownerMessage);
    repo.revoke(owner.userId, (request.params as { credentialId: string }).credentialId);
    return reply.code(204).header('cache-control', noStore).send();
  });

  app.register(
    (apiApp, _options, done) => {
      apiApp.addHook('onRequest', async (_request, reply) => {
        reply.header('cache-control', noStore);
      });

      apiApp.get('/libraries', async (request) => {
        const grant = requireOperation(request, 'inspect');
        return {
          items: grant.libraryIds.flatMap((id) => {
            const item = catalog.getLibrary(id);
            return item ? [{ id, name: item.name }] : [];
          }),
        };
      });
      apiApp.get('/libraries/:libraryId/sources', async (request) => {
        const entry = library(
          requireOperation(request, 'inspect'),
          (request.params as { libraryId: string }).libraryId,
        );
        const { cursor, limit } = page(request);
        return repo.sources(entry.id, cursor, limit);
      });
      apiApp.get('/diagnostics', async (request) => {
        const grant = requireOperation(request, 'diagnostics');
        return repo.diagnostics(grant.libraryIds.filter((id) => !!catalog.getLibrary(id)));
      });
      apiApp.post('/runs', async (request, reply) => {
        const grant = requireOperation(request, 'cleanup');
        const body = workflowBody(request.body, ['libraryId', 'sourceIds']);
        const { id: libraryId } = library(grant, workflowString(body.libraryId));
        const sourceIds = stringList(body.sourceIds, 100).sort();
        if (sourceIds.some((id) => catalog.getSource(id)?.libraryId !== libraryId)) unavailable();
        const now = Date.now();
        repo.expireRuns(now);
        const result = catalog.workflowRuns.createRun(
          {
            workflowId,
            workflowDigest,
            hostId: investigatorHostId(grant.id),
            scope: { libraryId, sourceIds },
            options: { online: false, checksum: false, shareImages: false },
          },
          grant.ownerId,
          now,
          undefined,
          'running',
        );
        reply.code(201);
        return { run: runSummary(result) };
      });
      apiApp.get('/runs/:runId', async (request) => {
        const result = run(
          requireOperation(request, 'cleanup'),
          (request.params as { runId: string }).runId,
        );
        return { run: runSummary(result) };
      });
      apiApp.post('/runs/:runId/cancel', async (request) => {
        const grant = requireOperation(request, 'cleanup');
        workflowBody(request.body, []);
        const result = run(grant, (request.params as { runId: string }).runId);
        return { run: runSummary(catalog.workflowRuns.cancelRun(result.id, grant.ownerId)) };
      });
      apiApp.post('/runs/:runId/finish', async (request) => {
        const grant = requireOperation(request, 'cleanup');
        workflowBody(request.body, []);
        const id = (request.params as { runId: string }).runId;
        const result = run(grant, id);
        if (result.state !== 'completed') repo.finish(id, result.hostId);
        return { run: runSummary(run(grant, id)) };
      });
      apiApp.post(
        '/runs/:runId/sources/:sourceId/inspect',
        { bodyLimit: 1024 },
        async (request) => {
          const grant = requireOperation(request, 'inspect');
          workflowBody(request.body, []);
          const { runId, sourceId } = request.params as { runId: string; sourceId: string };
          const result = run(grant, runId);
          const inspection = await evidenceFor(grant).search(result, sourceId, abort.signal);
          if (!repo.isActive(grant.id) || !isCurrent(result, sourceId)) unavailable();
          repo.markInspected(runId, result.hostId, sourceId);
          const { facts, candidates, problems } = inspection;
          return {
            ...inspection,
            facts: {
              ...facts,
              name: facts.name.slice(0, 512),
              selected: facts.selected
                .slice(0, 20)
                .map((match) => ({ ...match, title: match.title.slice(0, 240) })),
            },
            candidates: candidates
              .slice(0, 30)
              .map((candidate) => ({ ...candidate, title: candidate.title.slice(0, 240) })),
            problems: [
              ...problems.slice(0, 10),
              ...(candidates.length > 30 || facts.selected.length > 20
                ? [{ providerId: 'org.ecs.investigator-cleanup', code: 'inspection-limit' }]
                : []),
            ],
          };
        },
      );
      apiApp.post('/runs/:runId/suggestions', { bodyLimit: 16_384 }, async (request) => {
        const grant = requireOperation(request, 'suggest');
        const result = run(grant, (request.params as { runId: string }).runId);
        const body = workflowBody(request.body, [
          'sourceId',
          'kind',
          'reason',
          'candidateIds',
          'evidenceIds',
        ]);
        const sourceId = workflowString(body.sourceId);
        workflowString(body.reason, 512);
        if (
          !Array.isArray(body.candidateIds) ||
          body.candidateIds.length > 1 ||
          !Array.isArray(body.evidenceIds) ||
          body.evidenceIds.length > 5
        )
          throw new DomainError(
            'invalid-request',
            400,
            'Submit one evidence-backed suggestion at a time',
          );
        const suggested = await evidenceFor(grant).suggest(
          result,
          sourceId,
          [body],
          [],
          abort.signal,
        );
        return {
          findings: suggested.findings.map(findingSummary),
          proposals: suggested.proposals.map(proposalSummary),
        };
      });
      apiApp.get('/runs/:runId/findings', async (request) => {
        const result = run(
          requireOperation(request, 'inspect'),
          (request.params as { runId: string }).runId,
        );
        const { cursor, limit } = page(request);
        const { items, nextCursor } = catalog.workflowProposals.pageFindings(
          result.id,
          cursor,
          limit,
          true,
        );
        return { items: items.map(findingSummary), nextCursor };
      });
      apiApp.get('/runs/:runId/proposals', async (request) => {
        const result = run(
          requireOperation(request, 'inspect'),
          (request.params as { runId: string }).runId,
        );
        const { cursor, limit } = page(request);
        const { items, nextCursor } = catalog.workflowProposals.pageProposals(
          result.id,
          cursor,
          limit,
          true,
        );
        return { items: items.map(proposalSummary), nextCursor };
      });
      done();
    },
    { prefix: api },
  );
}
