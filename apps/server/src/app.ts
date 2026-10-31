import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { hashToken, RateLimiter } from '@ecs/auth';
import { CatalogDatabase, type CatalogLimits } from '@ecs/database';
import { DomainError } from '@ecs/domain';
import { problem } from '@ecs/protocol';
import {
  type ChdProviderOptions,
  createChdProvider,
  ensureLayout,
  VirtualProviderRegistry,
  ZipProvider,
} from '@ecs/storage';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { stopLibraryJobs } from './library-jobs.js';
import { PlayerManager, registerPlayerManagement } from './player-manager.js';
import './actor.js';
import type { ServerContext } from './context.js';
import { registerFolderWatchRoutes } from './folder-watch-routes.js';
import { FolderWatcher } from './folder-watcher.js';
import { sendProblem } from './http.js';
import { admitLocal, peerAddress, trayOrigin } from './local-access.js';
import { loadPlayerAssets, registerPlayerAssets } from './player-assets.js';
import { loadPlayerProfiles } from './player-profiles.js';
import { registerRoutes } from './routes.js';
import { davAuthenticator, isDavRequest, registerWebDav } from './webdav.js';
import { registerWebDavCredentials } from './webdav-credentials.js';
import { authenticateWorkflowPrincipal } from './workflow-auth.js';

export interface OpenServerOptions {
  dataDir: string;
  /** Trusted operator-installed matching provider and manager directory. */
  matchingPluginsDir?: string;
  /** Trusted native read adapters for identification only; omitted paths are discovered locally. */
  matchingTools?: { sevenZip?: string; chdman?: string };
  /** Optional operator-owned absolute native decoder path; omitted means ZIP only. */
  chdmanPath?: string;
  /** Process-runner injection for portable decoder tests. */
  chdProviderOptions?: ChdProviderOptions;
  displayName?: string;
  webdavEnabled?: boolean;
  uiDir?: string | null;
  /** Trusted static browser core directory; absent means no playback or filesystem probe. */
  playerDir?: string;
  /** Data-only browser player plugin registry. Nothing is executed by the server. */
  playerPluginsDir?: string;
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
  const player =
    options.playerDir === undefined ? undefined : await loadPlayerAssets(options.playerDir);
  const profiles = await loadPlayerProfiles(options.playerPluginsDir, player);
  await ensureLayout(options.dataDir);
  const dataDir = await realpath(options.dataDir);
  const virtual = new VirtualProviderRegistry([
    new ZipProvider(),
    ...(options.chdmanPath === undefined
      ? []
      : [await createChdProvider(options.chdmanPath, options.chdProviderOptions)]),
  ]);
  let catalog: CatalogDatabase;
  try {
    catalog = new CatalogDatabase(join(dataDir, 'library.sqlite'), options.limits);
  } catch (error) {
    await virtual.close();
    throw error;
  }
  const context: ServerContext = {
    catalog,
    ...(options.matchingPluginsDir ? { matchingPluginsDir: options.matchingPluginsDir } : {}),
    ...(options.matchingTools || options.chdmanPath
      ? {
          matchingTools: {
            ...options.matchingTools,
            ...(options.chdmanPath ? { chdman: options.chdmanPath } : {}),
          },
        }
      : {}),
    player,
    playerProfiles: profiles.items,
    defaultPlayerProfileId: profiles.defaultProfileId,
    dataDir,
    webdavEnabled: options.webdavEnabled === true,
    displayName: options.displayName ?? 'Emulation Server',
    virtual,
    limiter: new RateLimiter(options.loginLimit ?? 10, 60_000),
    uiDir: options.uiDir ?? null,
    localTrust: options.localTrust !== false,
  };
  context.playerManager = new PlayerManager(context, profiles.items);
  try {
    await context.playerManager.initialize();
  } catch (error) {
    catalog.close();
    await virtual.close();
    throw error;
  }
  let app: FastifyInstance;
  try {
    // Startup owns this catalog under the single-server ownership assumption:
    // pending scans belong to an abandoned run. Auxiliary catalog opens must
    // preserve active scans and never perform this recovery.
    catalog.recoverInterruptedRootScans();
    app = await buildApp(context, options.logger ?? false);
  } catch (error) {
    await virtual.close();
    catalog.close();
    throw error;
  }
  // preClose runs before Fastify waits for active requests. Abort native work
  // here so an active entry request cannot hold shutdown until its deadline.
  app.addHook('preClose', async () => {
    await virtual.close();
  });
  app.addHook('onClose', async () => {
    catalog.close();
  });
  return {
    app,
    catalog,
    close: async () => {
      await app.close();
    },
  };
}

export async function buildApp(context: ServerContext, logger = false): Promise<FastifyInstance> {
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
  app.decorateRequest('workflowPrincipal', null);
  // A generous socket ceiling also bounds invalid bearer attempts before authentication.
  // DAV's much smaller failed-login budget remains independent of successful reads.
  await app.register(rateLimit, {
    global: false,
    max: 6000,
    timeWindow: 60_000,
    keyGenerator: peerAddress,
    errorResponseBuilder: () => new DomainError('rate-limited', 429, 'Too many requests'),
  });
  app.addHook('onRequest', app.rateLimit());
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
      reply.header('access-control-expose-headers', 'etag, content-range');
      reply.header(
        'access-control-allow-headers',
        'authorization, content-type, accept, idempotency-key, if-none-match, if-match, if-range, range, content-range',
      );
      reply.header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
      if (request.method === 'OPTIONS') return reply.status(204).send();
    }
    request.actor = null;
    request.workflowPrincipal = null;
    const header = request.headers.authorization;
    if (header) {
      const match = /^Bearer\s+(\S+)$/.exec(header);
      if (!match?.[1]) throw new DomainError('unauthorized', 401, 'Bearer token is required');
      const actor = context.catalog.authenticate(hashToken(match[1]));
      if (!actor) {
        const principal = authenticateWorkflowPrincipal(context, hashToken(match[1]));
        if (
          principal &&
          request.routeOptions.url?.startsWith('/api/v1/workflow-workers/') &&
          request.routeOptions.url !== '/api/v1/workflow-workers/enroll'
        ) {
          request.workflowPrincipal = principal;
          return;
        }
        throw new DomainError('unauthorized', 401, 'Token is invalid or expired');
      }
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
  const folderWatcher = new FolderWatcher(context.catalog);
  app.addHook('onReady', async () => {
    folderWatcher.reconcile();
  });
  app.addHook('preClose', async () => {
    await stopLibraryJobs(context.catalog);
    await folderWatcher.close();
  });
  registerFolderWatchRoutes(app, context, folderWatcher);
  registerWebDav(app, context);
  registerRoutes(app, context);
  registerPlayerManagement(app, context);
  registerPlayerAssets(app, context);
  registerWebDavCredentials(app, context);
  return app;
}
