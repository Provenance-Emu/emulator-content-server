import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

for (const resource of ['items', 'uploads'] as const) {
  test(`a reused key with a different body cannot create extra ${resource} or replace its replay`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'ecs-idempotency-'));
    let server: Awaited<ReturnType<typeof openServer>> | undefined;
    t.after(async () => {
      try {
        await server?.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    server = await openServer({ dataDir: dir, localTrust: false });
    const { app } = server;
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const owner = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
    });
    assert.equal(owner.statusCode, 201);
    const auth = { authorization: `Bearer ${owner.json().token}` };
    const libraries = await app.inject({ url: '/api/v1/libraries', headers: auth });
    assert.equal(libraries.statusCode, 200);
    const libraryId = libraries.json().items[0].id as string;
    const otherLibrary = await app.inject({
      method: 'POST',
      url: '/api/v1/libraries',
      headers: auth,
      payload: { name: 'Other library' },
    });
    assert.equal(otherLibrary.statusCode, 201);
    const original =
      resource === 'items'
        ? { libraryId, systemIdentifier: 'com.provenance.nes', title: 'Original' }
        : { libraryId };
    const changed =
      resource === 'items'
        ? { ...original, title: 'Changed' }
        : { libraryId: otherLibrary.json().id as string };
    const send = (payload: Record<string, unknown>, key = 'adversarial-request-1') =>
      app.inject({
        method: 'POST',
        url: `/api/v1/${resource}`,
        headers: { ...auth, 'idempotency-key': key },
        payload,
      });
    const first = await send(original);
    assert.equal(first.statusCode, 201, first.body);
    for (let attempt = 0; attempt < 2; attempt++) {
      const conflict = await send(changed);
      assert.equal(conflict.statusCode, 409, conflict.body);
      assert.equal(conflict.headers['content-type'], 'application/problem+json; charset=utf-8');
      assert.equal(conflict.json().type, 'urn:ecs:problem:idempotency-conflict');
      const replay = await send(original);
      assert.equal(replay.statusCode, 201);
      assert.deepEqual(replay.json(), first.json());
    }
    if (resource === 'items') {
      const list = await app.inject({ url: `/api/v1/items?libraryId=${libraryId}`, headers: auth });
      assert.equal(list.statusCode, 200);
      assert.deepEqual(
        list
          .json()
          .items.map((item: { id: string; title: string }) => ({ id: item.id, title: item.title })),
        [{ id: first.json().id, title: 'Original' }],
      );
    } else {
      assert.deepEqual(await readdir(join(dir, 'staging')), [first.json().id]);
      const state = await app.inject({ url: `/api/v1/uploads/${first.json().id}`, headers: auth });
      assert.equal(state.statusCode, 200);
      assert.equal(state.json().state, 'open');
      assert.equal(state.json().received, 0);
    }
    const independent = await send(changed, 'adversarial-request-2');
    assert.equal(independent.statusCode, 201, independent.body);
    assert.notEqual(independent.json().id, first.json().id);
  });
}
