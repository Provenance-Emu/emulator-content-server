import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

interface Change {
  cursor: number;
  entityType: string;
  entityId: string;
  op: string;
}

test('a device does not receive the changes it caused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-sync-'));
  const server = await openServer({ dataDir: dir });
  try {
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const owner = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
    });
    assert.equal(owner.statusCode, 201);
    const session = { authorization: `Bearer ${(owner.json() as { token: string }).token}` };

    const libraries = await server.app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      headers: session,
    });
    const libraryId = (libraries.json() as { items: Array<{ id: string }> }).items[0]?.id;
    assert.ok(libraryId);

    const devices = await Promise.all(
      ['handheld', 'console'].map(async (name) => {
        const issued = await server.app.inject({
          method: 'POST',
          url: '/api/v1/device-tokens',
          headers: session,
          payload: { name, scopes: ['read', 'write'] },
        });
        assert.equal(issued.statusCode, 201, issued.body);
        return {
          name,
          headers: { authorization: `Bearer ${(issued.json() as { token: string }).token}` },
        };
      }),
    );
    const handheld = devices[0];
    const console_ = devices[1];
    assert.ok(handheld && console_);

    const createdByHandheld = await server.app.inject({
      method: 'POST',
      url: '/api/v1/items',
      headers: handheld.headers,
      payload: { libraryId, systemIdentifier: 'com.provenance.nes', title: 'From handheld' },
    });
    assert.equal(createdByHandheld.statusCode, 201, createdByHandheld.body);
    const handheldItem = (createdByHandheld.json() as { id: string }).id;

    const createdByConsole = await server.app.inject({
      method: 'POST',
      url: '/api/v1/items',
      headers: console_.headers,
      payload: { libraryId, systemIdentifier: 'com.provenance.snes', title: 'From console' },
    });
    assert.equal(createdByConsole.statusCode, 201, createdByConsole.body);
    const consoleItem = (createdByConsole.json() as { id: string }).id;

    const feed = async (headers: Record<string, string>, excludeOwn: boolean) => {
      const query = excludeOwn ? '?cursor=0&excludeOwnDevice=1' : '?cursor=0';
      const response = await server.app.inject({
        method: 'GET',
        url: `/api/v1/changes${query}`,
        headers,
      });
      assert.equal(response.statusCode, 200);
      return (response.json() as { changes: Change[] }).changes;
    };

    const everything = await feed(handheld.headers, false);
    const bothItems = everything
      .filter((change) => change.entityType === 'item')
      .map((change) => change.entityId);
    assert.deepEqual(bothItems, [handheldItem, consoleItem]);

    const withoutOwn = await feed(handheld.headers, true);
    const remaining = withoutOwn
      .filter((change) => change.entityType === 'item')
      .map((change) => change.entityId);
    assert.deepEqual(remaining, [consoleItem], 'the handheld should not see its own write');
    assert.ok(
      withoutOwn.some((change) => change.entityType === 'library'),
      'a change with no device, such as bootstrap, stays visible to every device',
    );

    const consoleView = await feed(console_.headers, true);
    assert.deepEqual(
      consoleView.filter((change) => change.entityType === 'item').map((change) => change.entityId),
      [handheldItem],
    );

    const sessionView = await feed(session, true);
    assert.deepEqual(
      sessionView.filter((change) => change.entityType === 'item').map((change) => change.entityId),
      [handheldItem, consoleItem],
      'a session has no device, so asking to exclude its own changes removes nothing',
    );

    const deleted = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/items/${handheldItem}`,
      headers: handheld.headers,
    });
    assert.equal(deleted.statusCode, 204);
    const afterDelete = await feed(handheld.headers, true);
    assert.equal(
      afterDelete.some((change) => change.entityId === handheldItem),
      false,
      'a tombstone from this device is also its own echo',
    );
    const consoleAfterDelete = await feed(console_.headers, true);
    assert.ok(
      consoleAfterDelete.some(
        (change) => change.entityId === handheldItem && change.op === 'delete',
      ),
      'another device still learns about the delete',
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('two devices writing one save keep both, while a ROM still conflicts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-conflict-'));
  const server = await openServer({
    dataDir: dir,
    limits: { maxUploadBytes: 1024 * 1024, maxLibraryBytes: 8 * 1024 * 1024 },
  });
  try {
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const owner = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
    });
    const auth = { authorization: `Bearer ${(owner.json() as { token: string }).token}` };
    const libraries = await server.app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      headers: auth,
    });
    const libraryId = (libraries.json() as { items: Array<{ id: string }> }).items[0]?.id;
    assert.ok(libraryId);
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/items',
      headers: auth,
      payload: { libraryId, systemIdentifier: 'com.provenance.nes', title: 'Shared' },
    });
    const itemId = (created.json() as { id: string }).id;

    const upload = async (input: {
      kind: string;
      relativePath: string;
      baseRevision: number;
      body: Buffer;
    }) => {
      const opened = await server.app.inject({
        method: 'POST',
        url: '/api/v1/uploads',
        headers: auth,
        payload: { itemId, libraryId, size: input.body.length },
      });
      assert.equal(opened.statusCode, 201, opened.body);
      const uploadId = (opened.json() as { id: string }).id;
      const sent = await server.app.inject({
        method: 'PUT',
        url: `/api/v1/uploads/${uploadId}/content`,
        headers: {
          ...auth,
          'content-type': 'application/octet-stream',
          'content-range': `bytes 0-${input.body.length - 1}/${input.body.length}`,
        },
        payload: input.body,
      });
      assert.equal(sent.statusCode, 204, sent.body);
      return server.app.inject({
        method: 'POST',
        url: `/api/v1/uploads/${uploadId}/complete`,
        headers: auth,
        payload: {
          itemId,
          kind: input.kind,
          displayName: input.relativePath,
          relativePath: input.relativePath,
          baseRevision: input.baseRevision,
        },
      });
    };

    const handheldSave = Buffer.from('handheld save bytes padded out', 'utf8');
    const consoleSave = Buffer.from('console save bytes padded out!', 'utf8');

    const first = await upload({
      kind: 'battery_save',
      relativePath: 'battery.sav',
      baseRevision: 1,
      body: handheldSave,
    });
    assert.equal(first.statusCode, 201, first.body);
    const live = first.json() as { id: string; relativePath: string; conflictOf: string | null };
    assert.equal(live.relativePath, 'battery.sav');
    assert.equal(live.conflictOf, null);

    const second = await upload({
      kind: 'battery_save',
      relativePath: 'battery.sav',
      baseRevision: 1,
      body: consoleSave,
    });
    assert.equal(second.statusCode, 201, 'a stale save write is kept, not refused');
    const copy = second.json() as { id: string; relativePath: string; conflictOf: string | null };
    assert.equal(copy.conflictOf, live.id);
    assert.match(copy.relativePath, /^battery\.sav\.conflict-[0-9a-f]{8}$/);
    assert.notEqual(copy.id, live.id);

    for (const [asset, expected] of [
      [live, handheldSave],
      [copy, consoleSave],
    ] as const) {
      const content = await server.app.inject({
        method: 'GET',
        url: `/api/v1/files/${asset.id}/content`,
        headers: auth,
      });
      assert.equal(content.statusCode, 200);
      assert.deepEqual(content.rawPayload, expected, 'neither save is lost');
    }

    const manifest = await server.app.inject({
      method: 'GET',
      url: `/api/v1/items/${itemId}/manifest`,
      headers: auth,
    });
    const paths = (manifest.json() as { files: Array<{ relativePath: string }> }).files.map(
      (entry) => entry.relativePath,
    );
    assert.deepEqual(paths, ['battery.sav', copy.relativePath]);
    const pointed = (
      manifest.json() as { files: Array<{ id: string; conflictOf: string | null }> }
    ).files.find((entry) => entry.id === copy.id);
    assert.equal(
      pointed?.conflictOf,
      live.id,
      'the manifest names which save this one diverged from',
    );

    const current = await server.app.inject({
      method: 'GET',
      url: `/api/v1/items/${itemId}`,
      headers: auth,
    });
    const revision = (current.json() as { revision: number }).revision;
    const newer = Buffer.from('newer handheld save bytes!!', 'utf8');
    const third = await upload({
      kind: 'battery_save',
      relativePath: 'battery.sav',
      baseRevision: revision,
      body: newer,
    });
    assert.equal(third.statusCode, 201, third.body);
    const replaced = third.json() as {
      id: string;
      relativePath: string;
      conflictOf: string | null;
    };
    assert.equal(replaced.relativePath, 'battery.sav', 'a current save becomes the live file');
    assert.equal(replaced.conflictOf, null);
    const demoted = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${live.id}`,
      headers: auth,
    });
    const aside = demoted.json() as { relativePath: string; conflictOf: string | null };
    assert.equal(aside.conflictOf, replaced.id);
    assert.match(aside.relativePath, /^battery\.sav\.conflict-/);

    const adopted = await server.app.inject({
      method: 'POST',
      url: `/api/v1/files/${copy.id}/adopt`,
      headers: auth,
    });
    assert.equal(adopted.statusCode, 200, adopted.body);
    const chosen = adopted.json() as { relativePath: string; conflictOf: string | null };
    assert.equal(chosen.relativePath, 'battery.sav');
    assert.equal(chosen.conflictOf, null, 'choosing a copy makes it the live file');
    const parked = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${replaced.id}`,
      headers: auth,
    });
    const parkedBody = parked.json() as { relativePath: string; conflictOf: string | null };
    assert.equal(parkedBody.conflictOf, copy.id, 'the previous live save is kept');
    assert.match(parkedBody.relativePath, /^battery\.sav\.conflict-/);

    for (const [id, expected] of [
      [live.id, handheldSave],
      [copy.id, consoleSave],
      [replaced.id, newer],
    ] as const) {
      const content = await server.app.inject({
        method: 'GET',
        url: `/api/v1/files/${id}/content`,
        headers: auth,
      });
      assert.deepEqual(content.rawPayload, expected, 'choosing a save drops no bytes');
    }

    const staleRom = await upload({
      kind: 'rom',
      relativePath: 'game.nes',
      baseRevision: 1,
      body: Buffer.from('rom bytes that are long enough', 'utf8'),
    });
    assert.equal(staleRom.statusCode, 409, 'a ROM keeps strict optimistic concurrency');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
