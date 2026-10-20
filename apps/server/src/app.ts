import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { hashToken, RateLimiter } from '@ecs/auth';
import { CatalogDatabase, type CatalogLimits } from '@ecs/database';
import { DomainError } from '@ecs/domain';
import { problem } from '@ecs/protocol';
import { ensureLayout, VirtualProviderRegistry, ZipProvider } from '@ecs/storage';
import Fastify, { type FastifyInstance } from 'fastify';
import './actor.js';
import type { ServerContext } from './context.js';
import { sendProblem } from './http.js';
import { admitLocal, trayOrigin } from './local-access.js';
import { registerRoutes } from './routes.js';
import { davAuthenticator, isDavRequest, registerWebDav } from './webdav.js';
import { registerWebDavCredentials } from './webdav-credentials.js';

export interface OpenServerOptions {
  dataDir: string;
  displayName?: string;
  webdavEnabled?: boolean;
  uiDir?: string | null;
  limits?: Partial<CatalogLimits>;
  logger?: boolean;
  loginLimit?: number;
  /** Defaults to true. Pass false when the process is bound for the public internet. */
  localTrust?: boolean;
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
    webdavEnabled: options.webdavEnabled === true,
    displayName: options.displayName ?? 'Emulator Content Server',
    virtual: new VirtualProviderRegistry([new ZipProvider()]),
    limiter: new RateLimiter(options.loginLimit ?? 10, 60_000),
    uiDir: options.uiDir ?? null,
    localTrust: options.localTrust !== false,
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
  const authenticateDav = davAuthenticator(context);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    if (isDavRequest(request.raw.url ?? request.url)) {
      if (!context.webdavEnabled) return reply.code(404).send({ status: 404, title: 'Not Found' });
      return authenticateDav(request, reply);
    }
    const origin = request.headers.origin;
    if (trayOrigin(typeof origin === 'string' ? origin : undefined)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'origin');
      reply.header(
        'access-control-allow-headers',
        'authorization, content-type, accept, idempotency-key, if-none-match, if-range, range',
      );
      reply.header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
      if (request.method === 'OPTIONS') return reply.status(204).send();
    }
    request.actor = null;
    const header = request.headers.authorization;
    if (header) {
      const match = /^Bearer\s+(\S+)$/.exec(header);
      if (!match?.[1]) throw new DomainError('unauthorized', 401, 'Bearer token is required');
      const actor = context.catalog.authenticate(hashToken(match[1]));
      if (!actor) throw new DomainError('unauthorized', 401, 'Token is invalid or expired');
      request.actor = actor;
      return;
    }
    request.actor = admitLocal(context, request);
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
  registerWebDav(app, context);
  registerRoutes(app, context);
  registerWebDavCredentials(app, context);
  return app;
}
