import type { Actor } from '@ecs/domain';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

export type { Actor };
