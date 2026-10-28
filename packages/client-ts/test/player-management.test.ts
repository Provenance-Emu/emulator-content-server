import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentClient } from '../src/client.js';

test('emulator management uses fixed authenticated routes and bounded native package uploads', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const requests: {
    url: string;
    method: string;
    type: string | null;
    redirect: 'error' | 'follow' | 'manual' | undefined;
  }[] = [];
  globalThis.fetch = async (url, options) => {
    const headers = new Headers(options?.headers);
    assert.ok(headers.get('authorization')?.startsWith('Bearer '));
    requests.push({
      url: String(url),
      method: options?.method ?? 'GET',
      type: headers.get('content-type'),
      redirect: options?.redirect,
    });
    return Response.json({ items: [], defaultProfileId: null, available: [] });
  };
  const client = new ContentClient('https://example.test', 'generated-fixture');
  await client.playerManagement();
  await client.installPlayer('org.example.core');
  await client.configurePlayer('org.example.core', { enabled: false });
  await client.removePlayer('org.example.core');
  await client.installPlayerPackage(new Blob([new Uint8Array(4)]));
  assert.deepEqual(
    requests.map((r) => [new URL(r.url).pathname, r.method]),
    [
      ['/api/v1/player/management', 'GET'],
      ['/api/v1/player/management/install/org.example.core', 'POST'],
      ['/api/v1/player/management/org.example.core', 'PATCH'],
      ['/api/v1/player/management/org.example.core', 'DELETE'],
      ['/api/v1/player/management/install', 'POST'],
    ],
  );
  assert.equal(requests.at(-1)?.type, 'application/vnd.ecs.player-package');
  assert.ok(
    requests.every((request) => request.redirect === 'error'),
    'All owner management requests must refuse redirects',
  );
  const count = requests.length;
  assert.throws(() => client.installPlayer('../outside'));
  await assert.rejects(client.installPlayerPackage(new Blob([])));
  assert.equal(requests.length, count);
});
