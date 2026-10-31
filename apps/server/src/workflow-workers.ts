import { setTimeout as pause } from 'node:timers/promises';
import { DomainError, type WorkflowPublication } from '@ecs/domain';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './context.js';
import { requireAssignedWorkflow, requireWorkflowGrant } from './workflow-auth.js';
import { workflowBody, workflowInteger, workflowLease, workflowString } from './workflow-routes.js';

export function registerWorkflowWorkerRoutes(app: FastifyInstance, context: ServerContext): void {
  let closing = false;
  app.addHook('preClose', async () => {
    closing = true;
  });
  app.post('/api/v1/workflow-workers/advertise', async (request, reply) => {
    const principal = requireWorkflowGrant(request, 'advertise');
    const body = workflowBody(request.body, ['packages']);
    context.catalog.workflowIdentities.advertiseHost(
      principal.hostId,
      body.packages as import('@ecs/domain').WorkflowPackageSummary[],
    );
    reply.header('cache-control', 'private, no-store');
    return { host: context.catalog.workflowIdentities.getHost(principal.hostId) };
  });
  app.post('/api/v1/workflow-workers/claim', async (request, reply) => {
    const principal = requireWorkflowGrant(request, 'claim');
    const body = workflowBody(request.body, ['waitMs']);
    const waitMs = body.waitMs === undefined ? 0 : workflowInteger(body.waitMs, 0, 20_000);
    const deadline = Date.now() + waitMs;
    reply.header('cache-control', 'private, no-store');
    do {
      context.catalog.workflowRuns.recoverRuns();
      const lease = context.catalog.workflowRuns.claimRun(principal.hostId);
      if (lease) return { lease, run: context.catalog.workflowRuns.getRun(lease.runId) };
      if (closing || request.raw.aborted || Date.now() >= deadline) return {};
      await pause(Math.min(250, deadline - Date.now()));
    } while (!closing);
    return {};
  });
  app.get('/api/v1/workflow-workers/runs/:runId/work', async (request, reply) => {
    const run = requireAssignedWorkflow(
      context,
      request,
      (request.params as { runId: string }).runId,
      'read-work',
    );
    const query = request.query as { cursor?: string; limit?: string };
    reply.header('cache-control', 'private, no-store');
    return context.catalog.workflowRuns.pagePendingWork(
      run.id,
      query.cursor,
      query.limit === undefined ? 50 : workflowInteger(Number(query.limit), 1, 100),
    );
  });
  app.post('/api/v1/workflow-workers/heartbeat', async (request, reply) => {
    const body = workflowBody(request.body, ['lease']);
    const lease = workflowLease(body.lease);
    requireAssignedWorkflow(context, request, lease.runId, 'heartbeat');
    if (lease.hostId !== request.workflowPrincipal?.hostId)
      throw new DomainError('forbidden', 403, 'This credential belongs to another host');
    reply.header('cache-control', 'private, no-store');
    return { lease: context.catalog.workflowRuns.heartbeat(lease) };
  });
  app.post('/api/v1/workflow-workers/publish', async (request, reply) => {
    const body = workflowBody(request.body, ['lease', 'publication']);
    const lease = workflowLease(body.lease);
    requireAssignedWorkflow(context, request, lease.runId, 'publish');
    if (lease.hostId !== request.workflowPrincipal?.hostId)
      throw new DomainError('forbidden', 403, 'This credential belongs to another host');
    const publication = workflowBody(body.publication, [
      'sequence',
      'checkpointRef',
      'completedSourceIds',
      'state',
      'sourceOutputs',
    ]);
    workflowInteger(publication.sequence, 1);
    workflowString(publication.checkpointRef);
    if (
      !Array.isArray(publication.completedSourceIds) ||
      publication.completedSourceIds.length > 50
    )
      throw new DomainError('invalid-request', 400, 'Invalid workflow work results');
    publication.completedSourceIds.forEach((id) => {
      workflowString(id);
    });
    reply.header('cache-control', 'private, no-store');
    return {
      run: context.catalog.workflowRuns.publish(
        lease,
        publication as unknown as WorkflowPublication,
      ),
    };
  });
  app.post('/api/v1/workflow-workers/interrupt', async (request, reply) => {
    const body = workflowBody(request.body, ['lease', 'recoveryRequired']);
    const lease = workflowLease(body.lease);
    requireAssignedWorkflow(context, request, lease.runId, 'publish');
    if (lease.hostId !== request.workflowPrincipal?.hostId)
      throw new DomainError('forbidden', 403, 'This credential belongs to another host');
    if (typeof body.recoveryRequired !== 'boolean')
      throw new DomainError('invalid-request', 400, 'Invalid workflow recovery status');
    reply.header('cache-control', 'private, no-store');
    return { run: context.catalog.workflowRuns.interrupt(lease, body.recoveryRequired) };
  });
}
