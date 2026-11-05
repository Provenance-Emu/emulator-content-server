import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { type Actor, DomainError } from '@ecs/domain';
import Fastify from 'fastify';
import type { ServerContext } from '../src/context.js';
import { PlayerManager, registerPlayerManagement } from '../src/player-manager.js';
import { upstreamFixture } from './player-cache-fixture.js';

test('owner catalog install retains bytes across removal and restart for offline reinstall', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ecs-player-cache-manager-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const generated = upstreamFixture();
  let fetched = 0;
  const network = t.mock.method(globalThis, 'fetch', async (url: string) => {
    fetched++;
    return new Response(url.endsWith('.wasm') ? generated.wasm : generated.loader);
  });
  async function start() {
    const context = {
      dataDir,
      playerProfiles: new Map(),
      defaultPlayerProfileId: null,
    } as unknown as ServerContext;
    const catalog = [structuredClone(generated.entry)];
    context.playerManager = new PlayerManager(context, new Map(), catalog);
    await context.playerManager.initialize();
    // Changes to caller-owned descriptors after construction must not change the pins.
    const catalogEntry = catalog[0];
    assert.ok(catalogEntry);
    catalogEntry.name = 'Caller mutation';
    const app = Fastify();
    app.decorateRequest('actor', null);
    app.addHook('onRequest', async (request) => {
      request.actor = request.headers.authorization
        ? ({
            kind: 'user',
            userId: 'generated',
            username: 'generated',
            isOwner: true,
            tokenKind: 'session',
            deviceId: null,
            scopes: ['admin', 'read', 'write'],
          } as Actor)
        : null;
    });
    app.setErrorHandler((error, _request, reply) =>
      reply.code(error instanceof DomainError ? error.status : 500).send(),
    );
    registerPlayerManagement(app, context);
    return { app, context };
  }
  const first = await start();
  t.after(() => first.app.close());
  const base = '/api/v1/player/management';
  const install = `${base}/install/${generated.entry.id}`;
  const headers = { authorization: 'Bearer generated-test-session' };
  assert.equal((await first.app.inject({ method: 'POST', url: install })).statusCode, 403);
  assert.equal(fetched, 0);
  assert.equal((await first.app.inject({ method: 'POST', url: install, headers })).statusCode, 200);
  const view = (await first.app.inject({ url: base, headers })).json();
  assert.equal(view.available[0].name, generated.entry.name);
  assert.equal('provenance' in view.available[0], false);
  assert.equal(fetched, 2);
  assert.equal(
    (await first.app.inject({ method: 'DELETE', url: `${base}/${generated.entry.id}`, headers }))
      .statusCode,
    200,
  );
  await first.app.close();
  network.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('offline');
  });
  const second = await start();
  t.after(() => second.app.close());
  assert.equal(
    (await second.app.inject({ method: 'POST', url: install, headers })).statusCode,
    200,
  );
  assert.deepEqual(second.context.playerProfiles.get(generated.entry.id)?.loader, generated.loader);
  assert.deepEqual(second.context.playerProfiles.get(generated.entry.id)?.wasm, generated.wasm);
  assert.equal((await readdir(join(dataDir, 'player-cache'))).length, 2);
});
