import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentClient } from '../src/client.js';

const id = 'ab'.repeat(24);
const session = {
  id,
  url: `http://127.0.0.1:54321/${id}/dolphin-sandbox.html`,
  expiresAt: '2030-01-01T00:00:00.000Z',
};
test('isolation methods use fixed bearer routes and keep DELETE alive during pagehide', async (t) => {
  const requests: { url: string; init?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer generated-token');
    assert.equal(init?.redirect, 'error');
    return init?.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : Response.json(session, { status: 201 });
  });
  const client = new ContentClient('http://127.0.0.1:8473', 'generated-token');
  assert.deepEqual(await client.createPlayerIsolation('org.example.dolphin'), session);
  await client.closePlayerIsolation(id);
  assert.deepEqual(
    requests.map((r) => [r.url, r.init?.method]),
    [
      ['http://127.0.0.1:8473/api/v1/player/isolated-sessions', 'POST'],
      [`http://127.0.0.1:8473/api/v1/player/isolated-sessions/${id}`, 'DELETE'],
    ],
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    profileId: 'org.example.dolphin',
  });
  assert.equal(requests[1]?.init?.keepalive, true);
  await assert.rejects(client.createPlayerIsolation('../outside'));
  await assert.rejects(client.closePlayerIsolation('../outside'));
  assert.equal(requests.length, 2);
});

test('isolation responses cannot redirect the iframe to another host, path or credentials', async (t) => {
  let answer: unknown = session;
  t.mock.method(globalThis, 'fetch', async () => Response.json(answer));
  const client = new ContentClient('http://127.0.0.1:8473', 'generated-token');
  for (const url of [
    'https://127.0.0.1:54321/',
    'http://localhost:54321/',
    'http://external.invalid/',
    `http://127.0.0.1:54321/${id}/other.html`,
    `http://user:pass@127.0.0.1:54321/${id}/dolphin-sandbox.html`,
    `${session.url}?token=generated`,
    `${session.url}#unexpected`,
  ]) {
    answer = { ...session, url };
    await assert.rejects(client.createPlayerIsolation('org.example.dolphin'), /Invalid isolated/);
  }
  answer = { ...session, id: 'cd'.repeat(24) };
  await assert.rejects(client.createPlayerIsolation('org.example.dolphin'), /Invalid isolated/);
  answer = { ...session, expiresAt: 'invalid' };
  await assert.rejects(client.createPlayerIsolation('org.example.dolphin'), /Invalid isolated/);
  answer = null;
  await assert.rejects(client.createPlayerIsolation('org.example.dolphin'), /Invalid isolated/);
});
