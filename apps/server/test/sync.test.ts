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
