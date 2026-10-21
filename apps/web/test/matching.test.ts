import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';
import { createMatching } from '../src/lib/matching.js';
import { transport } from './library-browser-fixture.js';
import { deferred } from './lifecycle-fixture.js';

const reply = {
  sourceId: 'source',
  requestId: 'request',
  plugins: [
    {
      id: 'org.ecs.local',
      name: 'Local',
      kind: 'provider',
      capabilities: ['artwork'],
      network: false,
    },
  ],
  candidates: [
    {
      id: 'art',
      providerId: 'org.ecs.local',
      kind: 'artwork',
      title: 'Game',
      confidence: 'local',
      metadata: {},
    },
  ],
  problems: [],
};
test('matching is explicit, carries provider options, and previews only returned artwork candidates', async (t) => {
  let previews = 0;
  const f = transport((url, init) => {
    if (url.pathname.endsWith('/matches')) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        online: false,
        providerIds: ['org.ecs.local'],
      });
      return Response.json(reply);
    }
    if (url.pathname.endsWith('/art')) {
      previews++;
      return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
        headers: { 'content-type': 'image/png' },
      });
    }
    throw new Error('Unexpected request');
  });
  t.after(f.restore);
  const controller = createMatching(f.client, 'source');
  t.after(() => controller.dispose());
  assert.equal(f.requests.length, 0);
  await controller.find({ online: false, providerIds: ['org.ecs.local'] });
  assert.equal(get(controller).result?.candidates[0]?.title, 'Game');
  await controller.preview('unknown');
  assert.equal(previews, 0);
  await controller.preview('art');
  assert.equal(previews, 1);
  assert.ok(get(controller).artwork.art?.startsWith('blob:'));
});

test('disposing matching aborts the request and refuses late private results', async (t) => {
  const pending = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  const f = transport((_url, init) => {
    signal = init?.signal;
    return pending.promise;
  });
  t.after(f.restore);
  const controller = createMatching(f.client, 'source');
  const result = controller.find({ online: true });
  controller.dispose();
  assert.equal(signal?.aborted, true);
  pending.resolve(Response.json(reply));
  await result;
  assert.equal(get(controller).result, null);
});

test('an artwork authorization failure clears private matching results', async (t) => {
  const f = transport((url) =>
    url.pathname.endsWith('/matches')
      ? Response.json(reply)
      : Response.json(
          { title: 'Forbidden', detail: 'Access revoked', status: 403 },
          { status: 403 },
        ),
  );
  t.after(f.restore);
  const controller = createMatching(f.client, 'source');
  t.after(() => controller.dispose());
  await controller.find({});
  await controller.preview('art');
  assert.equal(get(controller).result, null);
  assert.deepEqual(get(controller).artwork, {});
});

test('missing provider artwork preserves the successful metadata lookup', async (t) => {
  const f = transport((url) =>
    url.pathname.endsWith('/matches')
      ? Response.json(reply)
      : Response.json(
          {
            type: 'urn:ecs:problem:artwork-unavailable',
            title: 'Artwork unavailable',
            status: 404,
          },
          { status: 404 },
        ),
  );
  t.after(f.restore);
  const controller = createMatching(f.client, 'source');
  t.after(() => controller.dispose());
  await controller.find({});
  await controller.preview('art');
  assert.equal(get(controller).result?.requestId, 'request');
});
