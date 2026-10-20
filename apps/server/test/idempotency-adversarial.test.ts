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

test('cached mutations still require current library permissions and token scopes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-idempotency-acl-'));
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
  const bootstrapped = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
  });
  assert.equal(bootstrapped.statusCode, 201);
  const owner = { authorization: `Bearer ${bootstrapped.json().token}` };
  const libraries = await app.inject({ url: '/api/v1/libraries', headers: owner });
  assert.equal(libraries.statusCode, 200);
  const libraryId = libraries.json().items[0].id as string;
  const user = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: owner,
    payload: { username: 'editor', password: 'correct-horse' },
  });
  assert.equal(user.statusCode, 201);
  const membership = `/api/v1/libraries/${libraryId}/members/${user.json().id}`;
  const setRole = (role: string) =>
    app.inject({
      method: 'PUT',
      url: membership,
      headers: owner,
      payload: { role },
    });
  assert.equal((await setRole('owner')).statusCode, 204);
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'editor', password: 'correct-horse' },
  });
  assert.equal(login.statusCode, 200);
  const editor = { authorization: `Bearer ${login.json().token}` };
  const device = await app.inject({
    method: 'POST',
    url: '/api/v1/device-tokens',
    headers: editor,
    payload: { name: 'read only', scopes: ['read'] },
  });
  assert.equal(device.statusCode, 201);
  const readOnly = { authorization: `Bearer ${device.json().token}` };
  const actions: Array<{
    url: string;
    payload: Record<string, unknown>;
    key: string;
    original: unknown;
  }> = [];
  const create = async (url: string, payload: Record<string, unknown>, key: string) => {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { ...editor, 'idempotency-key': key },
      payload,
    });
    assert.equal(response.statusCode, 201);
    actions.push({ url, payload, key, original: response.json() });
    return response;
  };
  const item = await create(
    '/api/v1/items',
    {
      libraryId,
      systemIdentifier: 'com.provenance.nes',
      title: 'Permission replay',
    },
    'permission-item-1',
  );
  const upload = await create('/api/v1/uploads', { libraryId }, 'permission-upload-1');
  const bytes = await app.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${upload.json().id}/content`,
    headers: { ...editor, 'content-type': 'application/octet-stream' },
    payload: Buffer.from('generated'),
  });
  assert.equal(bytes.statusCode, 204);
  await create(
    `/api/v1/uploads/${upload.json().id}/complete`,
    {
      itemId: item.json().id,
      kind: 'rom',
      displayName: 'generated.bin',
      relativePath: 'generated.bin',
      baseRevision: item.json().revision,
    },
    'permission-complete-1',
  );
  await create(
    '/api/v1/guest-grants',
    {
      libraryId,
      capabilities: ['read'],
      expiresInSeconds: 3600,
    },
    'permission-grant-1',
  );

  for (const phase of ['authorized', 'reduced scope', 'demoted', 'removed', 'restored'] as const) {
    if (phase === 'demoted') assert.equal((await setRole('reader')).statusCode, 204);
    if (phase === 'removed') {
      const removed = await app.inject({ method: 'DELETE', url: membership, headers: owner });
      assert.equal(removed.statusCode, 204);
    }
    if (phase === 'restored') assert.equal((await setRole('owner')).statusCode, 204);
    for (const action of actions) {
      await t.test(`${phase}: ${action.url}`, async () => {
        const response = await app.inject({
          method: 'POST',
          url: action.url,
          payload: action.payload,
          headers: {
            ...(phase === 'reduced scope' ? readOnly : editor),
            'idempotency-key': action.key,
          },
        });
        if (phase === 'removed') {
          assert.equal(response.statusCode, 404);
          assert.equal(response.json().type, 'urn:ecs:problem:not-found');
        } else if (phase === 'demoted' || phase === 'reduced scope') {
          assert.equal(response.statusCode, 403);
          assert.equal(response.json().type, 'urn:ecs:problem:forbidden');
        } else {
          assert.equal(response.statusCode, 201);
          assert.deepEqual(response.json(), action.original);
        }
      });
    }
  }
});
