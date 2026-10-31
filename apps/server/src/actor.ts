import type { WorkflowPrincipal } from '@ecs/auth';
import type { Actor } from '@ecs/domain';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
    workflowPrincipal: WorkflowPrincipal | null;
  }
}

export type { Actor };
