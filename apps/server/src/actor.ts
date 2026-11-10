import type { WorkflowPrincipal } from '@ecs/auth';
import type { InvestigatorPrincipal } from '@ecs/database';
import type { Actor } from '@ecs/domain';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
    investigator: InvestigatorPrincipal | null;
    workflowPrincipal: WorkflowPrincipal | null;
  }
}

export type { Actor };
