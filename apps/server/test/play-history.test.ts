import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { libraryFixture } from './library-fixture.js';

test('plays are recorded per account and listed most recent first through browse', async () => {
  const f = await libraryFixture();
  try {
    const [first, second, third] = ['First', 'Second', 'Third'].map((title) => f.item(title));
    assert.ok(first && second && third);
    const path = join(f.base, 'shelf');
    await mkdir(path);
    await writeFile(join(path, 'generated.nes'), 'generated');
    const root = f.catalog.createContentRoot({
      path,
      label: 'shelf',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
    const source = f.catalog.listSources(root.id)[0];
    assert.ok(source);
    const play = (payload: object, headers: Record<string, string> = f.auth) =>
      f.app.inject({ method: 'POST', url: '/api/v1/plays', headers, payload });
    const recent = `/api/v1/browse?libraryId=${f.library.id}&category=games&played=recent`;
    const listed = async (headers: Record<string, string> = f.auth) => {
      const response = await f.app.inject({ url: recent, headers });
      assert.equal(response.statusCode, 200, response.body);
      return response.json() as {
        items: { entityType: string; id: string; lastPlayedAt?: string }[];
        nextCursor: string | null;
      };
    };

    assert.deepEqual((await listed()).items, [], 'nothing is listed before anything is played');
    assert.equal((await play({ itemId: first.id })).statusCode, 204);
    assert.equal((await play({ sourceId: source.id })).statusCode, 204);
    // Set times apart so the order does not depend on the clock's resolution.
    assert.ok(
      f.catalog.recordPlay(
        f.actor,
        { entityType: 'item', id: first.id },
        '2030-01-01T00:00:00.000Z',
      ),
    );
    assert.ok(
      f.catalog.recordPlay(
        f.actor,
        { entityType: 'source', id: source.id },
        '2030-01-02T00:00:00.000Z',
      ),
    );
    assert.ok(
      f.catalog.recordPlay(
        f.actor,
        { entityType: 'item', id: second.id },
        '2030-01-03T00:00:00.000Z',
      ),
    );
    let page = await listed();
    assert.deepEqual(
      page.items.map((entry) => [entry.entityType, entry.id, entry.lastPlayedAt]),
      [
        ['item', second.id, '2030-01-03T00:00:00.000Z'],
        ['source', source.id, '2030-01-02T00:00:00.000Z'],
        ['item', first.id, '2030-01-01T00:00:00.000Z'],
      ],
    );
    assert.equal(page.nextCursor, null);

    // Playing again moves a game to the front; an older report never moves it back.
    assert.ok(
      f.catalog.recordPlay(
        f.actor,
        { entityType: 'item', id: first.id },
        '2030-01-04T00:00:00.000Z',
      ),
    );
    assert.ok(
      f.catalog.recordPlay(
        f.actor,
        { entityType: 'item', id: first.id },
        '2029-01-01T00:00:00.000Z',
      ),
    );
    page = await listed();
    assert.deepEqual(
      page.items.map((entry) => entry.id),
      [first.id, second.id, source.id],
    );
    assert.equal(page.items[0]?.lastPlayedAt, '2030-01-04T00:00:00.000Z');
    assert.equal(
      (await f.app.inject({ url: `${recent}&limit=2`, headers: f.auth })).json().items.length,
      2,
    );

    // A file that becomes part of a game is listed as that game, with the file's play.
    f.catalog.linkGameSource(source.id, third.id, f.owner.id);
    page = await listed();
    assert.deepEqual(
      page.items.map((entry) => [entry.entityType, entry.id]),
      [
        ['item', first.id],
        ['item', second.id],
        ['item', third.id],
      ],
    );
    assert.equal((await play({ sourceId: source.id })).statusCode, 204);
    assert.ok(
      f.catalog.recordPlay(
        f.actor,
        { entityType: 'source', id: source.id },
        '2030-01-05T00:00:00.000Z',
      ),
    );
    page = await listed();
    assert.deepEqual([page.items[0]?.id, page.items.length], [third.id, 3]);

    // The ordinary page is unchanged and carries no play times.
    const plain = await f.app.inject({
      url: `/api/v1/browse?libraryId=${f.library.id}&category=games`,
      headers: f.auth,
    });
    assert.equal(plain.json().items.length, 3);
    assert.equal(JSON.stringify(plain.json()).includes('lastPlayedAt'), false);

    for (const payload of [
      {},
      { itemId: first.id, sourceId: source.id },
      { itemId: '' },
      { itemId: 7 },
    ])
      assert.equal((await play(payload)).statusCode, 400, JSON.stringify(payload));
    assert.equal((await play({ itemId: 'missing' })).statusCode, 404);
    assert.equal((await play({ sourceId: 'missing' })).statusCode, 404);
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/plays',
          payload: { itemId: first.id },
          remoteAddress: '8.8.8.8',
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await f.app.inject({ url: recent.replace('games', 'saves'), headers: f.auth })).statusCode,
      400,
    );
    assert.equal(
      (await f.app.inject({ url: `${recent}&cursor=x`, headers: f.auth })).statusCode,
      400,
    );
    assert.equal(
      (await f.app.inject({ url: `${recent.replace('recent', 'all')}`, headers: f.auth }))
        .statusCode,
      400,
    );
  } finally {
    await f.dispose();
  }
});

test("another account, and a guest link, neither see nor add to an account's plays", async () => {
  const f = await libraryFixture();
  try {
    const game = f.item('Shared');
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/plays',
          headers: f.auth,
          payload: { itemId: game.id },
        })
      ).statusCode,
      204,
    );
    const added = await f.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: f.auth,
      payload: { username: 'player', password: 'battery-staple' },
    });
    assert.equal(added.statusCode, 201, added.body);
    const signedIn = await f.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'player', password: 'battery-staple' },
    });
    const player = { authorization: `Bearer ${signedIn.json().token}` };
    const recent = `/api/v1/browse?libraryId=${f.library.id}&category=games&played=recent`;
    // Not a member: the game cannot be named, and the answer is the same as for a missing one.
    const refused = await f.app.inject({
      method: 'POST',
      url: '/api/v1/plays',
      headers: player,
      payload: { itemId: game.id },
    });
    assert.equal(refused.statusCode, 404);
    assert.equal((await f.app.inject({ url: recent, headers: player })).statusCode, 404);
    assert.equal(
      f.catalog.recordPlay(
        {
          ...f.actor,
          userId: (added.json() as { id: string }).id,
          isOwner: false,
          username: 'player',
        },
        { entityType: 'item', id: game.id },
      ),
      false,
    );

    const token = issueToken();
    f.catalog.createGuestGrant({
      tokenHash: token.hash,
      libraryId: f.library.id,
      itemId: null,
      capabilities: ['read'],
      expiresAt: '2099-01-01T00:00:00Z',
      createdBy: f.owner.id,
    });
    const guest = { authorization: `Bearer ${token.token}` };
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/v1/plays',
          headers: guest,
          payload: { itemId: game.id },
        })
      ).statusCode,
      403,
    );
    const guestPage = await f.app.inject({ url: recent, headers: guest });
    assert.equal(guestPage.statusCode, 200, guestPage.body);
    assert.deepEqual(guestPage.json().items, [], 'a guest sees no account history');

    const owner = await f.app.inject({ url: recent, headers: f.auth });
    assert.deepEqual(
      owner.json().items.map((entry: { id: string }) => entry.id),
      [game.id],
    );
    const capabilities = await f.app.inject({ url: '/api/v1/capabilities', headers: f.auth });
    assert.equal(capabilities.json().features.playHistory, true);
  } finally {
    await f.dispose();
  }
});
