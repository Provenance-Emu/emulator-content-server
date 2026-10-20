import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { authorize, RateLimiter } from '@ecs/auth';
import { type Actor, DomainError } from '@ecs/domain';
import { VirtualProviderRegistry } from '@ecs/storage';
import Fastify from 'fastify';
import { assetDecision, itemDecision, sendProblem } from '../src/http.js';
import { type BrowseProbes, registerLibraryBrowse } from '../src/library-browse.js';
import { libraryFixture } from './library-fixture.js';

async function harness(probes?: BrowseProbes) {
  const f = await libraryFixture();
  let actor: Actor = f.actor;
  const app = Fastify();
  app.decorateRequest('actor', null);
  app.addHook('onRequest', async (request) => {
    request.actor = actor;
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) return sendProblem(reply, error, request);
    throw error;
  });
  registerLibraryBrowse(
    app,
    {
      catalog: f.catalog,
      dataDir: join(f.base, 'data'),
      displayName: 'test',
      webdavEnabled: false,
      localTrust: false,
      uiDir: null,
      limiter: new RateLimiter(100, 1000),
      virtual: new VirtualProviderRegistry([]),
    },
    probes,
  );
  const url = `/api/v1/browse?libraryId=${f.library.id}&category=games`;
  return {
    ...f,
    app,
    url,
    setActor(a: Actor) {
      actor = a;
    },
    async dispose() {
      await app.close();
      await f.dispose();
    },
  };
}

test('10,000 sources probe only the selected page and identical checks emit no refresh loop', async () => {
  let files = 0;
  let roots = 0;
  let running = 0;
  let max = 0;
  let online = true;
  const paths: string[] = [];
  const f = await harness({
    root: async () => {
      roots++;
      return { online, medium: 'internal' };
    },
    file: async (path) => {
      files++;
      paths.push(path);
      running++;
      max = Math.max(max, running);
      await new Promise((resolve) => setImmediate(resolve));
      running--;
      return { availability: 'local', size: 1, blocks: 1 };
    },
  });
  try {
    const path = join(f.base, 'source-root');
    await mkdir(path);
    const root = f.catalog.createContentRoot({
      path,
      label: 'Root',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    f.catalog.applyInspection({
      rootId: root.id,
      actorId: f.owner.id,
      online: true,
      files: Array.from({ length: 10000 }, (_, i) => ({
        relativePath: `${i}`,
        displayName: `${i.toString().padStart(5, '0')}`,
        kind: 'rom',
        systemId: null,
        size: 1,
        blocks: 1,
        availability: 'local',
      })),
    });
    const events = () =>
      f.catalog.changes({
        after: 0,
        limit: 20000,
        libraryIds: [f.library.id],
        includeSensitive: true,
        itemId: null,
      }).changes;
    const first = await f.app.inject({ url: f.url });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().items.length, 50);
    assert.equal(files, 50);
    assert.equal(roots, 1);
    assert.ok(max <= 4);
    assert.equal(new Set(paths).size, 50);
    const returnedPaths = new Set(
      first
        .json()
        .items.map((entry: { id: string }) =>
          join(path, f.catalog.getSource(entry.id)?.relativePath ?? 'missing'),
        ),
    );
    assert.ok(
      paths.every((path) => returnedPaths.has(path)),
      'no off-page sources are probed',
    );
    assert.equal(first.body.includes(path), false);
    assert.ok(
      first
        .json()
        .items.every(
          (e: { source: { contentPath: string }; canUpload: boolean }) =>
            e.source.contentPath.startsWith('/api/v1/sources/') && !e.canUpload,
        ),
    );
    const firstEvents = events().length;
    const second = await f.app.inject({ url: f.url });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(
      events().length,
      firstEvents,
      'unchanged probes must not trigger changefeed refreshes',
    );
    files = 0;
    roots = 0;
    const beforeSummary = events().length;
    const summary = await f.app.inject({ url: '/api/v1/root-summaries' });
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.json().items[0].indexedFileCount, 10000);
    assert.equal(files, 0);
    assert.equal(roots, 0);
    assert.equal(events().length, beforeSummary);
    online = false;
    const beforeOffline = events().length;
    const offline = await f.app.inject({ url: f.url });
    assert.equal(offline.statusCode, 200);
    assert.equal(files, 0);
    assert.equal(roots, 1);
    assert.ok(events().length - beforeOffline <= 51);
    assert.equal(
      f.catalog.listSources(root.id).filter((s) => s.availability === 'offline').length,
      50,
    );
    await writeFile(join(f.base, 'outside'), 'generated');
    await symlink(join(f.base, 'outside'), join(path, '0'));
    online = true;
    files = 0;
    await f.app.inject({ url: f.url });
    assert.equal(files, 49, 'escaped symlink is never probed');
  } finally {
    await f.dispose();
  }
});

test('browse SQL matches auth decisions, item ACL discovery, flags and revocation', async () => {
  const f = await harness();
  try {
    const a = f.item('A');
    const b = f.item('B');
    f.asset(a.id, 'rom');
    const art = f.asset(a.id, 'artwork', false);
    const save = f.asset(a.id, 'battery_save', false);
    f.asset(b.id, 'rom');
    f.asset(b.id, 'bios');
    const user = f.catalog.createUser({
      username: 'reader',
      passwordHash: 'fixture',
      actorId: f.owner.id,
    });
    const member: Actor = { ...f.actor, userId: user.id, username: 'reader', isOwner: false };
    f.setActor(member);
    assert.equal((await f.app.inject({ url: f.url })).statusCode, 404);
    f.catalog.setItemPermission(a.id, user.id, 'read', f.owner.id);
    let libraries = await f.app.inject({ url: '/api/v1/browse-libraries' });
    assert.deepEqual(
      libraries.json().items.map((l: { id: string }) => l.id),
      [f.library.id],
    );
    assert.equal(libraries.json().items[0].canCreateItems, false);
    let page = await f.app.inject({ url: f.url });
    assert.equal(page.statusCode, 200, page.body);
    assert.deepEqual(
      page.json().items.map((e: { id: string }) => e.id),
      [a.id],
    );
    assert.equal(page.json().items[0].canUpload, false);
    assert.equal(page.json().items[0].previewAsset.id, art.id);
    assert.doesNotThrow(() => itemDecision(f.catalog, member, a, 'read'));
    assert.throws(() => itemDecision(f.catalog, member, b, 'read'));
    f.catalog.removeItemPermission(a.id, user.id, f.owner.id);
    assert.equal((await f.app.inject({ url: f.url })).statusCode, 404);
    f.catalog.setMember(f.library.id, user.id, 'reader', f.owner.id);
    page = await f.app.inject({ url: f.url });
    assert.equal(page.json().items.length, 2);
    assert.ok(page.json().items.every((e: { canUpload: boolean }) => !e.canUpload));
    f.catalog.setMember(f.library.id, user.id, 'editor', f.owner.id);
    assert.equal((await f.app.inject({ url: f.url })).json().items[0].canUpload, true);
    libraries = await f.app.inject({ url: '/api/v1/browse-libraries' });
    assert.equal(libraries.json().items[0].canCreateItems, true);
    for (const capabilities of [
      ['read'],
      ['read', 'share_restricted'],
      ['read', 'write'],
      ['write'],
    ] as const) {
      const guest: Actor = {
        kind: 'guest',
        grantId: 'fixture',
        libraryId: f.library.id,
        itemId: a.id,
        capabilities: [...capabilities],
      };
      f.setActor(guest);
      page = await f.app.inject({ url: f.url });
      if (!capabilities.includes('read' as never)) {
        assert.equal(page.statusCode, 403);
        continue;
      }
      assert.equal(page.statusCode, 200, page.body);
      assert.deepEqual(
        page.json().items.map((e: { id: string }) => e.id),
        [a.id],
      );
      assert.equal(page.json().items[0].canUpload, capabilities.includes('write' as never));
      assert.equal(
        !!page.json().items[0].previewAsset,
        capabilities.includes('share_restricted' as never),
      );
      const allowed = authorize({
        actor: guest,
        action: 'read',
        libraryId: f.library.id,
        itemId: a.id,
        assetKind: 'battery_save',
        shareable: false,
      });
      if (allowed) assert.doesNotThrow(() => assetDecision(f.catalog, guest, a, save, 'read'));
      else assert.throws(() => assetDecision(f.catalog, guest, a, save, 'read'));
      const saves = await f.app.inject({ url: f.url.replace('games', 'saves') });
      assert.equal(saves.json().items.length, allowed ? 1 : 0);
      assert.equal(
        (await f.app.inject({ url: '/api/v1/browse-libraries' })).json().items[0].canCreateItems,
        false,
      );
    }
    for (const denied of [
      member,
      { ...f.actor, localTrust: true, scopes: ['read', 'write', 'admin'] } as Actor,
      { ...f.actor, scopes: ['write'] } as Actor,
    ]) {
      f.setActor(denied);
      for (const req of [
        { url: '/api/v1/root-summaries' },
        {
          method: 'PATCH' as const,
          url: `/api/v1/libraries/${f.library.id}`,
          payload: { name: 'No' },
          headers: { 'if-match': '"rev-1"' },
        },
        {
          method: 'PUT' as const,
          url: '/api/v1/roots/missing/library',
          payload: { libraryId: f.library.id },
        },
        { url: '/api/v1/browse?unassigned=true&category=games' },
      ])
        assert.equal((await f.app.inject(req)).statusCode, 403);
    }
    f.setActor({ ...f.actor, localTrust: true, scopes: ['read'] });
    assert.equal((await f.app.inject({ url: f.url })).json().items.length, 2);
    assert.equal((await f.app.inject({ url: f.url })).json().items[0].canUpload, false);
  } finally {
    await f.dispose();
  }
});

test('guest library sources obey category, item scope and restricted-kind policy before paging', async () => {
  const f = await harness();
  try {
    const root = f.catalog.createContentRoot({
      path: f.base,
      label: 'Sources',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    f.catalog.applyInspection({
      rootId: root.id,
      actorId: f.owner.id,
      online: true,
      files: [
        'rom',
        'battery_save',
        'save_state',
        'artwork',
        'screenshot',
        'bios',
        'system_file',
      ].map((kind, i) => ({
        relativePath: `generated-${i}`,
        displayName: `Source ${i}`,
        kind,
        systemId: null,
        size: 1,
        blocks: 1,
        availability: 'local',
      })),
    });
    const item = f.item('Target');
    for (const [capabilities, itemId, counts] of [
      [['read'], null, [1, 2, 2, 0]],
      [['read', 'share_restricted'], null, [1, 2, 2, 2]],
      [['read'], item.id, [1, 0, 0, 0]],
    ] as const) {
      const actor: Actor = {
        kind: 'guest',
        grantId: 'fixture',
        libraryId: f.library.id,
        itemId,
        capabilities: [...capabilities],
      };
      f.setActor(actor);
      for (const [i, category] of ['games', 'saves', 'media', 'system_files'].entries()) {
        const response = await f.app.inject({
          url: `/api/v1/browse?libraryId=${f.library.id}&category=${category}&systemId=unknown&limit=1`,
        });
        assert.equal(response.statusCode, 200, response.body);
        let count = response.json().items.length;
        let cursor = response.json().nextCursor;
        while (cursor) {
          const next = await f.app.inject({
            url: `/api/v1/browse?libraryId=${f.library.id}&category=${category}&systemId=unknown&limit=1&cursor=${cursor}`,
          });
          assert.equal(next.statusCode, 200, next.body);
          count += next.json().items.length;
          cursor = next.json().nextCursor;
        }
        // Managed Target has a known system, so the unknown filter excludes it.
        assert.equal(count, itemId ? 0 : counts[i]);
        for (const entry of response.json().items) {
          assert.equal(entry.entityType, 'source');
          assert.equal(entry.canUpload, false);
          assert.equal(entry.canAdopt, false);
          assert.equal(
            authorize({
              actor,
              action: 'read',
              libraryId: f.library.id,
              assetKind: entry.source.kind,
            }),
            true,
          );
        }
      }
    }
  } finally {
    await f.dispose();
  }
});

test('actor changes and vanished anchors cannot reuse browse cursors', async () => {
  const f = await harness();
  try {
    f.item('A');
    f.item('B');
    const url = `${f.url}&limit=1`;
    const first = await f.app.inject({ url });
    const cursor = first.json().nextCursor;
    assert.ok(cursor);
    const member = f.catalog.createUser({
      username: 'other',
      passwordHash: 'fixture',
      actorId: f.owner.id,
    });
    f.catalog.setMember(f.library.id, member.id, 'reader', f.owner.id);
    f.setActor({ ...f.actor, userId: member.id, username: 'other', isOwner: false });
    assert.equal((await f.app.inject({ url: `${url}&cursor=${cursor}` })).statusCode, 400);
    f.setActor(f.actor);
    f.catalog.deleteItem(first.json().items[0].id, f.owner.id);
    assert.equal((await f.app.inject({ url: `${url}&cursor=${cursor}` })).statusCode, 400);
  } finally {
    await f.dispose();
  }
});

test('generated browse envelopes are accepted by the client for all three payload types', async () => {
  const f = await harness();
  const original = globalThis.fetch;
  try {
    const { ContentClient } = await import('@ecs/client');
    const item = f.item('Game');
    f.asset(item.id, 'rom');
    f.asset(item.id, 'artwork');
    f.asset(item.id, 'battery_save');
    const root = f.catalog.createContentRoot({
      path: f.base,
      label: 'Root',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    f.catalog.applyInspection({
      rootId: root.id,
      actorId: f.owner.id,
      online: true,
      files: [
        {
          relativePath: 'generated',
          displayName: 'Source',
          kind: 'rom',
          systemId: null,
          size: 1,
          blocks: 1,
          availability: 'local',
        },
      ],
    });
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const response = await f.app.inject({ url: url.pathname + url.search });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new ContentClient('http://test');
    const games = await client.browse({ libraryId: f.library.id, category: 'games' });
    assert.deepEqual(new Set(games.items.map((e) => e.entityType)), new Set(['item', 'source']));
    assert.equal(games.items.find((e) => e.entityType === 'item')?.previewAsset?.kind, 'artwork');
    const saves = await client.browse({ libraryId: f.library.id, category: 'saves' });
    assert.equal(saves.items[0]?.asset?.kind, 'battery_save');
    assert.equal(saves.items[0]?.parentItem?.id, item.id);
  } finally {
    globalThis.fetch = original;
    await f.dispose();
  }
});

test('save conflict adoption flags follow current asset write authorization', async () => {
  const f = await harness();
  try {
    const item = f.item('Saves');
    const save = f.asset(item.id, 'battery_save', false);
    const conflict = f.catalog.completeUpload({
      ...save,
      uploadId: f.catalog.createUpload({
        userId: f.owner.id,
        guestGrantId: null,
        libraryId: f.library.id,
      }).id,
      baseRevision: 1,
      sha256: 'c'.repeat(64),
      md5: 'b'.repeat(32),
      crc: '12345678',
      actorId: f.owner.id,
      locationId: null,
    });
    assert.ok(conflict.conflictOf);
    const member = f.catalog.createUser({
      username: 'member',
      passwordHash: 'fixture',
      actorId: f.owner.id,
    });
    f.catalog.setMember(f.library.id, member.id, 'reader', f.owner.id);
    const reader: Actor = { ...f.actor, userId: member.id, isOwner: false };
    f.setActor(reader);
    const url = f.url.replace('games', 'saves');
    let page = await f.app.inject({ url });
    assert.equal(page.statusCode, 200, page.body);
    assert.equal(
      page.json().items.find((e: { id: string }) => e.id === conflict.id).canAdopt,
      false,
    );
    assert.throws(() => assetDecision(f.catalog, reader, item, conflict, 'write'));
    f.catalog.setMember(f.library.id, member.id, 'editor', f.owner.id);
    page = await f.app.inject({ url });
    assert.equal(
      page.json().items.find((e: { id: string }) => e.id === conflict.id).canAdopt,
      true,
    );
    assert.doesNotThrow(() => assetDecision(f.catalog, reader, item, conflict, 'write'));
    const guest: Actor = {
      kind: 'guest',
      grantId: 'test',
      libraryId: f.library.id,
      itemId: item.id,
      capabilities: ['read', 'write', 'share_restricted'],
    };
    f.setActor(guest);
    page = await f.app.inject({ url });
    assert.equal(
      page.json().items.find((e: { id: string }) => e.id === conflict.id).canAdopt,
      true,
    );
    f.setActor({ ...guest, capabilities: ['read', 'share_restricted'] });
    page = await f.app.inject({ url });
    assert.equal(
      page.json().items.find((e: { id: string }) => e.id === conflict.id).canAdopt,
      false,
    );
  } finally {
    await f.dispose();
  }
});

test('unavailable or replaced roots retain cached media without probing replacement paths', async () => {
  let rootProbes = 0;
  let fileProbes = 0;
  const f = await harness({
    root: async () => {
      rootProbes++;
      return { online: true, medium: 'internal' };
    },
    file: async () => {
      fileProbes++;
      return { availability: 'local', size: 1, blocks: 1 };
    },
  });
  try {
    const { rm } = await import('node:fs/promises');
    for (const medium of ['removable', 'network', null] as const) {
      const path = join(f.base, medium ?? 'unknown');
      await mkdir(path);
      const root = f.catalog.createContentRoot({
        path,
        label: medium ?? 'unknown',
        libraryId: f.library.id,
        actorId: f.owner.id,
      });
      f.catalog.applyInspection({
        rootId: root.id,
        actorId: f.owner.id,
        online: true,
        files: [
          {
            relativePath: 'generated',
            displayName: 'Generated',
            kind: 'rom',
            systemId: null,
            size: 1,
            blocks: 1,
            availability: 'local',
          },
        ],
      });
      if (medium) f.catalog.recordRootCheck({ rootId: root.id, availability: 'online', medium });
      await rm(path, { recursive: true });
      const url = `${f.url}&rootId=${root.id}`;
      const missing = await f.app.inject({ url });
      assert.equal(missing.statusCode, 200, missing.body);
      assert.equal(missing.json().items[0].source.medium, medium ?? 'unknown');
      assert.equal(missing.json().items[0].source.availability, 'offline');
      let summary = f.catalog
        .listContentRootSummaries({ actor: f.actor })
        .find((row) => row.id === root.id);
      assert.equal(summary?.medium, medium);
      assert.equal(summary?.availability, 'offline');
      const before = f.catalog.changes({
        after: 0,
        limit: 100,
        libraryIds: [f.library.id],
        includeSensitive: true,
        itemId: null,
      }).nextCursor;
      await symlink(f.base, path);
      const replaced = await f.app.inject({ url });
      assert.equal(replaced.statusCode, 200, replaced.body);
      assert.equal(replaced.json().items[0].source.medium, medium ?? 'unknown');
      summary = f.catalog
        .listContentRootSummaries({ actor: f.actor })
        .find((row) => row.id === root.id);
      assert.equal(summary?.medium, medium);
      assert.equal(
        f.catalog.changes({
          after: before,
          limit: 100,
          libraryIds: [f.library.id],
          includeSensitive: true,
          itemId: null,
        }).changes.length,
        0,
      );
    }
    assert.equal(rootProbes, 0);
    assert.equal(fileProbes, 0);
  } finally {
    await f.dispose();
  }
});
