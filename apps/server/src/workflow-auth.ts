import { type WorkflowPrincipal, workflowGrantAllows } from '@ecs/auth';
import { DomainError, type WorkflowRun } from '@ecs/domain';
import type { FastifyRequest } from 'fastify';
import type { ServerContext } from './context.js';

export function authenticateWorkflowPrincipal(
  context: ServerContext,
  tokenHash: string,
): WorkflowPrincipal | null {
  const host = context.catalog.workflowIdentities.authenticateHost(tokenHash);
  return host ? { kind: 'workflow-host', hostId: host.id, ownerId: host.ownerId } : null;
}
export function requireWorkflowGrant(
  request: FastifyRequest,
  action: string,
  run?: WorkflowRun,
): WorkflowPrincipal {
  const principal = request.workflowPrincipal;
  if (!principal || !workflowGrantAllows(principal, action, run))
    throw new DomainError('forbidden', 403, 'This credential cannot perform that workflow action');
  return principal;
}
export function requireAssignedWorkflow(
  context: ServerContext,
  request: FastifyRequest,
  runId: string,
  action: string,
): WorkflowRun {
  const run = context.catalog.workflowRuns.getRun(runId);
  if (!run) throw new DomainError('not-found', 404, 'Workflow run not found');
  requireWorkflowGrant(request, action, run);
  const owner = context.catalog.actorForUser(run.actorId);
  if (owner?.kind !== 'user' || !owner.isOwner)
    throw new DomainError('forbidden', 403, 'Workflow creator is unavailable');
  return run;
}
