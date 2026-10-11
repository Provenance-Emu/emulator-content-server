import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

test('content roots are owner-only and reject folders the server must not follow', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-root-api-')));
  const dataDir = join(base, 'content-data');
  const collection = join(base, 'collection');
  const nested = join(collection, 'nes');
  const other = join(base, 'other');
  await mkdir(nested, { recursive: true });
  await mkdir(other, { recursive: true });

  const server = await openServer({ dataDir });
  try {
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const owner = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
    });
    assert.equal(owner.statusCode, 201);
    const auth = { authorization: `Bearer ${(owner.json() as { token: string }).token}` };

    const empty = await server.app.inject({ method: 'GET', url: '/api/v1/roots', headers: auth });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json(), { items: [], nextCursor: null });

    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/roots',
      headers: auth,
      payload: { path: collection, label: 'Collection' },
    });
    assert.equal(created.statusCode, 201);
    const root = created.json() as { id: string; path: string; label: string; libraryId: null };
    assert.equal(root.path, collection);
    assert.equal(root.label, 'Collection');
    assert.equal(root.libraryId, null);

    const listed = await server.app.inject({ method: 'GET', url: '/api/v1/roots', headers: auth });
    assert.deepEqual(
      (listed.json() as { items: Array<{ path: string }> }).items.map((entry) => entry.path),
      [collection],
    );

    const refusals: Array<[string, Record<string, unknown>, number]> = [
      ['the same folder twice', { path: collection, label: 'Again' }, 409],
      ['a folder inside a saved root', { path: nested, label: 'Nested' }, 409],
      ['a folder inside the data directory', { path: join(dataDir, 'blobs'), label: 'Data' }, 400],
      ['a folder that does not exist', { path: join(base, 'absent'), label: 'Absent' }, 400],
      ['a relative path', { path: 'collection', label: 'Relative' }, 400],
      ['an unknown library', { path: other, label: 'Other', libraryId: 'missing' }, 404],
    ];
    for (const [reason, payload, expected] of refusals) {
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/v1/roots',
        headers: auth,
        payload,
      });
      assert.equal(response.statusCode, expected, reason);
    }

    const reader = await server.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: auth,
      payload: { username: 'reader', password: 'another-horse' },
    });
    assert.equal(reader.statusCode, 201);
    const login = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'reader', password: 'another-horse' },
    });
    assert.equal(login.statusCode, 200);
    const readerAuth = {
      authorization: `Bearer ${(login.json() as { token: string }).token}`,
    };

    for (const request of [
      { method: 'GET' as const, url: '/api/v1/roots' },
      { method: 'DELETE' as const, url: `/api/v1/roots/${root.id}` },
    ]) {
      const response = await server.app.inject({ ...request, headers: readerAuth });
      assert.equal(response.statusCode, 403, `${request.method} ${request.url} for a reader`);
    }
    const readerCreate = await server.app.inject({
      method: 'POST',
      url: '/api/v1/roots',
      headers: readerAuth,
      payload: { path: other, label: 'Other' },
    });
    assert.equal(readerCreate.statusCode, 403);

    const removed = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/roots/${root.id}`,
      headers: auth,
    });
    assert.equal(removed.statusCode, 204);
    const gone = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/roots/${root.id}`,
      headers: auth,
    });
    assert.equal(gone.statusCode, 404);

    const audit = await server.app.inject({ method: 'GET', url: '/api/v1/audit', headers: auth });
    const actions = (audit.json() as { events: Array<{ action: string }> }).events.map(
      (event) => event.action,
    );
    assert.ok(actions.includes('create-content-root'));
    assert.ok(actions.includes('delete-content-root'));
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});
