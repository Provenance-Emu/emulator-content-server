import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentClient } from '../src/index.js';

test('browse client escapes queries and rejects mismatched payload envelopes', async () => {
  const old = globalThis.fetch;
  const seen: Array<{ url: URL; init?: RequestInit }> = [];
  let result: unknown = { items: [], nextCursor: null };
  globalThis.fetch = async (input, init) => {
    seen.push({ url: new URL(String(input)), init });
    return Response.json(result);
  };
  try {
    const client = new ContentClient('http://example.test') as ContentClient & {
      browse(query: unknown): Promise<unknown>;
      renameLibrary(id: string, patch: { name: string }, revision: number): Promise<unknown>;
    };
    assert.equal(typeof client.browse, 'function');
    await client.browse({
      libraryId: 'a/b',
      category: 'games',
      search: '100% & ü',
      sort: 'name_desc',
      limit: 50,
    });
    assert.equal(seen[0]?.url.searchParams.get('libraryId'), 'a/b');
    assert.equal(seen[0]?.url.searchParams.get('search'), '100% & ü');
    await client.renameLibrary('a/b', { name: 'New' }, 7);
    assert.equal(seen[1]?.url.pathname, '/api/v1/libraries/a%2Fb');
    assert.equal(new Headers(seen[1]?.init?.headers).get('if-match'), '"rev-7"');
    for (const entry of [
      { entityType: 'item', id: 'i', item: { id: 'i' }, source: {} },
      { entityType: 'item', id: 'i', item: {} },
      { entityType: 'source', id: 's', source: {}, canUpload: true, canAdopt: false },
    ]) {
      result = { items: [entry], nextCursor: null };
      await assert.rejects(client.browse({ unassigned: true, category: 'games' }), /browse/i);
    }
  } finally {
    globalThis.fetch = old;
  }
});

test('client management operations preserve escaped IDs and body contracts', async () => {
  const old = globalThis.fetch;
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: new URL(String(input)), init });
    return Response.json({ items: [], nextCursor: null });
  };
  try {
    const client = new ContentClient('http://example.test');
    await client.createLibrary({ name: 'Empty' });
    await client.browseLibraries();
    await client.rootSummaries({ libraryId: 'a/b' });
    await client.rootSummaries({ unassigned: true });
    await client.rootSummaries({ unassigned: false });
    await client.rootSummaries({ libraryId: 'a/b', unassigned: false });
    await client.assignRoot('root/id', { libraryId: 'a/b' });
    assert.equal(requests[0]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { name: 'Empty' });
    assert.equal(requests[1]?.url.pathname, '/api/v1/browse-libraries');
    assert.equal(requests[2]?.url.searchParams.get('libraryId'), 'a/b');
    assert.equal(requests[2]?.url.search, '?libraryId=a%2Fb');
    assert.equal(requests[3]?.url.searchParams.get('unassigned'), 'true');
    assert.equal(requests[4]?.url.searchParams.has('unassigned'), false);
    assert.equal(requests[5]?.url.searchParams.has('unassigned'), false);
    assert.equal(requests[5]?.url.search, '?libraryId=a%2Fb');
    assert.equal(requests[6]?.url.pathname, '/api/v1/roots/root%2Fid/library');
    assert.equal(requests[6]?.init?.method, 'PUT');
    assert.deepEqual(JSON.parse(String(requests[6]?.init?.body)), { libraryId: 'a/b' });
  } finally {
    globalThis.fetch = old;
  }
});

test('browse rejects incomplete matching payloads before controllers receive them', async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      items: [
        {
          entityType: 'item',
          id: 'i',
          name: 'Game',
          libraryId: 'l',
          systemId: 's',
          canUpload: false,
          canAdopt: false,
          item: { id: 'i' },
        },
      ],
      nextCursor: null,
    });
  try {
    await assert.rejects(
      new ContentClient('http://example.test').browse({ libraryId: 'l', category: 'games' }),
      /browse/i,
    );
  } finally {
    globalThis.fetch = old;
  }
});

test('browse requires a primitive discriminator and matching payload', async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      items: [
        {
          entityType: ['item'],
          id: 'i',
          name: 'Game',
          libraryId: 'l',
          systemId: 's',
          canUpload: false,
          canAdopt: false,
        },
      ],
      nextCursor: null,
    });
  try {
    await assert.rejects(
      new ContentClient('http://example.test').browse({ libraryId: 'l', category: 'games' }),
      /browse/i,
    );
  } finally {
    globalThis.fetch = old;
  }
});
