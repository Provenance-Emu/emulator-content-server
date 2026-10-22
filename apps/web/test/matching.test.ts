import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';
import { createMatching } from '../src/lib/matching.js';
import { problem, transport } from './library-browser-fixture.js';
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

test('saved-match loading can recover from a transient failure without discarding suggestions', async (t) => {
  let fail = true;
  const f = transport((url) =>
    url.pathname.endsWith('/matches')
      ? Response.json(reply)
      : fail
        ? problem(503)
        : Response.json({ sourceId: 'source', revision: 3, matches: [] }),
  );
  t.after(f.restore);
  const controller = createMatching(f.client, 'source');
  t.after(() => controller.dispose());
  await controller.load();
  assert.equal(get(controller).savedLoadFailed, true);
  assert.equal(get(controller).saved, null);
  await controller.find({});
  fail = false;
  await controller.load();
  assert.equal(get(controller).savedLoadFailed, false);
  assert.equal(get(controller).saved?.revision, 3);
  assert.equal(get(controller).failure, null);
  assert.equal(get(controller).result?.requestId, 'request');
});

for (const remove of [false, true])
  test(`a lost ${remove ? 'removal' : 'save'} response reconciles committed selections without another write`, async (t) => {
    const selection = {
      ...reply.candidates[0],
      contentAvailable: false,
      contentType: null,
      fileName: null,
      updatedAt: '',
    };
    let matches = remove ? [selection] : [];
    let revision = 1;
    let writes = 0;
    const f = transport((url, init) => {
      if (url.pathname.endsWith('/matches')) return Response.json(reply);
      if (init?.method === 'PUT' || init?.method === 'DELETE') {
        writes++;
        matches = remove ? [] : [selection];
        revision++;
        throw new TypeError('Generated response loss after commit');
      }
      return Response.json({ sourceId: 'source', revision, matches });
    });
    t.after(f.restore);
    const controller = createMatching(f.client, 'source');
    t.after(() => controller.dispose());
    await controller.load();
    await controller.find({});
    assert.equal(await (remove ? controller.remove('artwork') : controller.save('art')), true);
    assert.equal(writes, 1);
    assert.equal(get(controller).saved?.revision, 2);
    assert.equal(get(controller).saved?.matches.length, remove ? 0 : 1);
    assert.equal(get(controller).failure, null);
  });

test('an unavailable conflict refresh blocks further writes until saved choices reload', async (t) => {
  let reads = 0;
  let writes = 0;
  let unavailable = true;
  const f = transport((url, init) => {
    if (url.pathname.endsWith('/matches')) return Response.json(reply);
    if (init?.method === 'PUT') {
      writes++;
      return problem(409, 'matching-conflict');
    }
    if (++reads > 1 && unavailable) return problem(503);
    return Response.json({ sourceId: 'source', revision: reads === 1 ? 1 : 4, matches: [] });
  });
  t.after(f.restore);
  const controller = createMatching(f.client, 'source');
  t.after(() => controller.dispose());
  await controller.load();
  await controller.find({});
  assert.equal(await controller.save('art'), false);
  assert.equal(get(controller).savedLoadFailed, true);
  assert.equal(await controller.save('art'), false);
  assert.equal(writes, 1, 'a stale revision cannot be resubmitted before recovery');
  unavailable = false;
  await controller.load();
  assert.equal(get(controller).saved?.revision, 4);
  assert.equal(get(controller).savedLoadFailed, false);
  assert.equal(get(controller).result?.requestId, 'request');
});

test('a conflict refresh never overwrites the current selection or automatically retries the write', async (t) => {
  let reads = 0;
  let writes = 0;
  const f = transport((url, init) => {
    if (url.pathname.endsWith('/matches')) return Response.json(reply);
    if (init?.method === 'PUT') {
      writes++;
      return problem(409, 'matching-conflict');
    }
    return Response.json({
      sourceId: 'source',
      revision: ++reads,
      matches:
        reads === 1
          ? []
          : [
              {
                ...reply.candidates[0],
                id: 'another-choice',
                contentAvailable: false,
                contentType: null,
                fileName: null,
                updatedAt: '',
              },
            ],
    });
  });
  t.after(f.restore);
  const controller = createMatching(f.client, 'source');
  t.after(() => controller.dispose());
  await controller.load();
  await controller.find({});
  assert.equal(await controller.save('art'), false);
  assert.equal(get(controller).saved?.matches[0]?.id, 'another-choice');
  assert.equal(get(controller).saved?.revision, 2);
  assert.ok(get(controller).failure);
  assert.equal(writes, 1);
});

for (const status of [401, 403, 404])
  test(`saved-match rejection ${status} cannot offer or perform a transient retry`, async (t) => {
    const f = transport(() => problem(status));
    t.after(f.restore);
    const controller = createMatching(f.client, 'source');
    t.after(() => controller.dispose());
    await controller.load();
    assert.equal(get(controller).savedLoadFailed, false);
    const count = f.requests.length;
    await controller.load();
    assert.equal(f.requests.length, count);
  });
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

test('selected matches load without lookup, save known candidates at the current revision and survive result clearing', async (t) => {
  let saved = { sourceId: 'source', revision: 0, matches: [] as unknown[] };
  let writes = 0;
  const f = transport((url, init) => {
    if (url.pathname.endsWith('/selections')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        assert.equal(body.expectedRevision, 0);
        assert.equal(body.candidateId, 'art');
        writes++;
        saved = {
          sourceId: 'source',
          revision: 1,
          matches: [
            {
              ...reply.candidates[0],
              contentAvailable: false,
              contentType: null,
              fileName: null,
              updatedAt: '',
            },
          ],
        };
      }
      return Response.json(saved);
    }
    if (url.pathname.endsWith('/matches')) return Response.json(reply);
    throw new Error('Unexpected request');
  });
  t.after(f.restore);
  const controller = createMatching(f.client, 'source');
  t.after(() => controller.dispose());
  await controller.load();
  assert.equal(get(controller).saved?.revision, 0);
  await controller.find({});
  assert.equal(await controller.save('unknown'), false);
  assert.equal(writes, 0);
  assert.equal(await controller.save('art'), true);
  assert.equal(get(controller).saved?.revision, 1);
  controller.clear();
  assert.equal(get(controller).saved?.matches.length, 1);
  assert.equal(get(controller).result, null);
});

test('authorization loss invalidates saved matches and prevents a late preview from restoring private content', async (t) => {
  const preview = deferred<Response>();
  const f = transport((url, init) => {
    if (url.pathname.endsWith('/selections'))
      return init?.method === 'PUT'
        ? Response.json(
            { type: 'urn:ecs:problem:forbidden', status: 403, title: 'Access revoked' },
            { status: 403 },
          )
        : Response.json({
            sourceId: 'source',
            revision: 0,
            matches: [
              {
                ...reply.candidates[0],
                kind: 'metadata',
                contentAvailable: false,
                contentType: null,
                fileName: null,
                updatedAt: '',
              },
            ],
          });
    if (url.pathname.endsWith('/matches')) return Response.json(reply);
    return preview.promise;
  });
  t.after(f.restore);
  const controller = createMatching(f.client, 'source');
  t.after(() => controller.dispose());
  await controller.load();
  await controller.find({});
  const pending = controller.preview('art');
  assert.equal(await controller.save('art'), false);
  preview.resolve(
    new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
      headers: { 'content-type': 'image/png' },
    }),
  );
  await pending;
  assert.equal(get(controller).saved, null);
  assert.deepEqual(get(controller).artwork, {});
  assert.equal(get(controller).result, null);
  const before = f.requests.length;
  await controller.find({});
  assert.equal(f.requests.length, before);
});

for (const refreshFails of [false, true])
  test(`automatic move ${refreshFails ? 'blocks stale proposals if refresh fails' : 'refreshes proposals before review continues'}`, async (t) => {
    let lookups = 0;
    let writes = 0;
    const selection = {
      ...reply.candidates[0],
      contentAvailable: false,
      contentType: null,
      fileName: null,
      updatedAt: '',
    };
    const f = transport((url, init) => {
      if (url.pathname.endsWith('/matches')) {
        lookups++;
        assert.deepEqual(JSON.parse(String(init?.body)), {
          online: false,
          providerIds: ['org.ecs.local'],
        });
        if (lookups > 1 && refreshFails) return problem(503);
        return Response.json({
          ...reply,
          requestId: `request-${lookups}`,
          candidates:
            lookups === 1
              ? reply.candidates
              : [{ ...reply.candidates[0], id: 'fresh', kind: 'metadata' }],
        });
      }
      if (init?.method === 'PUT') writes++;
      return Response.json({
        sourceId: 'source',
        revision: writes,
        matches: writes ? [selection] : [],
        ...(writes ? { automaticOrganization: { status: 'moved', sourceId: 'source' } } : {}),
      });
    });
    t.after(f.restore);
    const controller = createMatching(f.client, 'source');
    t.after(() => controller.dispose());
    await controller.load();
    await controller.find({ online: false, providerIds: ['org.ecs.local'] });
    assert.equal(await controller.save('art'), true, 'the saved choice remains committed');
    assert.equal(lookups, 2);
    assert.equal(get(controller).suggestionsStale, refreshFails);
    assert.equal(get(controller).saved?.matches[0]?.id, 'art');
    if (refreshFails) {
      assert.ok(get(controller).failure?.includes('saved'));
      assert.equal(await controller.save('art'), false);
      assert.equal(writes, 1);
    } else assert.equal(get(controller).result?.requestId, 'request-2');
  });
