import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { libraryFixture } from './library-fixture.js';

test('watching policy is owner-only, defaults off and accepts only explicit boolean consent', async () => {
  const f = await libraryFixture();
  try {
    const path = join(f.base, 'generated-games');
    await mkdir(path);
    const root = f.catalog.createContentRoot({
      path,
      label: 'Generated',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    const url = `/api/v1/roots/${root.id}/watching-policy`;
    for (const method of ['GET', 'PUT'] as const) {
      const response = await f.app.inject({
        method,
        url,
        remoteAddress: '8.8.8.8',
        ...(method === 'PUT' ? { payload: { enabled: true } } : {}),
      });
      assert.equal(response.statusCode, 401, response.body);
    }
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: f.auth,
      payload: { username: 'reader', password: 'correct-horse' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'reader', password: 'correct-horse' },
    });
    const reader = { authorization: `Bearer ${login.json().token}` };
    for (const method of ['GET', 'PUT'] as const) {
      const response = await f.app.inject({
        method,
        url,
        headers: reader,
        ...(method === 'PUT' ? { payload: { enabled: true } } : {}),
      });
      assert.equal(response.statusCode, 403, response.body);
    }
    const get = await f.app.inject({ method: 'GET', url, headers: f.auth });
    assert.equal(get.statusCode, 200, get.body);
    assert.deepEqual(get.json(), { rootId: root.id, enabled: false, state: 'off' });
    assert.equal(get.headers['cache-control'], 'private, no-store');
    for (const payload of [
      {},
      { enabled: 'true' },
      { enabled: true, path: '/tmp/arbitrary' },
      [],
    ]) {
      const response = await f.app.inject({ method: 'PUT', url, headers: f.auth, payload });
      assert.equal(response.statusCode, 400, response.body);
    }
    const enabled = await f.app.inject({
      method: 'PUT',
      url,
      headers: f.auth,
      payload: { enabled: true },
    });
    assert.equal(enabled.statusCode, 200, enabled.body);
    assert.equal(enabled.json().enabled, true);
    assert.ok(!enabled.body.includes(path));
    assert.equal(f.catalog.listFolderWatchPolicies().length, 1);
    const disabled = await f.app.inject({
      method: 'PUT',
      url,
      headers: f.auth,
      payload: { enabled: false },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.deepEqual(disabled.json(), { rootId: root.id, enabled: false, state: 'off' });
    assert.deepEqual(f.catalog.listFolderWatchPolicies(), []);
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/v1/roots/missing/watching-policy',
          headers: f.auth,
          payload: { enabled: true },
        })
      ).statusCode,
      404,
    );
  } finally {
    await f.dispose();
  }
});
