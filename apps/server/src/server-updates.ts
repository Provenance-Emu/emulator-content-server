import { DomainError } from '@ecs/domain';
import type { ServerUpdateDecision, ServerUpdateSettings, ServerUpdateStatus } from '@ecs/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireOwner } from './http.js';

export interface ServerUpdates {
  status(): ServerUpdateStatus;
  configure(settings: ServerUpdateSettings): Promise<ServerUpdateStatus>;
  decide(decision: ServerUpdateDecision): Promise<ServerUpdateStatus>;
}

const path = '/api/v1/server/updates';

export function registerServerUpdates(app: FastifyInstance, updates?: ServerUpdates): void {
  const onRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    const message = 'Sign in as the server owner to manage server updates';
    if (!request.headers.authorization || requireOwner(request, message).tokenKind !== 'session') {
      throw new DomainError('forbidden', 403, message);
    }
    reply.header('cache-control', 'no-store');
  };
  app.get(
    path,
    { onRequest },
    async () =>
      updates?.status() ?? {
        supported: false,
        settings: { channel: 'release', mode: 'off' },
        phase: 'idle',
        prompt: false,
        message: 'Self-updates are available in supervised portable server packages.',
      },
  );
  app.put<{ Body: ServerUpdateSettings }>(
    path,
    {
      onRequest,
      schema: {
        body: {
          type: 'object',
          required: ['channel', 'mode'],
          properties: {
            channel: { enum: ['release', 'nightly'] },
            mode: { enum: ['off', 'manual', 'automatic'] },
          },
        },
      },
    },
    async (request) => {
      if (!updates)
        throw new DomainError('conflict', 409, 'This installation is managed externally');
      return updates.configure(request.body);
    },
  );
  app.post<{ Body: ServerUpdateDecision }>(
    path,
    {
      onRequest,
      schema: {
        body: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { enum: ['check', 'install', 'later', 'skip'] },
            buildId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          },
        },
      },
    },
    async (request) => {
      if (!updates)
        throw new DomainError('conflict', 409, 'This installation is managed externally');
      return updates.decide(request.body);
    },
  );
}
