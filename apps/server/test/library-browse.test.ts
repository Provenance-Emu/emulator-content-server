import assert from 'node:assert/strict';
import test from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { libraryFixture } from './library-fixture.js';

test('browse defaults to 50, pages original identities and validates bound filters', async () => {
  const f = await libraryFixture();
  try {
    const ids = new Set(
      Array.from({ length: 105 }, (_, i) => f.item(`Game ${i.toString().padStart(3, '0')}`).id),
    );
    const url = `/api/v1/browse?libraryId=${f.library.id}&category=games`;
    const first = await f.app.inject({ url, headers: f.auth });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().items.length, 50);
    for (const entry of first.json().items) {
      assert.equal(entry.entityType, 'item');
      assert.equal(entry.item.id, entry.id);
      assert.equal(entry.canUpload, true);
      assert.equal(entry.canAdopt, false);
      ids.delete(entry.id);
    }
    let cursor = first.json().nextCursor;
    while (cursor) {
      const page: LightMyRequestResponse = await f.app.inject({
        url: `${url}&cursor=${cursor}`,
        headers: f.auth,
      });
      assert.equal(page.statusCode, 200, page.body);
      for (const entry of page.json().items) {
        assert.ok(ids.delete(entry.id));
      }
      cursor = page.json().nextCursor;
    }
    assert.equal(ids.size, 0);
    assert.equal(
      (await f.app.inject({ url: `${url}&limit=100`, headers: f.auth })).json().items.length,
      100,
    );
    for (const suffix of [
      '&limit=0',
      '&limit=101',
      '&sort=no',
      '&cursor=no',
      `&search=${'x'.repeat(257)}`,
      '&unassigned=true',
      '&rootId=missing',
    ])
      assert.equal(
        (await f.app.inject({ url: url + suffix, headers: f.auth })).statusCode,
        suffix.includes('rootId') ? 404 : 400,
        suffix,
      );
    assert.equal(
      (await f.app.inject({ url: '/api/v1/browse?category=games', headers: f.auth })).statusCode,
      400,
    );
    assert.equal(
      (await f.app.inject({ url: `${url}&systemId=unknown`, headers: f.auth })).json().items.length,
      0,
    );
    assert.equal(
      (
        await f.app.inject({
          url: `${url}&sort=name_desc&cursor=${first.json().nextCursor}`,
          headers: f.auth,
        })
      ).statusCode,
      400,
    );
    assert.equal((await f.app.inject({ url, remoteAddress: '8.8.8.8' })).statusCode, 401);
  } finally {
    await f.dispose();
  }
});

test('long names remain pageable', async () => {
  const f = await libraryFixture();
  try {
    for (let i = 0; i < 4; i++) f.item('x'.repeat(10000) + i);
    let cursor: string | null = null;
    const ids = new Set<string>();
    do {
      const page: LightMyRequestResponse = await f.app.inject({
        url: `/api/v1/browse?libraryId=${f.library.id}&category=games&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        headers: f.auth,
      });
      assert.equal(page.statusCode, 200, page.body);
      ids.add(page.json().items[0].id);
      cursor = page.json().nextCursor;
      if (cursor) assert.ok(cursor.length < 4096);
    } while (cursor);
    assert.equal(ids.size, 4);
  } finally {
    await f.dispose();
  }
});

test('guest source content rejects known IDs outside read and item scope', async () => {
  const f = await libraryFixture();
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { issueToken } = await import('@ecs/auth');
    const path = join(f.base, 'shared');
    await mkdir(path);
    await writeFile(join(path, 'generated.nes'), 'generated');
    const root = f.catalog.createContentRoot({
      path,
      label: 'shared',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
    const source = f.catalog.listSources(root.id)[0];
    assert.ok(source);
    const item = f.item('Guest target');
    for (const [capabilities, itemId, expected] of [
      [['read'], null, 200],
      [['write'], null, 404],
      [['read'], item.id, 404],
    ] as const) {
      const token = issueToken();
      f.catalog.createGuestGrant({
        tokenHash: token.hash,
        libraryId: f.library.id,
        itemId,
        capabilities: [...capabilities],
        expiresAt: '2099-01-01T00:00:00Z',
        createdBy: f.owner.id,
      });
      for (const method of ['GET', 'HEAD'] as const) {
        const response: LightMyRequestResponse = await f.app.inject({
          method,
          url: `/api/v1/sources/${source.id}/content`,
          headers: { authorization: `Bearer ${token.token}` },
        });
        assert.equal(response.statusCode, expected, `${capabilities} ${itemId} ${method}`);
      }
      const listing = await f.app.inject({
        url: '/api/v1/sources',
        headers: { authorization: `Bearer ${token.token}` },
      });
      assert.equal(listing.json().items.length, expected === 200 ? 1 : 0);
      assert.deepEqual(Object.keys(listing.json()), ['items']);
    }
  } finally {
    await f.dispose();
  }
});

test('revoked guest grant loses browse and sidebar access on the next request', async () => {
  const f = await libraryFixture();
  try {
    const item = f.item('Guest');
    f.asset(item.id, 'rom');
    const { issueToken } = await import('@ecs/auth');
    const token = issueToken();
    const grant = f.catalog.createGuestGrant({
      tokenHash: token.hash,
      libraryId: f.library.id,
      itemId: item.id,
      capabilities: ['read'],
      expiresAt: '2099-01-01T00:00:00Z',
      createdBy: f.owner.id,
    });
    const headers = { authorization: `Bearer ${token.token}` };
    const url = `/api/v1/browse?libraryId=${f.library.id}&category=games`;
    assert.equal((await f.app.inject({ url, headers })).json().items[0].id, item.id);
    assert.equal(
      (await f.app.inject({ url: '/api/v1/browse-libraries', headers })).json().items.length,
      1,
    );
    const revoked = await f.app.inject({
      method: 'DELETE',
      url: `/api/v1/guest-grants/${grant.id}`,
      headers: f.auth,
    });
    assert.equal(revoked.statusCode, 204);
    for (const route of [url, '/api/v1/browse-libraries'])
      assert.equal((await f.app.inject({ url: route, headers })).statusCode, 401);
  } finally {
    await f.dispose();
  }
});

test('item-scoped guests upload to their existing item but cannot create global items', async () => {
  const f = await libraryFixture();
  try {
    const item = f.item('Permitted');
    const { issueToken } = await import('@ecs/auth');
    const authFor = (itemId: string | null) => {
      const token = issueToken();
      f.catalog.createGuestGrant({
        tokenHash: token.hash,
        libraryId: f.library.id,
        itemId,
        capabilities: ['read', 'write'],
        expiresAt: '2099-01-01T00:00:00Z',
        createdBy: f.owner.id,
      });
      return { authorization: `Bearer ${token.token}` };
    };
    const scoped = authFor(item.id);
    const general = authFor(null);
    const payload = {
      libraryId: f.library.id,
      systemIdentifier: 'com.provenance.nes',
      title: 'New',
    };
    const denied = await f.app.inject({
      method: 'POST',
      url: '/api/v1/items',
      headers: scoped,
      payload,
    });
    assert.equal(denied.statusCode, 403, denied.body);
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/v1/items',
      headers: general,
      payload,
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(
      (await f.app.inject({ url: '/api/v1/browse-libraries', headers: scoped })).json().items[0]
        .canCreateItems,
      false,
    );
    assert.equal(
      (await f.app.inject({ url: '/api/v1/browse-libraries', headers: general })).json().items[0]
        .canCreateItems,
      true,
    );
    const opened = await f.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: scoped,
      payload: { libraryId: f.library.id },
    });
    assert.equal(opened.statusCode, 201, opened.body);
    const bytes = Buffer.from('generated');
    const uploadId = opened.json().id;
    const sent = await f.app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${uploadId}/content`,
      headers: {
        ...scoped,
        'content-type': 'application/octet-stream',
        'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}`,
      },
      payload: bytes,
    });
    assert.equal(sent.statusCode, 204, sent.body);
    const completed = await f.app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${uploadId}/complete`,
      headers: scoped,
      payload: {
        itemId: item.id,
        kind: 'rom',
        displayName: 'Generated',
        relativePath: 'generated.nes',
        baseRevision: 1,
      },
    });
    assert.equal(completed.statusCode, 201, completed.body);
    assert.equal(completed.json().itemId, item.id);
  } finally {
    await f.dispose();
  }
});
