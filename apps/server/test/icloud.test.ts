import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { blobPath } from '@ecs/storage';
import type { CloudKitFetch } from '../src/cloudkit.js';
import { libraryFixture } from './library-fixture.js';

const API = 'generated-api-token';
const FIRST = 'generated+web/token=1';

/**
 * Stands in for Apple. Like the real service it accepts a web auth token once and answers with
 * the next one, and it has no operation that changes anything.
 */
function apple(records: Array<Record<string, unknown>>) {
  let current = FIRST;
  let issued = 1;
  const calls: string[] = [];
  const fetch: CloudKitFetch = async (address, init) => {
    const url = new URL(address);
    calls.push(`${init.method} ${url.pathname}`);
    const answer = (status: number, body: object) => ({ status, json: async () => body });
    assert.equal(url.searchParams.get('ckAPIToken'), API);
    const token = url.searchParams.get('ckWebAuthToken');
    if (!token)
      return answer(421, {
        serverErrorCode: 'AUTHENTICATION_REQUIRED',
        redirectURL: 'https://idmsa.apple.com/sign-in-for-test',
      });
    if (token !== current) return answer(421, { serverErrorCode: 'AUTHENTICATION_FAILED' });
    issued += 1;
    current = `generated+web/token=${issued}`;
    if (url.pathname.endsWith('/public/users/caller'))
      return answer(200, { userRecordName: '_generated', ckWebAuthToken: current });
    assert.ok(url.pathname.endsWith('/private/records/query'), url.pathname);
    const body = JSON.parse(init.body ?? '{}');
    assert.deepEqual(body.query, { recordType: 'SaveState' });
    const start = Number(body.continuationMarker ?? 0);
    const page = records.slice(start, start + 2);
    return answer(200, {
      records: page,
      ...(start + 2 < records.length ? { continuationMarker: String(start + 2) } : {}),
      ckWebAuthToken: current,
    });
  };
  const download = async (url: string) =>
    new Response(`bytes of ${new URL(url).searchParams.get('save')}`);
  return { fetch, download, calls, expire: () => (current = 'gone') };
}

function saveRecord(gameId: string, filename: string, tag = 'tag1') {
  return {
    recordName: `savestate_${gameId}_${filename.replaceAll('.', '_')}`,
    recordType: 'SaveState',
    recordChangeTag: tag,
    modified: { timestamp: Date.parse('2026-03-03T10:00:00Z') },
    fields: {
      gameID: { value: gameId },
      filename: { value: filename },
      systemIdentifier: { value: 'com.provenance.nes' },
      coreIdentifier: { value: 'com.provenance.core.fceux' },
      lastModifiedDevice: { value: 'GENERATED-DEVICE' },
      fileData: {
        value: {
          size: 20,
          downloadURL: `https://cvws.icloud-content.com/B/\${f}?save=${gameId}-${filename}-${tag}`,
        },
      },
    },
  };
}

const UPLOADED = 'A'.repeat(32);
const SCANNED = 'b'.repeat(32);
const ABSENT = 'C'.repeat(32);

async function connected(records: Array<Record<string, unknown>>) {
  const fake = apple(records);
  const f = await libraryFixture({
    icloud: { apiToken: API, fetch: fake.fetch, download: fake.download },
  });
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: object) =>
    f.app.inject({
      method,
      url: `/api/v1/icloud${path}`,
      headers: f.auth,
      ...(payload ? { payload } : {}),
    });
  const finished = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const state = (await call('GET', '')).json().import;
      if (state && state.state !== 'running') return state;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('The import did not finish');
  };
  return { f, fake, call, finished };
}

test('a server without an API token offers no iCloud saves', async () => {
  const f = await libraryFixture();
  try {
    const capabilities = (await f.app.inject({ url: '/api/v1/capabilities' })).json();
    assert.notEqual(capabilities.features.icloudSaves, true);
    assert.equal((await f.app.inject({ url: '/api/v1/icloud', headers: f.auth })).statusCode, 404);
  } finally {
    await f.dispose();
  }
});

test('only the owner reaches iCloud saves, and the sign-in token is never handed back', async () => {
  const { f, call } = await connected([]);
  try {
    const capabilities = (await f.app.inject({ url: '/api/v1/capabilities' })).json();
    assert.equal(capabilities.features.icloudSaves, true);
    const member = f.catalog.createUser({
      username: 'member',
      passwordHash: 'generated-hash',
      actorId: f.owner.id,
    });
    const session = issueToken();
    f.catalog.createSession(member.id, session.hash);
    const asMember = await f.app.inject({
      url: '/api/v1/icloud',
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(asMember.statusCode, 403);
    // A device trusted for being on the home network is not the owner.
    const nearby = await f.app.inject({ url: '/api/v1/icloud', remoteAddress: '192.168.1.20' });
    assert.equal(nearby.statusCode, 403);

    const signIn = await call('POST', '/sign-in');
    assert.equal(signIn.json().signInUrl, 'https://idmsa.apple.com/sign-in-for-test');
    assert.equal((await call('PUT', '/session', {})).statusCode, 400);
    const refused = await call('PUT', '/session', { webAuthToken: 'not-the-token' });
    assert.equal(refused.statusCode, 409);
    assert.equal((await call('GET', '')).json().connected, false);

    const accepted = await call('PUT', '/session', { webAuthToken: FIRST });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().connected, true);
    assert.ok(!accepted.body.includes('generated+web'), 'no token in an answer');
    assert.ok(!(await call('GET', '')).body.includes('generated+web'));

    assert.equal((await call('DELETE', '/session')).statusCode, 204);
    assert.equal((await call('GET', '')).json().connected, false);
    assert.equal((await call('POST', '/import')).statusCode, 409);
  } finally {
    await f.dispose();
  }
});

test('a preview counts saves without copying, and an import adds them beside what is there', async () => {
  const records = [
    saveRecord(UPLOADED, 'one.svs'),
    saveRecord(UPLOADED, 'two.svs'),
    saveRecord(SCANNED.toUpperCase(), 'scanned.svs'),
    saveRecord(ABSENT, 'absent.svs'),
    saveRecord('not-an-md5', 'old.svs'),
  ];
  const { f, fake, call, finished } = await connected(records);
  try {
    const game = f.catalog.createItem({
      libraryId: f.library.id,
      title: 'Uploaded',
      systemIdentifier: 'com.provenance.nes',
      md5: UPLOADED.toLowerCase(),
      crc: null,
      actorId: f.owner.id,
    });
    const path = join(f.base, 'shelf');
    await mkdir(path);
    await writeFile(join(path, 'Scanned Game.nes'), 'generated');
    const root = f.catalog.createContentRoot({
      path,
      label: 'shelf',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
    const source = f.catalog.listSources(root.id)[0];
    assert.ok(source);
    f.catalog.saveMatchingFingerprint(source.id, 'generated-stamp', {
      md5: SCANNED,
      crc32: '12345678',
      size: 9,
    });
    assert.equal(f.catalog.gameForSource(source.id), null);

    await call('PUT', '/session', { webAuthToken: FIRST });
    const preview = await call('POST', '/preview');
    assert.equal(preview.statusCode, 200, preview.body);
    const counted = preview.json();
    assert.deepEqual(
      [counted.saves, counted.games, counted.gamesHere, counted.ready, counted.alreadyHere],
      [5, 4, 2, 3, 0],
    );
    assert.equal(counted.bytes, 100);
    assert.deepEqual(
      counted.unmatched.map((entry: { gameId: string }) => entry.gameId).sort(),
      [ABSENT, 'not-an-md5'].sort(),
    );
    assert.equal(f.catalog.manifest(game.id)?.files.length, 0, 'a preview copies nothing');
    assert.equal(f.catalog.gameForSource(source.id), null, 'a preview creates nothing');

    assert.equal((await call('POST', '/import')).statusCode, 202);
    const first = await finished();
    assert.deepEqual(
      [first.state, first.total, first.imported, first.skipped, first.failed],
      ['completed', 5, 3, 2, 0],
    );
    const files = f.catalog.manifest(game.id)?.files ?? [];
    assert.deepEqual(files.map((file) => file.relativePath).sort(), [
      'icloud/com.provenance.core.fceux/one.svs',
      'icloud/com.provenance.core.fceux/two.svs',
    ]);
    assert.ok(files.every((file) => file.kind === 'save_state' && file.conflictOf === null));
    const one = files.find((file) => file.relativePath.endsWith('one.svs'));
    assert.ok(one);
    assert.equal(
      await readFile(blobPath(join(f.base, 'data'), one.sha256), 'utf8'),
      `bytes of ${UPLOADED}-one.svs-tag1`,
    );
    const made = f.catalog.gameForSource(source.id);
    assert.ok(made, 'the scanned file got a game entry to hold its save');
    assert.equal(f.catalog.manifest(made.id)?.files.length, 1);

    // The same records again copy nothing.
    await call('POST', '/import');
    const second = await finished();
    assert.deepEqual([second.imported, second.skipped], [0, 5]);
    assert.equal(f.catalog.manifest(game.id)?.files.length, 2);
    assert.equal((await call('GET', '')).json().preview.alreadyHere, 3);

    // A record that changed in iCloud lands beside the save already here and replaces nothing.
    records[0] = saveRecord(UPLOADED, 'one.svs', 'tag2');
    await call('POST', '/import');
    const third = await finished();
    assert.equal(third.imported, 1);
    const after = f.catalog.manifest(game.id)?.files ?? [];
    assert.equal(after.length, 3);
    const kept = after.find((file) => file.id === one.id);
    assert.equal(kept?.relativePath, 'icloud/com.provenance.core.fceux/one.svs');
    assert.equal(after.filter((file) => file.conflictOf === one.id).length, 1);

    assert.ok(
      fake.calls.every((entry) => entry.startsWith('GET ') || entry.endsWith('/records/query')),
      'nothing was written to iCloud',
    );
  } finally {
    await f.dispose();
  }
});

test('a save that cannot be downloaded is counted and leaves no empty game behind', async () => {
  const fake = apple([saveRecord(SCANNED.toUpperCase(), 'scanned.svs')]);
  const f = await libraryFixture({
    icloud: {
      apiToken: API,
      fetch: fake.fetch,
      download: async () => new Response('', { status: 404 }),
    },
  });
  try {
    const path = join(f.base, 'shelf');
    await mkdir(path);
    await writeFile(join(path, 'Scanned Game.nes'), 'generated');
    const root = f.catalog.createContentRoot({
      path,
      label: 'shelf',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
    const source = f.catalog.listSources(root.id)[0];
    assert.ok(source);
    f.catalog.saveMatchingFingerprint(source.id, 'generated-stamp', {
      md5: SCANNED,
      crc32: '12345678',
      size: 9,
    });
    const call = (method: 'GET' | 'POST' | 'PUT', route: string, payload?: object) =>
      f.app.inject({
        method,
        url: `/api/v1/icloud${route}`,
        headers: f.auth,
        ...(payload ? { payload } : {}),
      });
    await call('PUT', '/session', { webAuthToken: FIRST });
    await call('POST', '/import');
    let state = (await call('GET', '')).json().import;
    for (let attempt = 0; state.state === 'running' && attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = (await call('GET', '')).json().import;
    }
    assert.deepEqual([state.state, state.imported, state.failed], ['completed', 0, 1]);
    assert.equal(f.catalog.gameForSource(source.id), null);
    assert.equal((await call('GET', '')).json().connected, true, 'the sign-in survives');
  } finally {
    await f.dispose();
  }
});

test('a sign-in that ran out stops the import and says so', async () => {
  const { f, fake, call, finished } = await connected([saveRecord(UPLOADED, 'one.svs')]);
  try {
    await call('PUT', '/session', { webAuthToken: FIRST });
    fake.expire();
    assert.equal((await call('POST', '/preview')).statusCode, 409);
    assert.equal((await call('GET', '')).json().connected, false);
    await call('PUT', '/session', { webAuthToken: 'gone' });
    fake.expire();
    await call('POST', '/import');
    const stopped = await finished();
    assert.equal(stopped.state, 'failed');
    assert.match(stopped.message, /Sign in again/);
  } finally {
    await f.dispose();
  }
});

test('a failure reaching Apple never quotes the address that carries the tokens', async () => {
  const f = await libraryFixture({
    icloud: {
      apiToken: API,
      fetch: async (url) => {
        throw new Error(`connect failed for ${url}`);
      },
    },
  });
  try {
    const response = await f.app.inject({
      method: 'PUT',
      url: '/api/v1/icloud/session',
      headers: f.auth,
      payload: { webAuthToken: FIRST },
    });
    assert.equal(response.statusCode, 502);
    assert.ok(!response.body.includes(API) && !response.body.includes('generated'));
  } finally {
    await f.dispose();
  }
});
