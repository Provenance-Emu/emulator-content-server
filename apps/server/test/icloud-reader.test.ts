import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { blobPath } from '@ecs/storage';
import { libraryFixture } from './library-fixture.js';

// Windows offers no key, so it has no local reader.
const skip = process.platform === 'win32';
const GAME = 'A'.repeat(32);
const ABSENT = 'C'.repeat(32);

interface Described {
  recordName: string;
  changeTag: string;
  gameId: string;
  filename: string;
  systemIdentifier: string | null;
  coreIdentifier: string | null;
  size: number;
  device: string | null;
  modifiedAt: string | null;
}

function described(gameId: string, filename: string, changeTag = 'tag1'): Described {
  return {
    recordName: `savestate_${gameId}_${filename.replaceAll('.', '_')}`,
    changeTag,
    gameId,
    filename,
    systemIdentifier: 'com.provenance.nes',
    coreIdentifier: 'com.provenance.core.fceux',
    size: 20,
    device: 'GENERATED-DEVICE',
    modifiedAt: '2026-03-03T10:00:00.000Z',
  };
}

const bytesOf = (save: Described) => `bytes of ${save.recordName} at ${save.changeTag}`;

async function fixture(options: { readerSilentMs?: number } = {}) {
  const f = await libraryFixture({
    icloud: {
      apiToken: 'generated-api-token',
      fetch: async () => ({ status: 500, json: async () => ({}) }),
      readerWaitMs: 40,
      ...options,
    },
  });
  await f.offerLocalOwnerSignIn();
  const key = (await readFile(join(f.base, 'data', 'local-owner.key'), 'utf8')).trim();
  const owner = (method: 'GET' | 'POST', path: string, payload?: object) =>
    f.app.inject({
      method,
      url: `/api/v1/icloud${path}`,
      headers: f.auth,
      ...(payload ? { payload } : {}),
    });
  const attach = (candidate: unknown = key, remoteAddress?: string) =>
    f.app.inject({
      method: 'POST',
      url: '/api/v1/icloud/reader/attach',
      payload: { key: candidate },
      ...(remoteAddress ? { remoteAddress } : {}),
    });
  const reader = (
    ticket: string,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    payload?: object | Buffer,
    remoteAddress?: string,
  ) =>
    f.app.inject({
      method,
      url: `/api/v1/icloud/reader${path}`,
      headers: {
        authorization: `Bearer ${ticket}`,
        ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}),
      },
      ...(payload ? { payload } : {}),
      ...(remoteAddress ? { remoteAddress } : {}),
    });
  const finished = async () => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const state = (await owner('GET', '')).json().import;
      if (state && state.state !== 'running') return state;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('The import did not finish');
  };
  /**
   * Stands in for the helper on the Mac: asks for work and answers it from `saves` until told to
   * stop. `refuse` names records it reports as unreadable.
   */
  function helper(ticket: string, saves: () => Described[], refuse: string[] = []) {
    let on = true;
    const asked: string[] = [];
    const done = (async () => {
      await reader(ticket, 'PUT', '/account', { state: 'available' });
      while (on) {
        const answer = await reader(ticket, 'GET', '/work');
        if (answer.statusCode !== 200) break;
        const work = answer.json();
        asked.push(work.work);
        if (work.work === 'list') {
          const all = saves();
          const first = all.slice(0, 2);
          await reader(ticket, 'POST', '/listing', { saves: first, done: all.length <= 2 });
          if (all.length > 2)
            await reader(ticket, 'POST', '/listing', { saves: all.slice(2), done: true });
        }
        for (const wanted of work.saves ?? []) {
          const save = saves().find((entry) => entry.recordName === wanted.recordName);
          if (!save || refuse.includes(save.recordName))
            await reader(ticket, 'POST', `/saves/${wanted.requestId}/failed`, {
              reason: 'missing',
            });
          else
            await reader(ticket, 'PUT', `/saves/${wanted.requestId}`, Buffer.from(bytesOf(save)));
        }
      }
    })();
    return {
      asked,
      async stop() {
        on = false;
        await done;
      },
    };
  }
  const game = () =>
    f.catalog.createItem({
      libraryId: f.library.id,
      title: 'Uploaded',
      systemIdentifier: 'com.provenance.nes',
      md5: GAME.toLowerCase(),
      crc: null,
      actorId: f.owner.id,
    });
  return { f, key, owner, attach, reader, finished, helper, game };
}

test('a reader ticket comes from the local key on this computer and opens nothing else', {
  skip,
}, async () => {
  const { f, owner, attach, reader } = await fixture();
  try {
    const before = (await owner('GET', '')).json().reader;
    assert.deepEqual(before, { offered: true, state: 'absent', lastSeenAt: null });

    assert.equal((await attach('x'.repeat(43))).statusCode, 401);
    assert.equal((await attach(undefined, '192.168.1.20')).statusCode, 403);
    const attached = await attach();
    assert.equal(attached.statusCode, 200, attached.body);
    const { ticket } = attached.json();
    assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);

    // The ticket is not a session.
    for (const url of ['/api/v1/icloud', '/api/v1/libraries', '/api/v1/users'])
      assert.equal(
        (await f.app.inject({ url, headers: { authorization: `Bearer ${ticket}` } })).statusCode,
        401,
        url,
      );
    // The reader operations take nothing but the ticket, and only from this computer.
    assert.equal((await f.app.inject({ url: '/api/v1/icloud/reader/work' })).statusCode, 401);
    assert.equal(
      (await f.app.inject({ url: '/api/v1/icloud/reader/work', headers: f.auth })).statusCode,
      401,
      'an owner session is not a ticket',
    );
    assert.equal((await reader(ticket, 'GET', '/work', undefined, '192.168.1.20')).statusCode, 403);
    assert.equal((await reader(ticket, 'GET', '/work')).json().work, 'none');

    assert.equal((await reader(ticket, 'PUT', '/account', { state: 'nonsense' })).statusCode, 400);
    await reader(ticket, 'PUT', '/account', { state: 'signedOut' });
    assert.equal((await owner('GET', '')).json().reader.state, 'signedOut');
    await reader(ticket, 'PUT', '/account', { state: 'available' });
    const status = (await owner('GET', '')).json();
    assert.equal(status.reader.state, 'ready');
    assert.ok(!JSON.stringify(status).includes(ticket), 'no ticket in an answer');

    // Nothing was asked for, so nothing is taken.
    assert.equal(
      (await reader(ticket, 'POST', '/listing', { saves: [], done: true })).statusCode,
      409,
    );
    assert.equal(
      (await reader(ticket, 'PUT', '/saves/not-asked-for', Buffer.from('generated'))).statusCode,
      404,
    );

    for (const [method, path] of [
      ['PUT', '/account'],
      ['POST', '/listing'],
      ['POST', '/listing/failed'],
      ['PUT', '/saves/any'],
      ['POST', '/saves/any/failed'],
    ] as const)
      assert.equal(
        (await reader(ticket, method, path, { state: 'available' }, '192.168.1.20')).statusCode,
        403,
        path,
      );

    // A second attach replaces the first.
    const next = (await attach()).json().ticket;
    assert.equal((await reader(ticket, 'GET', '/work')).statusCode, 401);
    assert.equal((await reader(next, 'GET', '/work')).statusCode, 200);
  } finally {
    await f.dispose();
  }
});

test('saves read on the Mac are previewed and added beside what is there', { skip }, async () => {
  const { f, owner, attach, finished, helper, game } = await fixture();
  let saves = [
    described(GAME, 'one.svs'),
    described(GAME, 'two.svs'),
    described(ABSENT, 'absent.svs'),
  ];
  const { ticket } = (await attach()).json();
  const mac = helper(ticket, () => saves);
  try {
    const made = game();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const preview = await owner('POST', '/preview');
    assert.equal(preview.statusCode, 200, preview.body);
    const counted = preview.json();
    assert.equal(counted.source, 'mac');
    assert.deepEqual(
      [counted.saves, counted.games, counted.gamesHere, counted.ready, counted.bytes],
      [3, 2, 1, 2, 60],
    );
    assert.equal(f.catalog.manifest(made.id)?.files.length, 0, 'a preview copies nothing');

    assert.equal((await owner('POST', '/import')).statusCode, 202);
    const first = await finished();
    assert.deepEqual(
      [first.state, first.source, first.total, first.imported, first.skipped, first.failed],
      ['completed', 'mac', 3, 2, 1, 0],
    );
    const files = f.catalog.manifest(made.id)?.files ?? [];
    assert.deepEqual(files.map((file) => file.relativePath).sort(), [
      'icloud/com.provenance.core.fceux/one.svs',
      'icloud/com.provenance.core.fceux/two.svs',
    ]);
    const one = files.find((file) => file.relativePath.endsWith('one.svs'));
    assert.ok(one);
    assert.equal(
      await readFile(blobPath(join(f.base, 'data'), one.sha256), 'utf8'),
      bytesOf(saves[0] as Described),
    );

    // The same records again copy nothing: the ledger is the one the Apple sign-in uses.
    await owner('POST', '/import');
    const second = await finished();
    assert.deepEqual([second.imported, second.skipped], [0, 3]);

    // A record that changed lands beside the save already here and replaces nothing.
    saves = [described(GAME, 'one.svs', 'tag2'), ...saves.slice(1)];
    await owner('POST', '/import');
    assert.equal((await finished()).imported, 1);
    const after = f.catalog.manifest(made.id)?.files ?? [];
    assert.equal(after.length, 3);
    assert.equal(after.filter((file) => file.conflictOf === one.id).length, 1);
    assert.ok(mac.asked.every((work) => ['none', 'list', 'fetch'].includes(work)));
  } finally {
    await mac.stop();
    await f.dispose();
  }
});

test('a save the Mac cannot read is counted, and a wrongly described one is refused', {
  skip,
}, async () => {
  const { f, owner, attach, reader, finished, helper, game } = await fixture();
  const saves = [described(GAME, 'one.svs'), described(GAME, 'two.svs')];
  const { ticket } = (await attach()).json();
  const mac = helper(ticket, () => saves, [(saves[1] as Described).recordName]);
  try {
    const made = game();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await owner('POST', '/import');
    const done = await finished();
    assert.deepEqual([done.state, done.imported, done.failed], ['completed', 1, 1]);
    assert.equal(f.catalog.manifest(made.id)?.files.length, 1);
    await mac.stop();

    // With the helper gone, a hand-made listing shows what the server will not take.
    const asking = owner('POST', '/preview', { source: 'mac' });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await reader(ticket, 'GET', '/work')).json().work === 'list') break;
    }
    const wrong = { ...described(GAME, 'three.svs'), size: -1 };
    assert.equal(
      (await reader(ticket, 'POST', '/listing', { saves: [wrong], done: true })).statusCode,
      400,
    );
    const huge = { ...described(GAME, 'three.svs'), size: 2 ** 40 };
    assert.equal(
      (await reader(ticket, 'POST', '/listing', { saves: [huge], done: true })).statusCode,
      400,
    );
    const many = Array.from({ length: 501 }, (_, index) => described(GAME, `many${index}.svs`));
    assert.equal(
      (await reader(ticket, 'POST', '/listing', { saves: many, done: false })).statusCode,
      400,
    );
    const unnamed = { ...described(GAME, 'three.svs'), recordName: '' };
    assert.equal(
      (await reader(ticket, 'POST', '/listing', { saves: [unnamed], done: true })).statusCode,
      400,
    );
    await reader(ticket, 'POST', '/listing/failed', { reason: 'busy' });
    assert.equal((await asking).statusCode, 503);
  } finally {
    await mac.stop();
    await f.dispose();
  }
});

test('without a reader the Mac route says so, and one that goes quiet ends the import', {
  skip,
}, async () => {
  const { f, owner, attach, reader, finished, game } = await fixture({ readerSilentMs: 120 });
  try {
    game();
    const none = await owner('POST', '/preview', { source: 'mac' });
    assert.equal(none.statusCode, 409);
    assert.match(none.json().detail, /Open Emulation Server on the Mac/);

    const { ticket } = (await attach()).json();
    await reader(ticket, 'PUT', '/account', { state: 'available' });
    assert.equal((await owner('POST', '/import', { source: 'mac' })).statusCode, 202);
    assert.equal((await reader(ticket, 'GET', '/work')).json().work, 'list');
    await reader(ticket, 'POST', '/listing', { saves: [described(GAME, 'one.svs')], done: true });
    assert.equal((await reader(ticket, 'GET', '/work')).json().work, 'fetch');
    // The helper stops here, as if the Mac went to sleep.
    const ended = await finished();
    assert.equal(ended.state, 'failed');
    assert.match(ended.message, /Mac stopped answering/);
    assert.equal((await owner('GET', '')).json().reader.state, 'absent');
  } finally {
    await f.dispose();
  }
});

test('a save is taken once, a path in its name stays inside the game, and a twice-listed record is copied once', {
  skip,
}, async () => {
  const { f, owner, attach, reader, finished, game } = await fixture();
  try {
    const made = game();
    const { ticket } = (await attach()).json();
    await reader(ticket, 'PUT', '/account', { state: 'available' });
    const save = { ...described(GAME, 'one.svs'), filename: '../../outside/one.svs' };
    assert.equal((await owner('POST', '/import')).statusCode, 202);
    assert.equal((await reader(ticket, 'GET', '/work')).json().work, 'list');
    await reader(ticket, 'POST', '/listing', { saves: [save, save], done: true });
    const work = (await reader(ticket, 'GET', '/work')).json();
    assert.equal(work.work, 'fetch');
    const { requestId } = work.saves[0];
    assert.equal(
      (await reader(ticket, 'PUT', `/saves/${requestId}`, Buffer.from('generated'))).statusCode,
      204,
    );
    assert.equal(
      (await reader(ticket, 'PUT', `/saves/${requestId}`, Buffer.from('again'))).statusCode,
      404,
      'the same request is not answered twice',
    );
    const done = await finished();
    assert.deepEqual([done.total, done.imported, done.failed], [1, 1, 0]);
    const files = f.catalog.manifest(made.id)?.files ?? [];
    assert.deepEqual(
      files.map((file) => file.relativePath),
      ['icloud/com.provenance.core.fceux/__.._outside_one.svs'],
    );
  } finally {
    await f.dispose();
  }
});

test('stopping an import while the Mac is fetching ends it and tells the Mac to stop', {
  skip,
}, async () => {
  const { f, owner, attach, reader, finished, game } = await fixture();
  try {
    const made = game();
    const { ticket } = (await attach()).json();
    await reader(ticket, 'PUT', '/account', { state: 'available' });
    await owner('POST', '/import');
    await reader(ticket, 'GET', '/work');
    await reader(ticket, 'POST', '/listing', { saves: [described(GAME, 'one.svs')], done: true });
    const { requestId } = (await reader(ticket, 'GET', '/work')).json().saves[0];
    assert.equal((await owner('POST', '/import/cancel')).statusCode, 204);
    assert.equal((await finished()).state, 'cancelled');
    assert.equal((await reader(ticket, 'GET', '/work')).json().work, 'stop');
    assert.equal(
      (await reader(ticket, 'PUT', `/saves/${requestId}`, Buffer.from('late'))).statusCode,
      404,
      'a save that arrives after the stop is not taken',
    );
    assert.equal(f.catalog.manifest(made.id)?.files.length, 0);
  } finally {
    await f.dispose();
  }
});

test('a save whose game the app hashed differently is matched by the game file it recorded', {
  skip,
}, async () => {
  const { f, owner, attach, reader, finished } = await fixture();
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const shelf = join(f.base, 'shelf');
    await mkdir(join(shelf, 'copies'), { recursive: true });
    await writeFile(join(shelf, 'Headered Game.nes'), 'generated');
    await writeFile(join(shelf, 'Twice.nes'), 'generated one');
    await writeFile(join(shelf, 'copies', 'Twice.nes'), 'generated two');
    const root = f.catalog.createContentRoot({
      path: shelf,
      label: 'shelf',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
    const scanned = f.catalog
      .listSources(root.id)
      .find((source) => source.relativePath === 'Headered Game.nes');
    assert.ok(scanned?.systemId, 'the scan knows which system the file is for');

    // None of these identifiers is the MD5 of a file here.
    const headered = 'D'.repeat(32);
    const twice = 'E'.repeat(32);
    const resized = 'F'.repeat(32);
    const saves = [
      described(headered, 'one.svs'),
      described(twice, 'two.svs'),
      described(resized, 'three.svs'),
    ];
    const games = [
      {
        gameId: headered,
        systemIdentifier: scanned.systemId,
        filename: 'headered game.NES',
        size: 9,
        title: 'Headered Game',
      },
      // Two files here carry this name, so which game it is would be a guess.
      {
        gameId: twice,
        systemIdentifier: scanned.systemId,
        filename: 'Twice.nes',
        size: null,
        title: 'Twice',
      },
      // The right name and the wrong size is another file.
      {
        gameId: resized,
        systemIdentifier: scanned.systemId,
        filename: 'Headered Game.nes',
        size: 4096,
        title: 'Resized',
      },
    ];
    const { ticket } = (await attach()).json();
    await reader(ticket, 'PUT', '/account', { state: 'available' });
    const asking = owner('POST', '/preview', { source: 'mac' });
    for (let attempt = 0; attempt < 50; attempt += 1)
      if ((await reader(ticket, 'GET', '/work')).json().work === 'list') break;
    assert.equal(
      (
        await reader(ticket, 'POST', '/listing', {
          saves: [],
          done: false,
          games: [{ gameId: headered, filename: '../x.nes' }],
        })
      ).statusCode,
      400,
      'a name that tries to be a path is refused',
    );
    assert.equal(
      (await reader(ticket, 'POST', '/listing', { saves, done: true, games })).statusCode,
      204,
    );
    const preview = (await asking).json();
    assert.deepEqual(
      [preview.saves, preview.games, preview.gamesHere, preview.ready],
      [3, 3, 1, 1],
    );
    assert.deepEqual(
      preview.unmatched.map((game: { title: string }) => game.title).sort(),
      ['Resized', 'Twice'],
      'games not found are named, not shown as a hash',
    );

    assert.equal((await owner('POST', '/import', { source: 'mac' })).statusCode, 202);
    assert.equal((await reader(ticket, 'GET', '/work')).json().work, 'list');
    await reader(ticket, 'POST', '/listing', { saves, done: true, games });
    const work = (await reader(ticket, 'GET', '/work')).json();
    assert.equal(
      work.saves[0].recordName,
      saves[0]?.recordName,
      'only the matched save is asked for',
    );
    await reader(ticket, 'PUT', `/saves/${work.saves[0].requestId}`, Buffer.from('generated save'));
    const done = await finished();
    assert.deepEqual([done.imported, done.skipped, done.failed], [1, 2, 0]);
    const made = f.catalog.gameForSource(scanned.id);
    assert.ok(made, 'the scanned file got a game entry to hold its save');
    assert.equal(f.catalog.manifest(made.id)?.files.length, 1);
  } finally {
    await f.dispose();
  }
});

test('play history comes in with the saves and never goes backwards', { skip }, async () => {
  const { f, owner, attach, reader, finished, game } = await fixture();
  try {
    const made = game();
    const { ticket } = (await attach()).json();
    await reader(ticket, 'PUT', '/account', { state: 'available' });
    const recent = () =>
      f.app
        .inject({
          url: `/api/v1/browse?libraryId=${f.library.id}&category=games&played=recent`,
          headers: f.auth,
        })
        .then((answer) => answer.json().items as Array<Record<string, unknown>>);
    const bring = async (games: object[]) => {
      assert.equal((await owner('POST', '/import', { source: 'mac' })).statusCode, 202);
      assert.equal((await reader(ticket, 'GET', '/work')).json().work, 'list');
      await reader(ticket, 'POST', '/listing', { saves: [], done: true, games });
      return finished();
    };

    assert.equal(
      (
        await reader(ticket, 'POST', '/listing', {
          saves: [],
          done: true,
          games: [{ gameId: GAME, playCount: -1 }],
        })
      ).statusCode,
      400,
      'a count below zero is refused',
    );
    const first = await bring([
      { gameId: GAME, lastPlayedAt: '2026-05-01T10:00:00.000Z', playCount: 7, secondsPlayed: 3600 },
      // A game this server does not have is left alone.
      { gameId: ABSENT, lastPlayedAt: '2026-05-02T10:00:00.000Z', playCount: 1, secondsPlayed: 60 },
      // Never played in the app: nothing to bring.
      { gameId: 'B'.repeat(32), playCount: 0 },
    ]);
    assert.deepEqual([first.state, first.playsUpdated], ['completed', 1]);
    let listed = await recent();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, made.id);
    assert.deepEqual(
      [listed[0]?.lastPlayedAt, listed[0]?.playCount, listed[0]?.secondsPlayed],
      ['2026-05-01T10:00:00.000Z', 7, 3600],
    );
    assert.equal((await owner('GET', '')).json().preview.playedGames, 1);

    // An older record from another device changes nothing; a newer one moves it forward.
    await bring([
      { gameId: GAME, lastPlayedAt: '2026-01-01T10:00:00.000Z', playCount: 2, secondsPlayed: 10 },
    ]);
    listed = await recent();
    assert.deepEqual(
      [listed[0]?.lastPlayedAt, listed[0]?.playCount, listed[0]?.secondsPlayed],
      ['2026-05-01T10:00:00.000Z', 7, 3600],
    );
    await bring([
      { gameId: GAME, lastPlayedAt: '2026-06-01T10:00:00.000Z', playCount: 9, secondsPlayed: 5000 },
    ]);
    listed = await recent();
    assert.deepEqual(
      [listed[0]?.lastPlayedAt, listed[0]?.playCount, listed[0]?.secondsPlayed],
      ['2026-06-01T10:00:00.000Z', 9, 5000],
    );
    // A date from the future is brought back to now.
    await bring([{ gameId: GAME, lastPlayedAt: '2999-01-01T00:00:00.000Z' }]);
    listed = await recent();
    assert.ok(Date.parse(String(listed[0]?.lastPlayedAt)) <= Date.now());
    assert.equal(listed[0]?.playCount, 9, 'a record without counts keeps the ones known');
  } finally {
    await f.dispose();
  }
});

test('details and covers from the app fill what is missing and replace nothing chosen here', {
  skip,
}, async () => {
  const { f, owner, attach, reader, finished } = await fixture();
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const shelf = join(f.base, 'shelf');
    await mkdir(shelf);
    for (const name of ['Bare.nes', 'Matched.nes', 'Edited.nes', 'Badcover.nes'])
      await writeFile(join(shelf, name), `generated ${name}`);
    const root = f.catalog.createContentRoot({
      path: shelf,
      label: 'shelf',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
    const file = (name: string) => {
      const found = f.catalog.listSources(root.id).find((source) => source.relativePath === name);
      assert.ok(found?.systemId);
      return found as typeof found & { systemId: string };
    };
    const record = (sourceId: string, kind: 'metadata' | 'artwork') =>
      f.catalog.sourceMatches(sourceId).matches.find((match) => match.kind === kind);
    const save = (sourceId: string, providerId: string, metadata: Record<string, string>) =>
      f.catalog.saveSourceMatch(
        sourceId,
        f.catalog.sourceMatches(sourceId).revision,
        'metadata',
        {
          id: `${providerId}:metadata:generated`,
          providerId,
          kind: 'metadata',
          title: metadata.title ?? 'Generated',
          confidence: providerId === 'manual' ? 'local' : 'name',
          metadata,
          originKind: null,
          contentAvailable: false,
          contentType: null,
          fileName: null,
          updatedAt: new Date().toISOString(),
        },
        null,
        f.owner.id,
      );
    const [bare, matched, edited, badcover] = [
      'Bare.nes',
      'Matched.nes',
      'Edited.nes',
      'Badcover.nes',
    ].map(file);
    assert.ok(bare && matched && edited && badcover);
    save(matched.id, 'org.generated.matcher', {
      title: 'Matched by the server',
      developer: 'Server Dev',
    });
    save(edited.id, 'manual', { title: 'Typed here', description: 'Typed here too' });

    const about = (name: string, tag: string, extra: object) => ({
      gameId: createHashFor(name),
      systemIdentifier: bare.systemId,
      filename: name,
      recordName: `rom_${name}`,
      changeTag: tag,
      ...extra,
    });
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from('generated cover'),
    ]);
    const bring = async (games: object[], covers: Record<string, Buffer> = {}) => {
      assert.equal((await owner('POST', '/import', { source: 'mac' })).statusCode, 202);
      assert.equal((await reader(ticket, 'GET', '/work')).json().work, 'list');
      await reader(ticket, 'POST', '/listing', { saves: [], done: true, games });
      const asked: string[] = [];
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const state = (await owner('GET', '')).json().import;
        if (state.state !== 'running') break;
        const work = (await reader(ticket, 'GET', '/work')).json();
        for (const wanted of work.saves ?? []) {
          assert.equal(wanted.file, 'cover');
          asked.push(wanted.recordName);
          await reader(
            ticket,
            'PUT',
            `/saves/${wanted.requestId}`,
            covers[wanted.recordName] ?? Buffer.from('x'),
          );
        }
      }
      return { done: await finished(), asked };
    };
    const { ticket } = (await attach()).json();
    await reader(ticket, 'PUT', '/account', { state: 'available' });

    const games = [
      about('Bare.nes', 't1', {
        title: 'Bare Game',
        description: 'From the app',
        year: '1990',
        hasCustomCover: true,
      }),
      about('Matched.nes', 't1', {
        title: 'App title',
        developer: 'App Dev',
        publisher: 'App Pub',
      }),
      about('Edited.nes', 't1', {
        title: 'App title',
        description: 'App description',
        genre: 'Action',
      }),
      about('Badcover.nes', 't1', { hasCustomCover: true }),
    ];
    const first = await bring(games, {
      'rom_Bare.nes': png,
      'rom_Badcover.nes': Buffer.from('not an image'),
    });
    assert.deepEqual(
      [first.done.state, first.done.detailsUpdated, first.done.coversUpdated],
      ['completed', 2, 1],
    );
    assert.deepEqual(first.asked.sort(), ['rom_Badcover.nes', 'rom_Bare.nes']);

    // A game with nothing here takes the app's title and details, and its owner's cover.
    const filled = record(bare.id, 'metadata');
    assert.equal(filled?.providerId, 'provenance');
    assert.deepEqual(
      [filled?.title, filled?.metadata.description, filled?.metadata.year],
      ['Bare Game', 'From the app', '1990'],
    );
    assert.equal(record(bare.id, 'artwork')?.providerId, 'provenance');
    // A game the server matched keeps its title and what it knew; only the blank is filled.
    const kept = record(matched.id, 'metadata');
    assert.deepEqual(
      [kept?.providerId, kept?.title, kept?.metadata.developer, kept?.metadata.publisher],
      ['org.generated.matcher', 'Matched by the server', 'Server Dev', 'App Pub'],
    );
    // What a person typed here is not touched, not even to fill a blank.
    const typed = record(edited.id, 'metadata');
    assert.deepEqual(
      [typed?.providerId, typed?.title, typed?.metadata.description, typed?.metadata.genre],
      ['manual', 'Typed here', 'Typed here too', undefined],
    );
    // A file that is not an image is not a cover.
    assert.equal(record(badcover.id, 'artwork'), undefined);

    // A blank the owner makes afterwards stays blank until the record changes in iCloud.
    save(matched.id, 'org.generated.matcher', {
      title: 'Matched by the server',
      developer: 'Server Dev',
    });
    const again = await bring(games);
    assert.deepEqual(
      [again.done.detailsUpdated, again.done.coversUpdated, again.asked],
      [0, 0, []],
    );
    assert.equal(record(matched.id, 'metadata')?.metadata.publisher, undefined);
    const changed = await bring([about('Matched.nes', 't2', { publisher: 'App Pub' })]);
    assert.equal(changed.done.detailsUpdated, 1);
    assert.equal(record(matched.id, 'metadata')?.metadata.publisher, 'App Pub');

    // A cover chosen in the app does not replace one chosen here.
    f.catalog.saveSourceMatch(
      bare.id,
      f.catalog.sourceMatches(bare.id).revision,
      'artwork',
      {
        id: 'manual:artwork:generated',
        providerId: 'manual',
        kind: 'artwork',
        artworkRole: 'front',
        title: 'Bare Game',
        confidence: 'local',
        metadata: { artworkRole: 'front' },
        originKind: null,
        contentAvailable: true,
        contentType: 'image/png',
        fileName: 'cover.png',
        updatedAt: new Date().toISOString(),
      },
      png,
      f.owner.id,
      'front',
    );
    const later = await bring([about('Bare.nes', 't2', { hasCustomCover: true })]);
    assert.deepEqual([later.done.coversUpdated, later.asked], [0, []]);
    assert.equal(record(bare.id, 'artwork')?.providerId, 'manual');
  } finally {
    await f.dispose();
  }
});

/** A stand-in for the app's identifier: stable for a name, and the MD5 of no file here. */
function createHashFor(name: string): string {
  return Buffer.from(name.padEnd(16, '_')).toString('hex').slice(0, 32).toUpperCase();
}
