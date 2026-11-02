import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { DomainError } from '@ecs/domain';
import type { PlayerIsolationSession } from '@ecs/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerContext } from './context.js';
import { actorKey, jsonObject, requireActor, requiredString } from './http.js';
import { peerAddress } from './local-access.js';
import { readRegular } from './player-assets.js';

const PARENT_MARKER = '__ECS_PARENT_ORIGIN__';
const SESSION_ID = /^[a-f0-9]{48}$/;
const WINDOW_MS = 60_000;
const MAX_RATE_ACTORS = 128;
const BOOTSTRAP_BYTES = 1024 * 1024;
interface Entry {
  actor: string;
  server?: Server;
  timer?: ReturnType<typeof setTimeout>;
}
interface HostOptions {
  maxSessions?: number;
  maxOrigins?: number;
  maxPerActor?: number;
  ttlMs?: number;
  rateLimit?: number;
}
function loopback(address: string): boolean {
  if (address === '::1') return true;
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return isIP(ipv4) === 4 && ipv4.split('.')[0] === '127';
}
function localOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' &&
      !url.username &&
      !url.password &&
      url.origin === value &&
      (url.hostname === 'localhost' || loopback(url.hostname.replace(/^\[|\]$/g, '')))
      ? url
      : null;
  } catch {
    return null;
  }
}
/** Origin comes only from the browser's same-origin request; proxy headers never participate. */
function parentOrigin(request: FastifyRequest): string {
  const origin = request.headers.origin,
    authority = request.headers.host;
  if (
    request.protocol !== 'http' ||
    !loopback(peerAddress(request)) ||
    typeof origin !== 'string' ||
    typeof authority !== 'string' ||
    authority.length > 128
  )
    throw new DomainError('forbidden', 403, 'Isolated playback requires a local HTTP browser');
  const parent = localOrigin(origin);
  if (
    !parent ||
    authority.includes('/') ||
    authority.includes('\\') ||
    authority.includes('@') ||
    `http://${authority}` !== parent.origin
  )
    throw new DomainError('forbidden', 403, 'Isolated playback requires the local browser origin');
  return parent.origin;
}
function readActor(request: FastifyRequest): string {
  const actor = requireActor(request);
  if (!request.headers.authorization || (actor.kind === 'user' && actor.localTrust))
    throw new DomainError('unauthorized', 401, 'Bearer authentication is required');
  if (!(actor.kind === 'user' ? actor.scopes : actor.capabilities).includes('read'))
    throw new DomainError('forbidden', 403, 'Read permission is required');
  return actorKey(actor);
}
async function closeServer(server?: Server): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Each listener is a separate origin, with no access to the API, registry, or user files. */
export class PlayerIsolationHost {
  private readonly entries = new Map<string, Entry>();
  private readonly origins = new Set<Entry>();
  private readonly hits = new Map<string, number[]>();
  private readonly pending = new Set<Promise<PlayerIsolationSession>>();
  private closed = false;
  private readonly maxSessions: number;
  private readonly maxOrigins: number;
  private readonly maxPerActor: number;
  private readonly ttlMs: number;
  private readonly rateLimit: number;
  constructor(
    private readonly bootstrap: () => Promise<Buffer>,
    options: HostOptions = {},
  ) {
    this.maxSessions = options.maxSessions ?? 4;
    this.maxOrigins = options.maxOrigins ?? 64;
    this.maxPerActor = options.maxPerActor ?? 2;
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.rateLimit = options.rateLimit ?? 8;
  }
  create(actor: string, origin: string): Promise<PlayerIsolationSession> {
    const task = this.allocate(actor, origin);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  private async allocate(actor: string, origin: string): Promise<PlayerIsolationSession> {
    if (this.closed) throw new DomainError('not-found', 404, 'Isolated playback is unavailable');
    if (!localOrigin(origin))
      throw new DomainError('forbidden', 403, 'Local parent origin is required');
    const now = Date.now();
    for (const [key, values] of this.hits) {
      const recent = values.filter((seen) => seen > now - WINDOW_MS);
      if (recent.length) this.hits.set(key, recent);
      else this.hits.delete(key);
    }
    const recent = this.hits.get(actor) ?? [];
    if (
      recent.length >= this.rateLimit ||
      (!this.hits.has(actor) && this.hits.size >= MAX_RATE_ACTORS)
    )
      throw new DomainError('quota-exceeded', 429, 'Isolated playback creation rate exceeded');
    recent.push(now);
    this.hits.set(actor, recent);
    if (
      this.origins.size >= this.maxOrigins ||
      this.entries.size >= this.maxSessions ||
      [...this.entries.values()].filter((entry) => entry.actor === actor).length >= this.maxPerActor
    )
      throw new DomainError('quota-exceeded', 429, 'Isolated playback session limit reached');
    const id = randomBytes(24).toString('hex'),
      entry: Entry = { actor };
    this.entries.set(id, entry);
    this.origins.add(entry); // Reserve before any asynchronous I/O or listen.
    try {
      const bytes = await this.bootstrap();
      if (bytes.length > BOOTSTRAP_BYTES) throw new Error('Invalid bootstrap');
      const template = bytes.toString('utf8');
      if (template.split(PARENT_MARKER).length !== 2) throw new Error('Invalid bootstrap marker');
      const html = Buffer.from(template.replace(PARENT_MARKER, JSON.stringify(origin)));
      if (this.closed || !this.entries.has(id)) throw new Error('Session was closed');
      const route = `/${id}/dolphin-sandbox.html`;
      const policy = [
        "default-src 'none'",
        "script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'",
        "style-src 'unsafe-inline'",
        'connect-src blob:',
        'img-src blob: data:',
        'media-src blob:',
        'worker-src blob:',
        "base-uri 'none'",
        "form-action 'none'",
        `frame-ancestors ${origin}`,
        'sandbox allow-scripts allow-same-origin',
      ].join('; ');
      const server = createServer(
        {
          maxHeaderSize: 8192,
          requestTimeout: 5000,
          headersTimeout: 5000,
          connectionsCheckingInterval: 1000,
        },
        (request, response) => {
          const address = server.address();
          const headerNames = request.rawHeaders
            .filter((_value, index) => index % 2 === 0)
            .map((name) => name.toLowerCase());
          response.setHeader('connection', 'close');
          if (
            !address ||
            typeof address === 'string' ||
            headerNames.length > 32 ||
            headerNames.filter((name) => name === 'host').length !== 1 ||
            headerNames.includes('authorization') ||
            headerNames.includes('cookie') ||
            this.closed ||
            this.entries.get(id) !== entry ||
            request.method !== 'GET' ||
            request.url !== route ||
            request.headers.host !== `127.0.0.1:${address.port}` ||
            !loopback(request.socket.remoteAddress ?? '') ||
            request.headers.authorization !== undefined ||
            request.headers.cookie !== undefined
          ) {
            response.writeHead(404, {
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            });
            response.end();
            return;
          }
          response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': html.length,
            'content-security-policy': policy,
            'cache-control': 'no-store',
            'cross-origin-embedder-policy': 'require-corp',
            'cross-origin-resource-policy': 'cross-origin',
            'origin-agent-cluster': '?1',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
            'permissions-policy':
              'autoplay=(self), gamepad=(self), cross-origin-isolated=(self), camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), display-capture=(), screen-wake-lock=(), clipboard-read=(), clipboard-write=(), fullscreen=(), accelerometer=(), gyroscope=(), magnetometer=(), publickey-credentials-get=()',
          });
          response.end(html);
        },
      );
      entry.server = server;
      server.maxConnections = 8;
      server.maxHeadersCount = 32;
      server.maxRequestsPerSocket = 8;
      server.setTimeout(5000, (socket) => socket.destroy());
      server.on('error', () => {
        void this.destroy(id);
      });
      server.on('clientError', (_error, socket) => socket.destroy());
      server.on('upgrade', (_request, socket) => socket.destroy());
      server.on('connect', (_request, socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      if (this.closed || !this.entries.has(id)) throw new Error('Session was closed');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing listener address');
      entry.timer = setTimeout(() => {
        void this.destroy(id);
      }, this.ttlMs);
      entry.timer.unref();
      return {
        id,
        url: `http://127.0.0.1:${address.port}${route}`,
        expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
      };
    } catch {
      await this.retire(id, entry, true);
      throw new DomainError('not-found', 404, 'Isolated playback bootstrap is unavailable');
    }
  }
  async remove(id: string, actor: string): Promise<void> {
    if (!SESSION_ID.test(id) || this.entries.get(id)?.actor !== actor)
      throw new DomainError('not-found', 404, 'Isolated playback session is unavailable');
    await this.destroy(id);
  }
  private async destroy(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) await this.retire(id, entry, false);
  }
  private async retire(id: string, entry: Entry, release: boolean): Promise<void> {
    this.entries.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (release) {
      this.origins.delete(entry);
      await closeServer(entry.server);
    } else if (entry.server) {
      // A live iframe can outlast its allocation. Reserve its origin as a tiny
      // 404-only tombstone so another core never inherits that port this run.
      entry.server.maxConnections = 1;
      entry.server.closeAllConnections();
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    for (const entry of this.origins) if (entry.timer) clearTimeout(entry.timer);
    this.entries.clear();
    await Promise.all([...this.origins].map((entry) => closeServer(entry.server)));
    this.origins.clear();
    this.hits.clear();
  }
}

export function registerPlayerIsolation(app: FastifyInstance, context: ServerContext): void {
  let bootstrap: Promise<Buffer> | undefined;
  const host = new PlayerIsolationHost(async () => {
    if (
      !context.uiDir ||
      !(await lstat(context.uiDir)).isDirectory() ||
      !(await lstat(join(context.uiDir, 'play'))).isDirectory()
    )
      throw new Error('Missing UI bootstrap');
    bootstrap ??= readRegular(context.uiDir, 'play/dolphin-sandbox.html', BOOTSTRAP_BYTES);
    return bootstrap;
  });
  app.addHook('preClose', () => host.close());
  app.post('/api/v1/player/isolated-sessions', { bodyLimit: 1024 }, async (request, reply) => {
    const actor = readActor(request),
      origin = parentOrigin(request),
      body = jsonObject(request.body);
    if (Object.keys(body).some((key) => key !== 'profileId'))
      throw new DomainError('invalid-body', 400, 'Unexpected isolation session property');
    const id = requiredString(body, 'profileId');
    if (id.length > 120)
      throw new DomainError('invalid-body', 400, 'Invalid player profile identifier');
    const profile = context.playerProfiles.get(id)?.descriptor;
    if (profile?.runtime !== 'dolphin-wasm-esm' || !profile.threaded)
      throw new DomainError('not-found', 404, 'Isolated browser player is not enabled');
    const session = await host.create(actor, origin);
    return reply.code(201).header('cache-control', 'private, no-store').send(session);
  });
  app.delete<{ Params: { id: string } }>(
    '/api/v1/player/isolated-sessions/:id',
    async (request, reply) => {
      const actor = readActor(request);
      parentOrigin(request);
      await host.remove(request.params.id, actor);
      return reply.code(204).header('cache-control', 'private, no-store').send();
    },
  );
}
