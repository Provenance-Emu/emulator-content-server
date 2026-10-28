import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentClient } from '../src/client.js';

test('selection requests include artwork roles and encode role-specific content and deletion', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const requests: string[] = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (String(url).includes('/content')) return new Response(new Uint8Array([1, 2]));
    return Response.json({ sourceId: 'source/id', revision: 0, matches: [] });
  };
  const client = new ContentClient('https://example.test');
  await client.sourceSelections('source/id');
  await client.removeSourceMatch('source/id', 'artwork', 0, undefined, 'back');
  const content = await client.selectedMatchContent('source/id', 'artwork', undefined, 'manual');
  assert.equal(content.size, 2);
  const urls = requests.map((request) => new URL(request));
  assert.equal(urls[0]?.searchParams.get('includeArtworkRoles'), 'true');
  assert.equal(urls[1]?.searchParams.get('includeArtworkRoles'), 'true');
  assert.equal(urls[1]?.searchParams.get('artworkRole'), 'back');
  assert.equal(urls[2]?.searchParams.get('artworkRole'), 'manual');
  assert.ok(urls.every((url) => url.pathname.includes('source%2Fid')));
});

test('saved matches reject duplicate roles and invalid artwork role names', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const match = (id: string, artworkRole: string) => ({
    id,
    providerId: 'provider',
    kind: 'artwork',
    artworkRole,
    title: id,
    confidence: 'name',
    metadata: {},
    contentAvailable: false,
    contentType: null,
    fileName: null,
    updatedAt: '',
  });
  globalThis.fetch = async () =>
    Response.json({
      sourceId: 'source',
      revision: 1,
      matches: [match('one', 'back'), match('two', 'back')],
    });
  await assert.rejects(
    new ContentClient('https://example.test').sourceSelections('source'),
    /Invalid saved match/,
  );
  globalThis.fetch = async () =>
    Response.json({ sourceId: 'source', revision: 1, matches: [match('one', 'cover')] });
  await assert.rejects(
    new ContentClient('https://example.test').sourceSelections('source'),
    /Invalid saved match/,
  );
});
