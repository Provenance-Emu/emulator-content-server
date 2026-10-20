import { randomBytes, randomUUID } from 'node:crypto';
import { digestVerifiers } from '@ecs/auth';
import { DomainError } from '@ecs/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerContext } from './context.js';
import { jsonObject, requireActor, requiredString } from './http.js';

function session(request: FastifyRequest): string {
  const actor = requireActor(request);
  if (
    !/^Bearer\s+\S+$/.test(request.headers.authorization ?? '') ||
    actor.kind !== 'user' ||
    actor.localTrust ||
    actor.tokenKind !== 'session' ||
    !actor.scopes.includes('read')
  ) {
    throw new DomainError('forbidden', 403, 'An account session is required');
  }
  return actor.userId;
}
export function registerWebDavCredentials(app: FastifyInstance, context: ServerContext): void {
  app.get('/api/v1/webdav-credentials', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return { items: context.catalog.listWebDavCredentials(session(request)) };
  });
  app.post('/api/v1/webdav-credentials', async (request, reply) => {
    const userId = session(request);
    if (!context.webdavEnabled) throw new DomainError('conflict', 409, 'WebDAV is disabled');
    const body = jsonObject(request.body);
    const name = requiredString(body, 'name').trim();
    const seconds = body.expiresInSeconds ?? 90 * 86400;
    if (
      typeof seconds !== 'number' ||
      !Number.isSafeInteger(seconds) ||
      seconds < 60 ||
      seconds > 365 * 86400
    )
      throw new DomainError('invalid-body', 400, 'Credential lifetime is invalid');
    const username = `dav-${randomUUID()}`;
    const password = randomBytes(32).toString('base64url');
    const credential = context.catalog.createWebDavCredential({
      userId,
      name,
      username,
      ...digestVerifiers(username, password),
      expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
    });
    return reply.header('cache-control', 'no-store').code(201).send({ credential, password });
  });
  app.delete('/api/v1/webdav-credentials/:id', async (request, reply) => {
    const userId = session(request);
    const { id } = request.params as { id: string };
    if (!context.catalog.revokeWebDavCredential(id, userId))
      throw new DomainError('not-found', 404, 'Credential not found');
    return reply.header('cache-control', 'no-store').code(204).send();
  });
}
