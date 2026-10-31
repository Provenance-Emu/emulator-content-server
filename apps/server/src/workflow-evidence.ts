import { type Actor, DomainError, type WorkflowEvidence, type WorkflowRun } from '@ecs/domain';
import {
  automaticEvidence,
  compatibleCatalogIdentity,
  hasIdentityConflict,
  type MatchCandidate,
} from '@ecs/plugins/matching';
import { validateCleanupObservation } from '@ecs/plugins/workflows';
import type { WorkflowCatalogResult, WorkflowSourceFacts } from '@ecs/protocol';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './context.js';
import { describeRaster } from './matching-files.js';
import { localSource, visibleSource } from './source-groups.js';
import type { MatchingInspection, SourceMatchingService } from './source-matching.js';
import { sourceMetadata } from './source-metadata.js';
import { materializeCleanupProposal, type WorkflowCandidateRecord } from './workflow-artifacts.js';
import { requireAssignedWorkflow } from './workflow-auth.js';
import { workflowBody, workflowString } from './workflow-routes.js';
import { workflowHash } from './workflow-values.js';

export interface WorkflowInspectionRecord {
  type: 'inspection';
  inspection: MatchingInspection;
  result: WorkflowCatalogResult;
}
export function validateWorkflowSuggestion(value: unknown, knownEvidence: ReadonlySet<string>) {
  const observation = validateCleanupObservation(value);
  if (
    !observation.evidenceIds.length ||
    observation.evidenceIds.some((id) => !knownEvidence.has(id))
  )
    throw new DomainError('invalid-request', 400, 'Observation needs known server evidence');
  return observation;
}
export function createWorkflowEvidenceService(
  context: ServerContext,
  matching: SourceMatchingService,
) {
  function scoped(run: WorkflowRun, sourceId: string): Actor & { kind: 'user' } {
    if (run.state !== 'running')
      throw new DomainError('workflow-state-conflict', 409, 'This inspection run is not active');
    if (!context.catalog.workflowRuns.sourceSnapshot(run.id, sourceId))
      throw new DomainError('not-found', 404, 'Source is outside this workflow run');
    if (!context.catalog.workflowRuns.sourceIsCurrent(run.id, sourceId))
      throw new DomainError(
        'workflow-source-changed',
        409,
        'Source location or library changed; start a fresh inspection',
      );
    const actor = context.catalog.actorForUser(run.actorId);
    if (!actor?.isOwner) throw new DomainError('forbidden', 403, 'Workflow creator is unavailable');
    visibleSource(context, actor, sourceId);
    return actor;
  }
  function evidence(
    run: WorkflowRun,
    sourceId: string,
    kind: WorkflowEvidence['kind'],
    sourceValidator: string,
    payload: unknown,
    providerId: string | null = null,
  ): WorkflowEvidence {
    const payloadJson = JSON.stringify(payload);
    return context.catalog.workflowProposals.recordEvidence({
      id: workflowHash([run.id, sourceId, kind, sourceValidator, providerId, payload]),
      runId: run.id,
      sourceId,
      kind,
      sourceValidator,
      providerId,
      payloadJson,
    });
  }
  async function facts(run: WorkflowRun, sourceId: string): Promise<WorkflowSourceFacts> {
    const actor = scoped(run, sourceId);
    const file = await localSource(context, actor, sourceId);
    const source = visibleSource(context, actor, sourceId);
    const selected = context.catalog.sourceMatches(sourceId);
    const sourceValidator = workflowHash((await sourceMetadata(file.path, sourceId)).etag);
    function contentAvailable(match: (typeof selected.matches)[number]): boolean {
      if (
        match.kind !== 'artwork' ||
        (match.artworkRole ?? match.metadata.artworkRole ?? 'front') !== 'front'
      )
        return match.contentAvailable;
      const bytes = context.catalog.sourceMatchContent(sourceId, 'artwork', 'front');
      if (!match.contentAvailable || !bytes) return false;
      try {
        describeRaster(Buffer.from(bytes));
        return true;
      } catch {
        return false;
      }
    }
    const result: WorkflowSourceFacts = {
      sourceId,
      name: source.displayName,
      systemId: source.systemId,
      sourceValidator,
      selectionRevision: selected.revision,
      currentValueDigest: workflowHash(selected),
      selected: selected.matches.map((m) => ({
        id: m.id,
        kind: m.kind,
        title: m.title,
        systemId: m.metadata.systemId ?? null,
        artworkRole:
          m.kind === 'artwork' ? (m.artworkRole ?? m.metadata.artworkRole ?? 'front') : null,
        contentAvailable: contentAvailable(m),
        identityConflict: false,
      })),
      evidenceIds: [],
    };
    const receipt = evidence(run, sourceId, 'source-fact', sourceValidator, {
      type: 'facts',
      facts: result,
    });
    return { ...result, evidenceIds: [receipt.id] };
  }
  async function search(
    run: WorkflowRun,
    sourceId: string,
    signal: AbortSignal,
  ): Promise<WorkflowCatalogResult> {
    const actor = scoped(run, sourceId);
    const current = await facts(run, sourceId);
    for (const receipt of context.catalog.workflowProposals.sourceEvidence(run.id, sourceId)) {
      const payload = JSON.parse(receipt.payloadJson) as Partial<WorkflowInspectionRecord>;
      if (
        payload.type !== 'inspection' ||
        !payload.result ||
        !payload.inspection ||
        receipt.sourceValidator !== current.sourceValidator ||
        payload.result.facts.currentValueDigest !== current.currentValueDigest ||
        workflowHash(
          payload.result.facts.selected.map(({ identityConflict: _conflict, ...value }) => value),
        ) !==
          workflowHash(current.selected.map(({ identityConflict: _conflict, ...value }) => value))
      )
        continue;
      try {
        await matching.validateInspection(actor, payload.inspection.stamps);
        return payload.result;
      } catch {
        /* Changed companions require a new immutable inspection. */
      }
    }
    const inspection = await matching.inspect(
      actor,
      sourceId,
      {
        online: run.options.online,
        checksum: run.options.checksum,
        allowExactNames: true,
        ...(run.options.providerIds ? { providerIds: run.options.providerIds } : {}),
      },
      signal,
    );
    if (!inspection.stamps[sourceId])
      throw new DomainError('source-offline', 409, 'Source cannot be validated locally');
    await matching.validateInspection(actor, inspection.stamps);
    const after = await facts(run, sourceId);
    if (
      after.sourceValidator !== current.sourceValidator ||
      after.currentValueDigest !== current.currentValueDigest
    )
      throw new DomainError(
        'workflow-source-changed',
        409,
        'Source or saved details changed during inspection',
      );
    const selected = context.catalog.sourceMatches(sourceId);
    const metadata = selected.matches.find((m) => m.kind === 'metadata');
    const result: WorkflowCatalogResult = {
      facts: {
        ...current,
        selected: current.selected.map((s) => {
          const raw = selected.matches.find((m) => m.id === s.id);
          return {
            ...s,
            identityConflict:
              !!raw &&
              hasIdentityConflict(inspection.input, [
                { ...raw, confidence: 'name' } as MatchCandidate,
              ]),
          };
        }),
      },
      candidates: [],
      problems: [...inspection.problems],
      supportedIdentity: !!(
        inspection.input.facts?.hashes.some((h) => h.verified) ||
        inspection.input.facts?.identifiers.some((i) => i.verified)
      ),
    };
    const candidates = inspection.candidates.filter((c) =>
      ['rom', 'metadata', 'artwork'].includes(c.kind),
    );
    if (candidates.length > 200)
      result.problems.push({ providerId: 'org.ecs.cleanup', code: 'catalog-limit' });
    for (const raw of candidates.slice(0, 200)) {
      const { id: _randomId, ...content } = raw;
      const candidate = {
        ...content,
        id: workflowHash([run.id, sourceId, current.sourceValidator, content]),
      };
      const receipt = evidence(
        run,
        sourceId,
        'catalog',
        current.sourceValidator,
        {
          type: 'candidate',
          candidate,
          input: inspection.input,
          stamps: inspection.stamps,
          selectionRevision: current.selectionRevision,
        },
        candidate.providerId,
      );
      const eligible = automaticEvidence(
        { ...inspection.input, allowExactNames: false },
        candidate,
      );
      const mode = candidate.metadata.matchEvidence;
      result.candidates.push({
        id: candidate.id,
        kind: candidate.kind,
        title: candidate.title,
        systemId: candidate.metadata.systemId ?? null,
        artworkRole:
          candidate.kind === 'artwork' ? (candidate.metadata.artworkRole ?? 'front') : null,
        providerId: candidate.providerId,
        evidenceClass:
          eligible && ['verified-hash', 'verified-serial'].includes(mode ?? '')
            ? 'verified-source'
            : eligible && mode === 'saved-selection'
              ? 'saved-selection'
              : candidate.confidence === 'local'
                ? 'local'
                : candidate.confidence === 'name'
                  ? 'filename'
                  : 'unverified',
        identityConflict: hasIdentityConflict(inspection.input, [candidate]),
        agreesWithSelection:
          !!metadata && compatibleCatalogIdentity(inspection.input, candidate, metadata),
        evidenceIds: [receipt.id],
      });
    }
    evidence(run, sourceId, 'source-fact', current.sourceValidator, {
      type: 'inspection',
      inspection,
      result,
    } satisfies WorkflowInspectionRecord);
    return result;
  }
  async function suggest(
    run: WorkflowRun,
    sourceId: string,
    input: unknown[],
    proposals: unknown[] = [],
    signal: AbortSignal = new AbortController().signal,
  ) {
    scoped(run, sourceId);
    let observations: ReturnType<typeof validateCleanupObservation>[];
    try {
      const parsed = input.map(validateCleanupObservation);
      const known = new Set(
        parsed
          .flatMap((o) => o.evidenceIds)
          .filter((id) => context.catalog.workflowProposals.getEvidence(run.id, sourceId, id)),
      );
      observations = parsed.map((value) => validateWorkflowSuggestion(value, known));
    } catch {
      throw new DomainError('invalid-request', 400, 'Invalid cleanup observations');
    }
    if (observations.some((o) => o.sourceId !== sourceId))
      throw new DomainError('invalid-request', 400, 'Observation is outside this source');
    const current = await facts(run, sourceId);
    const drafts = observations.map((observation) => {
      if (!observation.evidenceIds.length)
        throw new DomainError('invalid-request', 400, 'Observations need server evidence');
      const payloads = observation.evidenceIds.map((id) => {
        const receipt = context.catalog.workflowProposals.getEvidence(run.id, sourceId, id);
        if (!receipt || receipt.sourceValidator !== current.sourceValidator)
          throw new DomainError('invalid-request', 400, 'Unknown or stale observation evidence');
        const payload = JSON.parse(receipt.payloadJson);
        if (payload.type === 'facts') {
          if (payload.facts.currentValueDigest !== current.currentValueDigest)
            throw new DomainError(
              'workflow-selection-changed',
              409,
              'Saved details changed; inspect again',
            );
          return payload;
        }
        if (payload.type !== 'candidate' || payload.selectionRevision !== current.selectionRevision)
          throw new DomainError('invalid-request', 400, 'Unknown or stale candidate evidence');
        const { id: _id, ...candidate } = payload.candidate;
        return { ...payload, candidate };
      });
      for (const id of observation.candidateIds) {
        if (
          !observation.evidenceIds.some((evidenceId) => {
            const receipt = context.catalog.workflowProposals.getEvidence(
              run.id,
              sourceId,
              evidenceId,
            );
            return receipt && JSON.parse(receipt.payloadJson).candidate?.id === id;
          })
        )
          throw new DomainError(
            'invalid-request',
            400,
            'Candidate is not supported by this observation',
          );
      }
      return {
        ...observation,
        ruleVersion: 'cleanup/1',
        currentValueDigest: current.currentValueDigest,
        evidenceDigest: workflowHash(payloads.map((payload) => workflowHash(payload)).sort()),
      };
    });
    const findings = drafts.map((draft) =>
      context.catalog.workflowProposals.addFinding(run.id, draft),
    );
    const materialized = [];
    for (let index = 0; index < observations.length; index++) {
      const observation = observations[index],
        finding = findings[index];
      if (!observation || !finding || finding.dismissed) continue;
      for (const candidateId of observation.candidateIds) {
        const receipt = observation.evidenceIds
          .map((id) => context.catalog.workflowProposals.getEvidence(run.id, sourceId, id))
          .find(
            (receipt) => receipt && JSON.parse(receipt.payloadJson).candidate?.id === candidateId,
          );
        if (!receipt) throw new DomainError('invalid-request', 400, 'Unknown candidate receipt');
        const candidate = (JSON.parse(receipt.payloadJson) as WorkflowCandidateRecord).candidate;
        const action =
          candidate.kind === 'metadata'
            ? 'replace-metadata'
            : candidate.kind === 'rom'
              ? 'replace-system'
              : 'replace-front-artwork';
        materialized.push(
          await materializeCleanupProposal(
            context,
            run,
            {
              sourceId,
              findingId: finding.id,
              action,
              candidateId,
              evidenceIds: observation.evidenceIds,
              reason: observation.reason,
            },
            matching,
            signal,
          ),
        );
      }
    }
    for (const value of proposals) {
      if (
        !value ||
        typeof value !== 'object' ||
        (value as { sourceId?: unknown }).sourceId !== sourceId
      )
        throw new DomainError('invalid-request', 400, 'Proposal is outside this source');
      materialized.push(
        await materializeCleanupProposal(
          context,
          run,
          value as Parameters<typeof materializeCleanupProposal>[2],
          matching,
          signal,
        ),
      );
    }
    return { findings, proposals: materialized };
  }
  return { facts, search, suggest };
}

export function registerWorkflowEvidence(
  app: FastifyInstance,
  context: ServerContext,
  matching: SourceMatchingService,
) {
  const service = createWorkflowEvidenceService(context, matching);
  const abort = new AbortController();
  app.addHook('preClose', async () => {
    abort.abort();
  });
  const path = '/api/v1/workflow-workers/runs/:runId/sources/:sourceId';
  app.get(`${path}/facts`, async (request, reply) => {
    const { runId, sourceId } = request.params as { runId: string; sourceId: string };
    const run = requireAssignedWorkflow(context, request, runId, 'read-work');
    reply.header('cache-control', 'private, no-store');
    return service.facts(run, sourceId);
  });
  app.post(`${path}/catalog`, async (request, reply) => {
    workflowBody(request.body, []);
    const { runId, sourceId } = request.params as { runId: string; sourceId: string };
    const run = requireAssignedWorkflow(context, request, runId, 'read-work');
    reply.header('cache-control', 'private, no-store');
    return service.search(run, sourceId, abort.signal);
  });
  app.post('/api/v1/workflow-workers/runs/:runId/suggestions', async (request, reply) => {
    const body = workflowBody(request.body, ['sourceId', 'observations', 'proposals']);
    const sourceId = workflowString(body.sourceId);
    if (!Array.isArray(body.observations) || body.observations.length > 100)
      throw new DomainError('invalid-request', 400, 'Invalid cleanup observations');
    if (
      body.proposals !== undefined &&
      (!Array.isArray(body.proposals) || body.proposals.length > 10)
    )
      throw new DomainError('invalid-request', 400, 'Invalid cleanup proposals');
    const run = requireAssignedWorkflow(
      context,
      request,
      (request.params as { runId: string }).runId,
      'publish',
    );
    reply.header('cache-control', 'private, no-store');
    return service.suggest(
      run,
      sourceId,
      body.observations,
      body.proposals as unknown[] | undefined,
      abort.signal,
    );
  });
  return service;
}
