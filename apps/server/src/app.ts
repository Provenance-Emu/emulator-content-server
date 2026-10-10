import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { hashToken, RateLimiter } from '@ecs/auth';
import { CatalogDatabase, type CatalogLimits } from '@ecs/database';
import { DomainError } from '@ecs/domain';
import { problem } from '@ecs/protocol';
import { ensureLayout, VirtualProviderRegistry } from '@ecs/storage';
import Fastify, { type FastifyInstance } from 'fastify';
import './actor.js';
import type { ServerContext } from './context.js';
import { sendProblem } from './http.js';
import { registerRoutes } from './routes.js';

export interface OpenServerOptions {
  dataDir: string;
  displayName?: string;
  limits?: Partial<CatalogLimits>;
  logger?: boolean;
  loginLimit?: number;
}

export async function openServer(options: OpenServerOptions): Promise<{
  app: FastifyInstance;
  catalog: CatalogDatabase;
  close: () => Promise<void>;
}> {
  await ensureLayout(options.dataDir);
  const catalog = new CatalogDatabase(join(options.dataDir, 'library.sqlite'), options.limits);
  const context: ServerContext = {
    catalog,
    dataDir: options.dataDir,
    displayName: options.displayName ?? 'Emulator Content Server',
    virtual: new VirtualProviderRegistry(),
    limiter: new RateLimiter(options.loginLimit ?? 10, 60_000),
  };
  const app = buildApp(context, options.logger ?? false);
  return {
    app,
    catalog,
    close: async () => {
      await app.close();
      catalog.close();
    },
  };
}

export function buildApp(context: ServerContext, logger = false): FastifyInstance {
  context.catalog.ensureServer(context.displayName);
  const app = Fastify({
    logger: logger
      ? {
          level: 'info',
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie'],
            censor: '[redacted]',
          },
        }
      : false,
    genReqId(request) {
      const header = request.headers['x-request-id'];
      if (typeof header === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(header)) return header;
      return randomUUID();
    },
    bodyLimit: 1024 * 1024,
  });
  app.decorateRequest('actor', null);
  app.addContentTypeParser(
    'application/octet-stream',
    { bodyLimit: context.catalog.limits.maxUploadBytes },
    (_request, payload, done) => {
      done(null, payload);
    },
  );
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    request.actor = null;
    const header = request.headers.authorization;
    if (!header) return;
    const match = /^Bearer\s+(\S+)$/.exec(header);
    if (!match?.[1]) throw new DomainError('unauthorized', 401, 'Bearer token is required');
    const actor = context.catalog.authenticate(hashToken(match[1]));
    if (!actor) throw new DomainError('unauthorized', 401, 'Token is invalid or expired');
    request.actor = actor;
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) return sendProblem(reply, error, request);
    const statusCode =
      typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500;
    if (statusCode >= 400 && statusCode < 500) {
      return reply
        .status(statusCode)
        .type('application/problem+json')
        .send(
          problem({
            code: statusCode === 413 ? 'quota-exceeded' : 'invalid-body',
            title: statusCode === 413 ? 'Payload Too Large' : 'Bad Request',
            status: statusCode,
            instance: request.url,
            requestId: request.id,
          }),
        );
    }
    request.log.error({ err: error }, 'request failed');
    return reply
      .status(500)
      .type('application/problem+json')
      .send(
        problem({
          code: 'internal',
          title: 'Internal Server Error',
          status: 500,
          instance: request.url,
          requestId: request.id,
        }),
      );
  });
  registerRoutes(app, context);
  return app;
}
