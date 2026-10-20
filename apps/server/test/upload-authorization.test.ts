import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

for (const phase of ['read-only device', 'demoted member', 'removed member'] as const) {
  test(`${phase} cannot change an existing owned upload`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'ecs-upload-authorization-'));
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
    assert.equal((await setRole('editor')).statusCode, 204);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'editor', password: 'correct-horse' },
    });
    assert.equal(login.statusCode, 200);
    const editor = { authorization: `Bearer ${login.json().token}` };
    const item = await app.inject({
      method: 'POST',
      url: '/api/v1/items',
      headers: editor,
      payload: { libraryId, systemIdentifier: 'com.provenance.nes', title: 'Upload access' },
    });
    assert.equal(item.statusCode, 201);
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: editor,
      payload: { libraryId },
    });
    assert.equal(upload.statusCode, 201);
    const url = `/api/v1/uploads/${upload.json().id}`;
    const put = (headers: Record<string, string>, offset: number, bytes: string) =>
      app.inject({
        method: 'PUT',
        url: `${url}/content`,
        headers: {
          ...headers,
          'content-type': 'application/octet-stream',
          'content-range': `bytes ${offset}-${offset + bytes.length - 1}/8`,
        },
        payload: Buffer.from(bytes),
      });
    const complete = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: `${url}/complete`,
        headers,
        payload: {
          itemId: item.json().id,
          kind: 'rom',
          relativePath: 'generated.bin',
          displayName: 'generated.bin',
          baseRevision: item.json().revision,
        },
      });
    assert.equal((await put(editor, 0, 'head')).statusCode, 204);
    let restricted = editor;
    if (phase === 'read-only device') {
      const device = await app.inject({
        method: 'POST',
        url: '/api/v1/device-tokens',
        headers: editor,
        payload: { name: 'reader', scopes: ['read'] },
      });
      assert.equal(device.statusCode, 201);
      restricted = { authorization: `Bearer ${device.json().token}` };
    } else if (phase === 'demoted member') {
      assert.equal((await setRole('reader')).statusCode, 204);
    } else {
      assert.equal(
        (await app.inject({ method: 'DELETE', url: membership, headers: owner })).statusCode,
        204,
      );
    }
    const status = phase === 'removed member' ? 404 : 403;
    const code = phase === 'removed member' ? 'not-found' : 'forbidden';
    for (const request of [
      () => put(restricted, 4, 'EVIL'),
      () => app.inject({ method: 'DELETE', url, headers: restricted }),
      () => complete(restricted),
    ]) {
      const denied = await request();
      assert.equal(denied.statusCode, status);
      assert.equal(denied.json().type, `urn:ecs:problem:${code}`);
    }
    const visible = await app.inject({ url, headers: restricted });
    assert.equal(visible.statusCode, phase === 'removed member' ? 404 : 200);
    if (visible.statusCode === 200) {
      assert.equal(visible.json().received, 4);
      assert.equal(visible.json().state, 'open');
    }
    assert.equal((await setRole('editor')).statusCode, 204);
    const restored = await app.inject({ url, headers: editor });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().received, 4);
    assert.equal(restored.json().state, 'open');
    const otherUser = await app.inject({ method: 'DELETE', url, headers: owner });
    assert.equal(otherUser.statusCode, 404);
    let writer = editor;
    if (phase === 'read-only device') {
      const device = await app.inject({
        method: 'POST',
        url: '/api/v1/device-tokens',
        headers: editor,
        payload: { name: 'writer', scopes: ['write'] },
      });
      assert.equal(device.statusCode, 201);
      writer = { authorization: `Bearer ${device.json().token}` };
      const cannotRead = await app.inject({ url, headers: writer });
      assert.equal(cannotRead.statusCode, 403);
      assert.equal(cannotRead.json().type, 'urn:ecs:problem:forbidden');
    }
    assert.equal((await put(writer, 4, 'tail')).statusCode, 204);
    const finished = await complete(writer);
    assert.equal(finished.statusCode, 201, finished.body);
    const content = await app.inject({
      url: `/api/v1/files/${finished.json().id}/content`,
      headers: editor,
    });
    assert.equal(content.statusCode, 200);
    assert.equal(content.body, 'headtail');
  });
}
