import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { get } from 'svelte/store';
import { createPreviews } from '../src/lib/previews.js';
import { asset, entry, problem, transport } from './library-browser-fixture.js';
import { deferred } from './lifecycle-fixture.js';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const jpeg = new Uint8Array([255, 216, 255, 224, 0, 0, 255, 217]);
const webp = new Uint8Array([
  82, 73, 70, 70, 16, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32, 0, 0, 0, 0, 0, 0, 0, 0,
]);
function preview(id: string) {
  return {
    ...entry('item', id),
    previewAsset: { ...asset(`art-${id}`, 'artwork'), itemId: id, size: 12, conflictOf: null },
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function urls(t: TestContext) {
  const created: Blob[] = [];
  const revoked: string[] = [];
  let count = 0;
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => {
    created.push(blob);
    return `blob:generated-${++count}`;
  });
  t.mock.method(URL, 'revokeObjectURL', (url: string) => {
    revoked.push(url);
  });
  return { created, revoked };
}

test('previews accept only validated PNG JPEG WebP bytes and assign derived image MIME types', async (t) => {
  const objects = urls(t);
  const bodies = [
    png,
    jpeg,
    webp,
    new TextEncoder().encode('<svg onload="generated"/>'),
    new Uint8Array([1, 2, 3]),
  ];
  let n = 0;
  const f = transport(() => new Response(bodies[n++]));
  t.after(f.restore);
  const p = createPreviews(f.client);
  t.after(() => p.dispose());
  await p.setPage(bodies.map((_, i) => preview(String(i))));
  assert.deepEqual(
    objects.created.map((blob) => blob.type),
    ['image/png', 'image/jpeg', 'image/webp'],
  );
  assert.deepEqual(Object.keys(get(p).urls).sort(), ['item:0', 'item:1', 'item:2']);
  assert.equal(get(p).loading, false);
  await p.setPage([]);
  assert.equal(objects.revoked.length, 3);
  assert.deepEqual(get(p).urls, {});
});

test('previews bound actual reads to 2 MiB and skip absent oversized or nonartwork page metadata', async (t) => {
  const objects = urls(t);
  const f = transport(
    () =>
      new Response(new Uint8Array([1]), {
        headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
      }),
  );
  t.after(f.restore);
  const p = createPreviews(f.client);
  t.after(() => p.dispose());
  const large = preview('large');
  assert.ok(large.previewAsset);
  large.previewAsset.size = 2 * 1024 * 1024 + 1;
  const wrong = preview('wrong');
  assert.ok(wrong.previewAsset);
  wrong.previewAsset.kind = 'rom';
  await p.setPage([entry(), large, wrong, preview('header-too-large')]);
  assert.equal(f.requests.length, 1);
  assert.equal(objects.created.length, 0);
  assert.deepEqual(get(p).urls, {});
});

test('rapid page replacements keep four total active reads including older pages and ignore all stale bytes', async (t) => {
  const objects = urls(t);
  const responses: Array<ReturnType<typeof deferred<Response>>> = [];
  let active = 0;
  let maximum = 0;
  const f = transport(() => {
    active++;
    maximum = Math.max(maximum, active);
    const response = deferred<Response>();
    responses.push(response);
    return response.promise.finally(() => {
      active--;
    });
  });
  t.after(f.restore);
  const p = createPreviews(f.client);
  t.after(() => p.dispose());
  const old = p.setPage(Array.from({ length: 8 }, (_, i) => preview(`old-${i}`)));
  assert.equal(responses.length, 4);
  const abandoned = p.setPage([preview('abandoned')]);
  const fresh = p.setPage([preview('fresh-1'), preview('fresh-2')]);
  assert.equal(responses.length, 4);
  responses[0]?.resolve(new Response(png));
  await flush();
  assert.equal(responses.length, 5);
  assert.equal(objects.created.length, 0);
  responses[1]?.resolve(new Response(png));
  await flush();
  assert.equal(responses.length, 6);
  responses[4]?.resolve(new Response(png));
  responses[5]?.resolve(new Response(jpeg));
  await fresh;
  assert.equal(maximum, 4);
  assert.deepEqual(Object.keys(get(p).urls).sort(), ['item:fresh-1', 'item:fresh-2']);
  assert.equal(
    f.requests.some((url) => url.pathname.includes('abandoned')),
    false,
  );
  responses[2]?.resolve(new Response(png));
  responses[3]?.resolve(new Response(png));
  await Promise.all([old, abandoned]);
  assert.equal(objects.created.length, 2);
  p.dispose();
  assert.equal(objects.revoked.length, 2);
  assert.deepEqual(get(p).urls, {});
});

test('disposing previews revokes present URLs and never creates URLs or starts queued reads from delayed bytes', async (t) => {
  const objects = urls(t);
  let late = false;
  const response = deferred<Response>();
  const f = transport(() =>
    late ? response.promise.then((result) => result.clone()) : new Response(png),
  );
  t.after(f.restore);
  const p = createPreviews(f.client);
  await p.setPage([preview('present')]);
  late = true;
  const pending = p.setPage(Array.from({ length: 6 }, (_, i) => preview(`late-${i}`)));
  assert.equal(objects.revoked.length, 1);
  assert.equal(f.requests.length, 5);
  p.dispose();
  response.resolve(new Response(png));
  await pending;
  assert.equal(objects.created.length, 1);
  assert.equal(f.requests.length, 5);
  assert.deepEqual(get(p).urls, {});
});

test('a denied preview revokes already displayed images from its page', async (t) => {
  const objects = urls(t);
  const denied = deferred<Response>();
  let n = 0;
  const f = transport(() => (n++ === 0 ? new Response(png) : denied.promise));
  t.after(f.restore);
  const p = createPreviews(f.client);
  t.after(() => p.dispose());
  const loading = p.setPage([preview('good'), preview('denied')]);
  await flush();
  assert.equal(Object.keys(get(p).urls).length, 1);
  denied.resolve(problem(403));
  await loading;
  assert.deepEqual(get(p).urls, {});
  assert.equal(objects.revoked.length, 1);
});

test('preview streamed bytes obey the size budget even without a Content-Length header', async (t) => {
  const objects = urls(t);
  const f = transport(() => new Response(new Uint8Array(2 * 1024 * 1024 + 1)));
  t.after(f.restore);
  const p = createPreviews(f.client);
  t.after(() => p.dispose());
  await p.setPage([preview('too-large-stream')]);
  assert.equal(objects.created.length, 0);
  assert.equal(f.requests.length, 1);
  assert.equal(get(p).loading, false);
});

for (const status of [401, 403] as const) {
  test(`preview rejection ${status} emits its authorization signal after URL cleanup and suppresses sibling rejections`, async (t) => {
    const objects = urls(t);
    const denied = deferred<Response>();
    let n = 0;
    const f = transport(() =>
      n++ === 0 ? new Response(png) : denied.promise.then((result) => result.clone()),
    );
    t.after(f.restore);
    const rejections: number[] = [];
    const previews = createPreviews(f.client, {
      authorizationRejected(rejected) {
        assert.deepEqual(get(previews).urls, {});
        assert.equal(objects.revoked.length, 1);
        rejections.push(rejected);
      },
    });
    t.after(() => previews.dispose());
    const reading = previews.setPage([preview('good'), preview('denied-1'), preview('denied-2')]);
    await flush();
    denied.resolve(problem(status));
    await reading;
    assert.deepEqual(rejections, [status]);
    assert.equal(get(previews).loading, false);
  });
}

test('stale-page and disposed preview authorization failures never signal against newer views', async (t) => {
  urls(t);
  const old = deferred<Response>();
  const disposed = deferred<Response>();
  const f = transport((url) =>
    url.pathname.includes('art-old')
      ? old.promise
      : url.pathname.includes('art-disposed')
        ? disposed.promise
        : new Response(png),
  );
  t.after(f.restore);
  const rejections: number[] = [];
  const previews = createPreviews(f.client, {
    authorizationRejected: (status) => rejections.push(status),
  });
  const oldRead = previews.setPage([preview('old')]);
  await previews.setPage([preview('current')]);
  old.resolve(problem(401));
  await oldRead;
  assert.deepEqual(rejections, []);
  assert.equal(Object.keys(get(previews).urls)[0], 'item:current');
  const delayed = previews.setPage([preview('disposed')]);
  previews.dispose();
  disposed.resolve(problem(403));
  await delayed;
  assert.deepEqual(rejections, []);
  assert.deepEqual(get(previews).urls, {});
});

test('ordinary unavailable unsupported oversized and network preview failures do not signal auth loss', async (t) => {
  urls(t);
  const f = transport((url) => {
    if (url.pathname.includes('network')) throw new TypeError('generated network failure');
    if (url.pathname.includes('unsupported')) return new Response(new Uint8Array([1, 2, 3]));
    if (url.pathname.includes('oversized'))
      return new Response(new Uint8Array(2 * 1024 * 1024 + 1));
    return problem(503);
  });
  t.after(f.restore);
  const rejections: number[] = [];
  const previews = createPreviews(f.client, {
    authorizationRejected: (status) => rejections.push(status),
  });
  t.after(() => previews.dispose());
  await previews.setPage(['network', 'unsupported', 'oversized', 'unavailable'].map(preview));
  assert.deepEqual(rejections, []);
  assert.deepEqual(get(previews).urls, {});
  assert.equal(get(previews).loading, false);
});

test('authorization cleanup cannot signal against a page replaced synchronously by a subscriber', async (t) => {
  urls(t);
  const denied = deferred<Response>();
  const f = transport((url) =>
    url.pathname.includes('denied') ? denied.promise : new Response(png),
  );
  t.after(f.restore);
  const rejections: number[] = [];
  const previews = createPreviews(f.client, {
    authorizationRejected: (status) => rejections.push(status),
  });
  t.after(() => previews.dispose());
  let replace = false;
  let replacement: Promise<void> | null = null;
  const unsubscribe = previews.subscribe((state) => {
    if (replace && !state.loading && Object.keys(state.urls).length === 0) {
      replace = false;
      replacement = previews.setPage([preview('new-context-page')]);
    }
  });
  t.after(unsubscribe);
  const old = previews.setPage([preview('old-good'), preview('denied')]);
  await flush();
  replace = true;
  denied.resolve(problem(401));
  await old;
  await replacement;
  assert.deepEqual(rejections, []);
  assert.deepEqual(Object.keys(get(previews).urls), ['item:new-context-page']);
});

test('source cards use saved artwork through the authenticated selected-content endpoint', async (t) => {
  const source = entry('source', 'source');
  assert.ok(source.source);
  source.source.artworkAvailable = true;
  const f = transport((url) => {
    assert.equal(url.pathname, '/api/v1/sources/source/matches/selections/artwork/content');
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  });
  t.after(f.restore);
  const controller = createPreviews(f.client);
  t.after(() => controller.dispose());
  await controller.setPage([source]);
  assert.equal(Object.keys(get(controller).urls).length, 1);
});
