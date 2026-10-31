import type { WorkflowProposalVersion } from '@ecs/database';
import { type Actor, DomainError, type WorkflowApplication } from '@ecs/domain';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './context.js';
import { requireOwner } from './http.js';
import { localSource } from './source-groups.js';
import { sourceMetadata } from './source-metadata.js';
import { workflowBody, workflowInteger, workflowString } from './workflow-routes.js';
import { workflowHash } from './workflow-values.js';

export async function applyWorkflowApproval(
  context: ServerContext,
  approvalId: string,
  applicationId: string,
  actor: Actor & { kind: 'user' },
): Promise<WorkflowApplication[]> {
  const approval = context.catalog.workflowApplications.beginApplication(
    approvalId,
    applicationId,
    actor.userId,
  );
  const versions = JSON.parse(approval.proposalVersionsJson) as WorkflowProposalVersion[];
  const groups = new Set<string>();
  for (const version of versions) {
    const proposal = context.catalog.workflowProposals.getProposal(version.id, version.version);
    if (!proposal || proposal.runId !== approval.runId || proposal.digest !== version.digest)
      throw new DomainError('workflow-proposal-conflict', 409, 'Reviewed proposals changed');
    groups.add(proposal.sourceId);
  }
  const applications: WorkflowApplication[] = [];
  for (const sourceId of [...groups].sort()) {
    const existing = context.catalog.workflowApplications.getApplication(applicationId, sourceId);
    if (existing) {
      applications.push(existing);
      continue;
    }
    try {
      if (!context.catalog.workflowRuns.sourceIsCurrent(approval.runId, sourceId))
        throw new DomainError('workflow-source-changed', 409, 'Source or library changed');
      const file = await localSource(context, actor, sourceId);
      const sourceValidator = workflowHash((await sourceMetadata(file.path, sourceId)).etag);
      applications.push(
        context.catalog.workflowApplications.applySourceProposalGroup({
          approvalId,
          applicationId,
          sourceId,
          actorId: actor.userId,
          sourceValidator,
        }),
      );
    } catch (error) {
      if (!(error instanceof DomainError) || ![404, 409, 503].includes(error.status)) throw error;
      applications.push(
        context.catalog.workflowApplications.recordConflict(
          approvalId,
          applicationId,
          sourceId,
          actor.userId,
          error.code,
        ),
      );
    }
  }
  return applications;
}

export async function undoWorkflowApplication(
  context: ServerContext,
  applicationId: string,
  sourceId: string,
  actor: Actor & { kind: 'user' },
): Promise<WorkflowApplication> {
  const receipt = context.catalog.workflowApplications.getApplication(applicationId, sourceId);
  if (!receipt) throw new DomainError('not-found', 404, 'Application unavailable');
  const approval = context.catalog.workflowApplications.getApproval(receipt.approvalId);
  if (approval?.actorId !== actor.userId)
    throw new DomainError('forbidden', 403, 'This approval belongs to another owner');
  if (!['applied', 'undone'].includes(receipt.status))
    throw new DomainError('workflow-undo-conflict', 409, 'Only an applied cleanup can be undone');
  if (receipt.status !== 'undone') {
    const file = await localSource(context, actor, sourceId);
    const currentValidator = workflowHash((await sourceMetadata(file.path, sourceId)).etag);
    if (currentValidator !== JSON.parse(receipt.resultJson).sourceValidator)
      throw new DomainError(
        'workflow-undo-conflict',
        409,
        'Source changed; the current selection was preserved',
      );
  }
  return context.catalog.workflowApplications.undoWorkflowApplication(
    applicationId,
    sourceId,
    actor.userId,
  );
}

export function registerWorkflowApprovals(app: FastifyInstance, context: ServerContext): void {
  const owner = 'Only the server owner can approve or apply library cleanup';
  app.post('/api/v1/workflow-runs/:runId/approvals', async (request, reply) => {
    const actor = requireOwner(request, owner);
    const body = workflowBody(request.body, ['runRevision', 'proposals']);
    if (!Array.isArray(body.proposals) || body.proposals.length < 1 || body.proposals.length > 100)
      throw new DomainError('invalid-request', 400, 'Choose up to 100 exact proposal versions');
    const versions = body.proposals.map((value) => {
      const version = workflowBody(value, ['id', 'version', 'digest']);
      return {
        id: workflowString(version.id),
        version: workflowInteger(version.version, 1),
        digest: workflowString(version.digest, 64),
      };
    });
    const key = workflowString(request.headers['idempotency-key']);
    const approval = context.catalog.workflowApplications.approveWorkflowBatch(
      (request.params as { runId: string }).runId,
      workflowInteger(body.runRevision, 1),
      versions,
      actor.userId,
      key,
    );
    reply.code(201).header('cache-control', 'private, no-store');
    return { approval };
  });
  app.get('/api/v1/workflow-approvals/:approvalId', async (request, reply) => {
    requireOwner(request, owner);
    const approval = context.catalog.workflowApplications.getApproval(
      (request.params as { approvalId: string }).approvalId,
    );
    if (!approval) throw new DomainError('not-found', 404, 'Approval unavailable');
    reply.header('cache-control', 'private, no-store');
    return { approval };
  });
  app.post('/api/v1/workflow-approvals/:approvalId/apply', async (request, reply) => {
    const actor = requireOwner(request, owner),
      body = workflowBody(request.body, ['applicationId']);
    const applications = await applyWorkflowApproval(
      context,
      (request.params as { approvalId: string }).approvalId,
      workflowString(body.applicationId),
      actor,
    );
    reply.header('cache-control', 'private, no-store');
    return { applications };
  });
  app.get('/api/v1/workflow-applications/:applicationId', async (request, reply) => {
    const actor = requireOwner(request, owner);
    reply.header('cache-control', 'private, no-store');
    return {
      applications: context.catalog.workflowApplications.applications(
        (request.params as { applicationId: string }).applicationId,
        actor.userId,
      ),
    };
  });
  app.get('/api/v1/workflow-runs/:runId/applications', async (request, reply) => {
    requireOwner(request, owner);
    const runId = (request.params as { runId: string }).runId;
    if (!context.catalog.workflowRuns.getRun(runId))
      throw new DomainError('not-found', 404, 'Workflow run unavailable');
    const query = request.query as { cursor?: string; limit?: string };
    reply.header('cache-control', 'private, no-store');
    return context.catalog.workflowApplications.runApplications(
      runId,
      query.cursor,
      query.limit === undefined ? 20 : workflowInteger(Number(query.limit), 1, 100),
    );
  });
  app.post(
    '/api/v1/workflow-applications/:applicationId/sources/:sourceId/undo',
    async (request, reply) => {
      const actor = requireOwner(request, owner);
      workflowBody(request.body, []);
      const { applicationId, sourceId } = request.params as {
        applicationId: string;
        sourceId: string;
      };
      const application = await undoWorkflowApplication(context, applicationId, sourceId, actor);
      reply.header('cache-control', 'private, no-store');
      return { application };
    },
  );
}
