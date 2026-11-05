import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { type Actor, DomainError } from '@ecs/domain';
import Fastify from 'fastify';
import type { ServerContext } from '../src/context.js';
import { PlayerIsolationHost, registerPlayerIsolation } from '../src/player-isolation.js';

const template = Buffer.from(
  '<!doctype html><script>const parentOrigin=__ECS_PARENT_ORIGIN__;</script>',
);
const origin = 'http://127.0.0.1:8473';
function get(url: string, headers: Record<string, string> = {}, path?: string, method = 'GET') {
  return new Promise<{
    status: number;
    headers: import('node:http').IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const parsed = new URL(url);
    const request = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: path ?? parsed.pathname,
        headers,
        method,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

test('companion serves only fixed bootstrap at exact loopback Host and random route', async (t) => {
  const host = new PlayerIsolationHost(async () => template);
  t.after(() => host.close());
  const session = await host.create('user:owner', origin);
  assert.match(session.id, /^[a-f0-9]{48}$/);
  assert.ok(Date.parse(session.expiresAt) > Date.now());
  const url = new URL(session.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.protocol, 'http:');
  const response = await get(session.url);
  assert.equal(response.status, 200);
  assert.ok(response.body.includes(JSON.stringify(origin)));
  assert.ok(!response.body.includes('__ECS_PARENT_ORIGIN__'));
  const csp = String(response.headers['content-security-policy']);
  for (const part of [
    "default-src 'none'",
    'connect-src blob:',
    'worker-src blob:',
    `frame-ancestors ${origin}`,
    'sandbox allow-scripts allow-same-origin',
  ])
    assert.ok(csp.includes(part), part);
  assert.equal(response.headers['cross-origin-embedder-policy'], 'require-corp');
  assert.equal(response.headers['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(response.headers['origin-agent-cluster'], '?1');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  for (const path of [
    '/',
    '/api/v1/capabilities',
    '/core.wasm',
    '/loader.js',
    '/etc/passwd',
    `${url.pathname}?extra=1`,
    '/%2e%2e/bootstrap',
  ])
    assert.equal((await get(session.url, {}, path)).status, 404);
  for (const headers of [
    { host: `localhost:${url.port}` },
    { host: 'external.invalid' },
    { authorization: 'Bearer generated-invalid' },
    { cookie: 'test=generated' },
  ] as Record<string, string>[])
    assert.equal((await get(session.url, headers)).status, 404);
  assert.equal((await get(session.url, {}, undefined, 'POST')).status, 404);
  await assert.rejects(
    host.remove(session.id, 'user:another'),
    (error: unknown) => error instanceof DomainError && error.status === 404,
  );
  await host.remove(session.id, 'user:owner');
  assert.equal((await get(session.url)).status, 404);
});

test('allocation bounds include actor quotas, rate limits, expiry and pending close', async (t) => {
  const host = new PlayerIsolationHost(async () => template, {
    maxSessions: 2,
    maxPerActor: 1,
    ttlMs: 100,
    rateLimit: 2,
  });
  t.after(() => host.close());
  const one = await host.create('one', origin);
  const two = await host.create('two', origin);
  await assert.rejects(
    host.create('one', origin),
    (e: unknown) => e instanceof DomainError && e.status === 429,
  );
  await assert.rejects(
    host.create('three', origin),
    (e: unknown) => e instanceof DomainError && e.status === 429,
  );
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal((await get(one.url)).status, 404);
  assert.equal((await get(two.url)).status, 404);
  const next = await host.create('two', origin);
  await host.remove(next.id, 'two');
  await assert.rejects(
    host.create('two', origin),
    (e: unknown) => e instanceof DomainError && e.status === 429,
  );
  let release!: (value: Buffer) => void;
  const pendingHost = new PlayerIsolationHost(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = pendingHost.create('owner', origin);
  const rejected = assert.rejects(pending);
  const closed = pendingHost.close();
  release(template);
  await closed;
  await rejected;
});

async function routesFixture(t: import('node:test').TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'play'));
  await writeFile(join(directory, 'play/dolphin-sandbox.html'), template);
  const profiles = new Map([
    ['dolphin', { descriptor: { runtime: 'dolphin-wasm-esm', threaded: true } }],
    ['ordinary', { descriptor: { runtime: 'retroarch-emscripten-esm', threaded: false } }],
    ['mismatch', { descriptor: { runtime: 'dolphin-wasm-esm', threaded: false } }],
  ]);
  const context = { uiDir: directory, playerProfiles: profiles } as unknown as ServerContext;
  const app = Fastify();
  app.decorateRequest('actor', null);
  app.addHook('onRequest', async (request) => {
    const user = request.headers.authorization?.slice('Bearer '.length);
    request.actor = user
      ? ({
          kind: 'user',
          userId: user,
          username: user,
          isOwner: false,
          tokenKind: 'session',
          deviceId: null,
          scopes: user === 'no-read' ? [] : ['read'],
        } as Actor)
      : null;
  });
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof DomainError ? error.status : 500)
      .send({ error: error instanceof DomainError ? error.message : 'Internal error' }),
  );
  registerPlayerIsolation(app, context);
  t.after(() => app.close());
  const headers = { host: '127.0.0.1:8473', origin, authorization: 'Bearer owner' };
  return { app, context, headers, directory };
}

test('session API requires explicit read actor and actual loopback peer/Host/parent origin', async (t) => {
  const f = await routesFixture(t);
  const create = (
    headers: Record<string, string> = f.headers,
    remoteAddress = '127.0.0.1',
    payload: unknown = { profileId: 'dolphin' },
  ) =>
    f.app.inject({
      method: 'POST',
      url: '/api/v1/player/isolated-sessions',
      headers: { 'content-type': 'application/json', ...headers },
      remoteAddress,
      payload: JSON.stringify(payload),
    });
  assert.equal((await create({ host: f.headers.host, origin })).statusCode, 401);
  assert.equal((await create({ ...f.headers, authorization: 'Bearer no-read' })).statusCode, 403);
  for (const [headers, peer] of [
    [f.headers, '203.0.113.8'],
    [
      { ...f.headers, 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': '127.0.0.1:8473' },
      '203.0.113.8',
    ],
    [{ ...f.headers, host: 'external.invalid', origin: 'http://external.invalid' }, '127.0.0.1'],
    [{ ...f.headers, origin: 'https://127.0.0.1:8473' }, '127.0.0.1'],
    [{ ...f.headers, origin: 'http://127.0.0.1:9999' }, '127.0.0.1'],
    [{ ...f.headers, origin: 'null' }, '127.0.0.1'],
    [{ ...f.headers, origin: 'http://127.0.0.1:8473/path' }, '127.0.0.1'],
  ] as const)
    assert.equal((await create({ ...headers }, peer)).statusCode, 403);
  for (const profileId of ['ordinary', 'mismatch', 'missing'])
    assert.equal((await create(f.headers, '127.0.0.1', { profileId })).statusCode, 404);
  for (const payload of [{ profileId: 'dolphin', url: 'http://external.invalid' }, {}, null])
    assert.equal((await create(f.headers, '127.0.0.1', payload)).statusCode, 400);
  assert.equal(
    (await create({ host: f.headers.host, authorization: f.headers.authorization })).statusCode,
    403,
  );
  const accepted = await create();
  assert.equal(accepted.statusCode, 201);
  assert.equal(accepted.headers['cache-control'], 'private, no-store');
  const session = accepted.json();
  assert.equal((await get(session.url)).status, 200);
  const path = `/api/v1/player/isolated-sessions/${session.id}`;
  assert.equal(
    (
      await f.app.inject({
        method: 'DELETE',
        url: path,
        headers: { ...f.headers, authorization: 'Bearer other' },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await f.app.inject({ method: 'DELETE', url: path, headers: f.headers })).statusCode,
    204,
  );
  const pending = (await create()).json();
  await f.app.close();
  await assert.rejects(get(pending.url));
});

test('retired origins stay bound and lifetime listener cap cannot be evaded by closing', async (t) => {
  const host = new PlayerIsolationHost(async () => template, { maxOrigins: 2 });
  t.after(() => host.close());
  const first = await host.create('owner', origin);
  await host.remove(first.id, 'owner');
  const second = await host.create('owner', origin);
  await host.remove(second.id, 'owner');
  assert.notEqual(new URL(first.url).port, new URL(second.url).port);
  assert.equal((await get(first.url)).status, 404);
  assert.equal((await get(second.url)).status, 404);
  await assert.rejects(
    host.create('owner', origin),
    (e: unknown) => e instanceof DomainError && e.status === 429,
  );
  await host.close();
  await assert.rejects(get(first.url));
  await assert.rejects(get(second.url));
});
