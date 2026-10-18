import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-location-api-')));
  const dataDir = join(base, 'data');
  const extra = join(base, 'extra');
  await mkdir(extra);
  const server = await openServer({ dataDir });
  const bootstrap = issueToken();
  server.catalog.saveBootstrapHash(bootstrap.hash);
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
  });
  assert.equal(response.statusCode, 201);
  const auth = { authorization: `Bearer ${(response.json() as { token: string }).token}` };
  const ownerId = (response.json() as { userId: string }).userId;
  return {
    base,
    dataDir,
    extra,
    server,
    auth,
    ownerId,
    async close() {
      await server.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('owner can register locations, select new-byte storage, see offline status, and remove unused ones', async () => {
  const f = await fixture();
  const request = f.server.app.inject.bind(f.server.app);
  try {
    const empty = await request({
      method: 'GET',
      url: '/api/v1/storage-locations',
      headers: f.auth,
    });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json(), { items: [], writeLocationId: null });
    const created = await request({
      method: 'POST',
      url: '/api/v1/storage-locations',
      headers: f.auth,
      payload: { path: f.extra, label: 'External' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const location = created.json() as { id: string; path: string; label: string; online: boolean };
    assert.equal(location.path, f.extra);
    assert.equal(location.online, true);
    await stat(join(f.extra, 'blobs', 'sha256'));
    const chosen = await request({
      method: 'PUT',
      url: '/api/v1/storage-locations/write-target',
      headers: f.auth,
      payload: { id: location.id },
    });
    assert.equal(chosen.statusCode, 200, chosen.body);
    assert.deepEqual(chosen.json(), { id: location.id });
    assert.equal(f.server.catalog.writeLocation()?.id, location.id);
    const held = await request({
      method: 'DELETE',
      url: `/api/v1/storage-locations/${location.id}`,
      headers: f.auth,
    });
    assert.equal(held.statusCode, 409);
    await rename(f.extra, join(f.base, 'unplugged'));
    const offline = await request({
      method: 'GET',
      url: '/api/v1/storage-locations',
      headers: f.auth,
    });
    const list = offline.json() as { items: { online: boolean }[]; writeLocationId: string };
    assert.equal(list.items[0]?.online, false);
    assert.equal(list.writeLocationId, location.id);
    const primary = await request({
      method: 'PUT',
      url: '/api/v1/storage-locations/write-target',
      headers: f.auth,
      payload: { id: null },
    });
    assert.equal(primary.statusCode, 200);
    assert.deepEqual(primary.json(), { id: null });
    for (const [payload, expected] of [
      [{}, 400],
      [{ id: 7 }, 400],
      [{ id: 'unknown' }, 404],
    ] as const) {
      const response = await request({
        method: 'PUT',
        url: '/api/v1/storage-locations/write-target',
        headers: f.auth,
        payload,
      });
      assert.equal(response.statusCode, expected);
    }
    const removed = await request({
      method: 'DELETE',
      url: `/api/v1/storage-locations/${location.id}`,
      headers: f.auth,
    });
    assert.equal(removed.statusCode, 204);
    assert.equal(
      (
        await request({
          method: 'DELETE',
          url: `/api/v1/storage-locations/${location.id}`,
          headers: f.auth,
        })
      ).statusCode,
      404,
    );
    const audit = f.server.catalog.listAudit(100).map((event) => event.action);
    assert.ok(audit.includes('create-storage-location'));
    assert.ok(audit.includes('set-write-location'));
    assert.ok(audit.includes('delete-storage-location'));
  } finally {
    await f.close();
  }
});

test('storage management refuses readers, guests, and remote anonymous callers before exposing paths', async () => {
  const f = await fixture();
  try {
    const user = await f.server.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: f.auth,
      payload: { username: 'reader', password: 'another-horse' },
    });
    assert.equal(user.statusCode, 201);
    const login = await f.server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'reader', password: 'another-horse' },
    });
    const libraries = f.server.catalog.listLibraries(f.ownerId, true);
    const guest = await f.server.app.inject({
      method: 'POST',
      url: '/api/v1/guest-grants',
      headers: f.auth,
      payload: { libraryId: libraries[0]?.id, capabilities: ['read'], expiresInSeconds: 600 },
    });
    assert.equal(guest.statusCode, 201);
    for (const token of [
      (login.json() as { token: string }).token,
      (guest.json() as { token: string }).token,
      null,
    ]) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
        const url =
          method === 'PUT'
            ? '/api/v1/storage-locations/write-target'
            : method === 'DELETE'
              ? '/api/v1/storage-locations/unknown'
              : '/api/v1/storage-locations';
        const response = await f.server.app.inject({
          method,
          url,
          remoteAddress: '203.0.113.10',
          headers: token ? { authorization: `Bearer ${token}` } : {},
          ...(method === 'POST' ? { payload: { path: f.extra, label: 'External' } } : {}),
          ...(method === 'PUT' ? { payload: { id: null } } : {}),
        });
        assert.equal(response.statusCode, token ? 403 : 401, `${method} ${url}`);
        assert.equal(response.body.includes(f.base), false);
      }
    }
    assert.equal(f.server.catalog.listStorageLocations().length, 0);
    await assert.rejects(stat(join(f.extra, 'blobs')));
  } finally {
    await f.close();
  }
});

test('registration reuses CLI path validation and referenced locations cannot be forgotten', async () => {
  const f = await fixture();
  try {
    const roots = join(f.base, 'roots');
    await mkdir(roots);
    f.server.catalog.createContentRoot({
      path: roots,
      label: 'Games',
      libraryId: null,
      actorId: 'test',
    });
    for (const [path, label, expected] of [
      [f.dataDir, 'Data', 400],
      ['relative', 'Relative', 400],
      [roots, 'Root', 409],
      [join(f.base, 'missing'), 'Missing', 400],
      [f.extra, '', 400],
      [f.extra, 'a/b', 400],
    ] as const) {
      const response = await f.server.app.inject({
        method: 'POST',
        url: '/api/v1/storage-locations',
        headers: f.auth,
        payload: { path, label },
      });
      assert.equal(response.statusCode, expected, response.body);
    }
    const created = await f.server.app.inject({
      method: 'POST',
      url: '/api/v1/storage-locations',
      headers: f.auth,
      payload: { path: f.extra, label: 'External' },
    });
    assert.equal(created.statusCode, 201);
    const id = (created.json() as { id: string }).id;
    const duplicate = await f.server.app.inject({
      method: 'POST',
      url: '/api/v1/storage-locations',
      headers: f.auth,
      payload: { path: f.extra, label: 'Again' },
    });
    assert.equal(duplicate.statusCode, 409);
    const catalog = f.server.catalog;
    const libraryId = catalog.listLibraries(f.ownerId, true)[0]?.id;
    assert.ok(libraryId);
    const item = catalog.createItem({
      libraryId,
      systemIdentifier: 'com.provenance.nes',
      title: 'Generated',
      md5: null,
      crc: null,
      actorId: f.ownerId,
    });
    const upload = catalog.createUpload({ userId: f.ownerId, guestGrantId: null, libraryId });
    catalog.completeUpload({
      uploadId: upload.id,
      itemId: item.id,
      kind: 'rom',
      displayName: 'Generated',
      relativePath: 'generated',
      baseRevision: item.revision,
      sha256: 'a'.repeat(64),
      md5: 'b'.repeat(32),
      crc: 'abcd1234',
      size: 4,
      locationId: id,
      shareable: true,
      actorId: f.ownerId,
    });
    const held = await f.server.app.inject({
      method: 'DELETE',
      url: `/api/v1/storage-locations/${id}`,
      headers: f.auth,
    });
    assert.equal(held.statusCode, 409);
  } finally {
    await f.close();
  }
});

test('the TypeScript client manages storage over the real HTTP routes', async () => {
  const { ContentClient } = await import('@ecs/client');
  const f = await fixture();
  try {
    const address = await f.server.app.listen({ host: '127.0.0.1', port: 0 });
    const client = new ContentClient(address, f.auth.authorization.slice(7));
    assert.equal(typeof client.storageLocations, 'function');
    assert.deepEqual(await client.storageLocations(), { items: [], writeLocationId: null });
    const location = await client.addStorageLocation({ path: f.extra, label: 'USB' });
    await client.setStorageWriteTarget(location.id);
    assert.equal((await client.storageLocations()).writeLocationId, location.id);
    await client.setStorageWriteTarget(null);
    await client.removeStorageLocation(location.id);
    assert.deepEqual(await client.storageLocations(), { items: [], writeLocationId: null });
  } finally {
    await f.close();
  }
});

test('a content root cannot be added over an existing storage location', async () => {
  const f = await fixture();
  try {
    const location = await f.server.app.inject({
      method: 'POST',
      url: '/api/v1/storage-locations',
      headers: f.auth,
      payload: { path: f.extra, label: 'External' },
    });
    assert.equal(location.statusCode, 201);
    const root = await f.server.app.inject({
      method: 'POST',
      url: '/api/v1/roots',
      headers: f.auth,
      payload: { path: f.extra, label: 'Scanned storage' },
    });
    assert.equal(root.statusCode, 409);
    assert.equal(f.server.catalog.listContentRoots().length, 0);
  } finally {
    await f.close();
  }
});

test('concurrent parent/child location and root registrations cannot bypass overlap checks', async () => {
  const f = await fixture();
  try {
    for (const [a, b] of [
      ['storage-locations', 'storage-locations'],
      ['storage-locations', 'roots'],
      ['roots', 'storage-locations'],
    ] as const) {
      const parent = join(f.base, `${a}-${b}`);
      const child = join(parent, 'nested');
      await mkdir(child, { recursive: true });
      const replies = await Promise.all(
        [a, b].map((route, index) =>
          f.server.app.inject({
            method: 'POST',
            url: `/api/v1/${route}`,
            headers: f.auth,
            payload: { path: index === 0 ? parent : child, label: `${a}-${b}-${index}` },
          }),
        ),
      );
      assert.deepEqual(replies.map((reply) => reply.statusCode).sort(), [201, 409], `${a}/${b}`);
    }
  } finally {
    await f.close();
  }
});

test('duplicate labels are refused before creating blob directories in another folder', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.server.app.inject({
          method: 'POST',
          url: '/api/v1/storage-locations',
          headers: f.auth,
          payload: { path: f.extra, label: 'External' },
        })
      ).statusCode,
      201,
    );
    const untouched = join(f.base, 'untouched');
    await mkdir(untouched);
    const duplicate = await f.server.app.inject({
      method: 'POST',
      url: '/api/v1/storage-locations',
      headers: f.auth,
      payload: { path: untouched, label: 'External' },
    });
    assert.equal(duplicate.statusCode, 409);
    await assert.rejects(stat(join(untouched, 'blobs')));
  } finally {
    await f.close();
  }
});

async function stagedLocationUpload(f: Awaited<ReturnType<typeof fixture>>) {
  const libraryId = f.server.catalog.listLibraries(f.ownerId, true)[0]?.id;
  assert.ok(libraryId);
  const item = f.server.catalog.createItem({
    libraryId,
    systemIdentifier: 'com.provenance.nes',
    title: 'Generated upload',
    md5: null,
    crc: null,
    actorId: f.ownerId,
  });
  const location = await f.server.app.inject({
    method: 'POST',
    url: '/api/v1/storage-locations',
    headers: f.auth,
    payload: { path: f.extra, label: 'External' },
  });
  const id = (location.json() as { id: string }).id;
  await f.server.app.inject({
    method: 'PUT',
    url: '/api/v1/storage-locations/write-target',
    headers: f.auth,
    payload: { id },
  });
  const opened = await f.server.app.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers: f.auth,
    payload: { libraryId },
  });
  const uploadId = (opened.json() as { id: string }).id;
  await f.server.app.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${uploadId}/content`,
    headers: { ...f.auth, 'content-type': 'application/octet-stream' },
    payload: Buffer.from('generated'),
  });
  return {
    id,
    uploadId,
    payload: {
      itemId: item.id,
      kind: 'rom',
      displayName: 'Generated',
      relativePath: 'generated',
      baseRevision: item.revision,
    },
  };
}

test('changing target and removing the old location cannot interrupt an in-flight placement', async () => {
  const f = await fixture();
  const original = f.server.catalog.writeLocation.bind(f.server.catalog);
  try {
    const staged = await stagedLocationUpload(f);
    let management: Promise<{ primary: number; removed: number }> | undefined;
    let armed = true;
    // Schedule actual management requests at the target-capture boundary. The
    // placement's filesystem awaits allow them to run before catalog commit.
    f.server.catalog.writeLocation = () => {
      const value = original();
      if (armed) {
        armed = false;
        management = (async () => {
          const primary = await f.server.app.inject({
            method: 'PUT',
            url: '/api/v1/storage-locations/write-target',
            headers: f.auth,
            payload: { id: null },
          });
          const removed = await f.server.app.inject({
            method: 'DELETE',
            url: `/api/v1/storage-locations/${staged.id}`,
            headers: f.auth,
          });
          return { primary: primary.statusCode, removed: removed.statusCode };
        })();
      }
      return value;
    };
    const completed = await f.server.app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${staged.uploadId}/complete`,
      headers: f.auth,
      payload: staged.payload,
    });
    assert.ok(management);
    assert.deepEqual(await management, { primary: 200, removed: 409 });
    assert.equal(completed.statusCode, 201, completed.body);
  } finally {
    f.server.catalog.writeLocation = original;
    await f.close();
  }
});

test('failed filesystem or metadata completion releases the location reservation', async () => {
  for (const failure of ['offline', 'metadata']) {
    const f = await fixture();
    try {
      const staged = await stagedLocationUpload(f);
      if (failure === 'offline') await rename(f.extra, join(f.base, 'unplugged'));
      const completed = await f.server.app.inject({
        method: 'POST',
        url: `/api/v1/uploads/${staged.uploadId}/complete`,
        headers: f.auth,
        payload: { ...staged.payload, ...(failure === 'metadata' ? { displayName: 7 } : {}) },
      });
      assert.equal(completed.statusCode, failure === 'offline' ? 503 : 400);
      await f.server.app.inject({
        method: 'PUT',
        url: '/api/v1/storage-locations/write-target',
        headers: f.auth,
        payload: { id: null },
      });
      const removed = await f.server.app.inject({
        method: 'DELETE',
        url: `/api/v1/storage-locations/${staged.id}`,
        headers: f.auth,
      });
      assert.equal(removed.statusCode, 204, removed.body);
    } finally {
      await f.close();
    }
  }
});
