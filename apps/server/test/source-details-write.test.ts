import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';
import { libraryFixture } from './library-fixture.js';

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
function png(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function fixture() {
  const plugins = await mkdtemp(join(tmpdir(), 'ecs-details-write-'));
  await mkdir(join(plugins, 'provider'));
  await writeFile(
    join(plugins, 'provider', 'plugin.json'),
    JSON.stringify({
      id: 'test.details.provider',
      name: 'Generated details provider',
      kind: 'provider',
      version: '1',
      engine: 'ecs.plugin/1',
      entry: 'entry.mjs',
      provider: { capabilities: ['metadata', 'artwork'], network: false },
    }),
  );
  await writeFile(
    join(plugins, 'provider', 'entry.mjs'),
    `export default {search:async input=>{const result=[{id:'meta',kind:'metadata',title:'Provider title',confidence:'checksum',metadata:{md5:input.md5,hashSize:String(input.size),systemId:input.systemId,title:'Provider title',publisher:'Acme',year:'1990',description:'Provider text',matchEvidence:'verified-hash'}}];const selected=input.selectedMetadata;const file=input.companions.find(row=>row.name.endsWith('.png'));if(selected&&file)result.push({id:'front',kind:'artwork',title:selected.title,confidence:'local',fileId:file.id,metadata:{artworkRole:'front',systemId:selected.systemId,matchedGame:selected.title,savedMetadataId:selected.id,savedMetadataRevision:String(selected.revision),matchEvidence:'saved-selection'}});return result}};`,
  );
  const f = await libraryFixture({ matchingPluginsDir: plugins, localTrust: false });
  const path = join(f.base, 'games');
  await mkdir(path);
  await writeFile(join(path, 'Game.nes'), Buffer.from([1, 2, 3, 4]));
  await writeFile(join(path, 'Game.png'), png());
  const root = f.catalog.createContentRoot({
    path,
    label: 'Generated',
    libraryId: f.library.id,
    actorId: f.owner.id,
  });
  await f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
  const source = f.catalog.listSources(root.id).find((s) => s.displayName === 'Game.nes');
  assert.ok(source);

  async function person(username: string, role: 'reader' | 'editor' | null) {
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: f.auth,
      payload: { username, password: 'generated-password' },
    });
    assert.equal(created.statusCode, 201, created.body);
    if (role) f.catalog.setMember(f.library.id, created.json().id, role, f.owner.id);
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password: 'generated-password' },
    });
    const headers = { authorization: `Bearer ${login.json().token}` };
    async function device(scopes: string[]) {
      const issued = await f.app.inject({
        method: 'POST',
        url: '/api/v1/device-tokens',
        headers,
        payload: { name: `${username} device`, scopes, expiresInSeconds: 3600 },
      });
      assert.equal(issued.statusCode, 201, issued.body);
      return { authorization: `Bearer ${issued.json().token}` };
    }
    return { headers, device };
  }

  const base = `/api/v1/sources/${source.id}`;
  const revision = (headers = f.auth) =>
    f.app
      .inject({ url: `${base}/matches/selections`, headers })
      .then((r) => r.json().revision as number);
  const putDetails = async (
    payload: unknown,
    options: { headers?: Record<string, string>; rev?: number | null } = {},
  ) => {
    const headers = options.headers ?? f.auth;
    const rev = options.rev === undefined ? await revision() : options.rev;
    return f.app.inject({
      method: 'PUT',
      url: `${base}/details`,
      headers: { ...headers, ...(rev === null ? {} : { 'if-match': `"rev-${rev}"` }) },
      payload: payload as object,
    });
  };
  const putCover = async (
    payload: Buffer,
    options: { headers?: Record<string, string>; rev?: number | null; type?: string } = {},
  ) => {
    const headers = options.headers ?? f.auth;
    const rev = options.rev === undefined ? await revision() : options.rev;
    return f.app.inject({
      method: 'PUT',
      url: `${base}/details/cover`,
      headers: {
        ...headers,
        'content-type': options.type ?? 'image/png',
        ...(rev === null ? {} : { 'if-match': `"rev-${rev}"` }),
      },
      payload,
    });
  };
  const browseRow = async () => {
    const response = await f.app.inject({
      url: `/api/v1/browse?category=games&libraryId=${f.library.id}`,
      headers: f.auth,
    });
    assert.equal(response.statusCode, 200, response.body);
    const row = (
      response.json().items as { entityType: string; source?: Record<string, unknown> }[]
    ).find((item) => item.source?.id === source.id);
    assert.ok(row?.source, response.body);
    return row.source;
  };
  const runMatchJob = async () => {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/v1/library-jobs',
      headers: f.auth,
      payload: {
        kind: 'match',
        rootId: root.id,
        options: { checksum: true, providerIds: ['test.details.provider'] },
      },
    });
    assert.equal(response.statusCode, 202, response.body);
    const id = response.json().job.id;
    const deadline = Date.now() + 5000;
    while (
      f.catalog.libraryJobs.get(id)?.state === 'queued' ||
      f.catalog.libraryJobs.get(id)?.state === 'running'
    ) {
      assert.ok(Date.now() < deadline);
      await pause(5);
    }
  };
  return {
    ...f,
    root,
    source,
    base,
    person,
    revision,
    putDetails,
    putCover,
    browseRow,
    runMatchJob,
    dispose: async () => {
      await f.dispose();
      await rm(plugins, { recursive: true, force: true });
    },
  };
}

test('an owner saves details by hand and the browse row, revision and change feed follow', async () => {
  const f = await fixture();
  try {
    const before = await f.revision();
    const saved = await f.putDetails({
      title: '  My Game  ',
      details: { publisher: ' Me ', year: '1999', description: 'Hand written' },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().sourceId, f.source.id);
    assert.equal(saved.json().revision, before + 1);
    const metadata = saved.json().matches.find((m: { kind: string }) => m.kind === 'metadata');
    assert.equal(metadata.providerId, 'manual');
    assert.equal(metadata.title, 'My Game');
    const row = await f.browseRow();
    assert.equal(row.title, 'My Game');
    assert.deepEqual(row.details, { publisher: 'Me', year: '1999', description: 'Hand written' });
    const feed = await f.app.inject({ url: '/api/v1/changes?cursor=0', headers: f.auth });
    const changes = feed.json().changes as { entityType: string; entityId: string }[];
    assert.ok(changes.some((c) => c.entityType === 'source' && c.entityId === f.source.id));
  } finally {
    await f.dispose();
  }
});

test('a title-only edit keeps provider details; present keys replace, empty strings clear', async () => {
  const f = await fixture();
  try {
    await f.runMatchJob();
    const matched = await f.browseRow();
    assert.equal(matched.title, 'Provider title');
    assert.deepEqual(matched.details, {
      publisher: 'Acme',
      year: '1990',
      description: 'Provider text',
    });
    const titleOnly = await f.putDetails({ title: 'Renamed' });
    assert.equal(titleOnly.statusCode, 200, titleOnly.body);
    const row = await f.browseRow();
    assert.equal(row.title, 'Renamed');
    assert.deepEqual(row.details, {
      publisher: 'Acme',
      year: '1990',
      description: 'Provider text',
    });
    const partial = await f.putDetails({
      title: 'Renamed',
      details: { year: '2001', publisher: '', genre: 'Puzzle' },
    });
    assert.equal(partial.statusCode, 200, partial.body);
    assert.deepEqual((await f.browseRow()).details, {
      year: '2001',
      genre: 'Puzzle',
      description: 'Provider text',
    });
  } finally {
    await f.dispose();
  }
});

test('an owner saves a cover and it is served with a validator', async () => {
  const f = await fixture();
  try {
    const bytes = png();
    const before = await f.revision();
    const saved = await f.putCover(bytes);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().revision, before + 1);
    const artwork = saved.json().matches.find((m: { kind: string }) => m.kind === 'artwork');
    assert.equal(artwork.providerId, 'manual');
    assert.equal(artwork.contentAvailable, true);
    const row = await f.browseRow();
    assert.equal(row.artworkAvailable, true);
    assert.equal(typeof row.artworkPath, 'string');
    const fetched = await f.app.inject({ url: row.artworkPath as string, headers: f.auth });
    assert.equal(fetched.statusCode, 200);
    assert.deepEqual(fetched.rawPayload, bytes);
    const etag = fetched.headers.etag as string;
    assert.equal(etag, `"${createHash('sha256').update(bytes).digest('hex')}"`);
    const again = await f.app.inject({
      url: row.artworkPath as string,
      headers: { ...f.auth, 'if-none-match': etag },
    });
    assert.equal(again.statusCode, 304);
  } finally {
    await f.dispose();
  }
});

test('write authority follows library membership and token scope', async () => {
  const f = await fixture();
  try {
    const reader = await f.person('shelf-reader', 'reader');
    const editor = await f.person('shelf-editor', 'editor');
    const outsider = await f.person('no-access', null);
    const readOnlyDevice = await editor.device(['read']);
    const editorDevice = await editor.device(['read', 'write']);
    const before = await f.revision();

    for (const call of [
      (headers: Record<string, string>) => f.putDetails({ title: 'X' }, { headers, rev: before }),
      (headers: Record<string, string>) => f.putCover(png(), { headers, rev: before }),
    ]) {
      assert.equal((await call(readOnlyDevice)).statusCode, 403, 'read-only token');
      assert.equal((await call(reader.headers)).statusCode, 403, 'library reader');
      assert.equal((await call(outsider.headers)).statusCode, 404, 'no access');
      assert.equal((await call({})).statusCode, 401, 'unauthenticated');
    }
    assert.equal(
      (await f.putDetails({ nonsense: true }, { headers: reader.headers, rev: before })).statusCode,
      403,
      'access is decided before the body is read',
    );
    assert.equal(
      (await f.putCover(Buffer.from('text'), { headers: outsider.headers, rev: before }))
        .statusCode,
      404,
    );
    assert.equal(await f.revision(), before, 'denied calls change nothing');

    assert.equal(
      (await f.putDetails({ title: 'By editor' }, { headers: editor.headers, rev: before }))
        .statusCode,
      200,
    );
    assert.equal(
      (await f.putCover(png(), { headers: editorDevice, rev: before + 1 })).statusCode,
      200,
    );
    assert.equal((await f.browseRow()).title, 'By editor');
  } finally {
    await f.dispose();
  }
});

test('the owner-only match routes still reject a write-scope editor', async () => {
  const f = await fixture();
  try {
    const editor = await f.person('shelf-editor', 'editor');
    const rev = await f.revision();
    const withMatch = { 'if-match': `"rev-${rev}"` };
    const selected = await f.app.inject({
      method: 'PUT',
      url: `${f.base}/matches/selections`,
      headers: editor.headers,
      payload: { requestId: 'x', candidateId: 'y', expectedRevision: rev },
    });
    const hints = await f.app.inject({
      method: 'PUT',
      url: `${f.base}/matches/lookup-hints`,
      headers: { ...editor.headers, ...withMatch },
      payload: { title: 'X', systemId: null },
    });
    const removed = await f.app.inject({
      method: 'DELETE',
      url: `${f.base}/matches/selections/metadata`,
      headers: { ...editor.headers, ...withMatch },
    });
    for (const response of [selected, hints, removed])
      assert.equal(response.statusCode, 403, response.body);
  } finally {
    await f.dispose();
  }
});

test('revision preconditions and validation reject before changing anything', async () => {
  const f = await fixture();
  try {
    const rev = await f.revision();
    assert.equal((await f.putDetails({ title: 'X' }, { rev: null })).statusCode, 428);
    assert.equal((await f.putCover(png(), { rev: null })).statusCode, 428);
    assert.equal((await f.putDetails({ title: 'X' }, { rev: rev + 5 })).statusCode, 409);
    assert.equal((await f.putCover(png(), { rev: rev + 5 })).statusCode, 409);
    for (const body of [
      { title: '' },
      { title: '   ' },
      { title: 'x'.repeat(201) },
      {},
      { title: 'ok', extra: 1 },
      { title: 'ok', details: { unknown: 'x' } },
      { title: 'ok', details: { description: 'x'.repeat(2001) } },
      { title: 'ok', details: { year: 1999 } },
    ])
      assert.equal(
        (await f.putDetails(body, { rev })).statusCode,
        400,
        JSON.stringify(body).slice(0, 80),
      );
    assert.equal(
      (await f.putCover(Buffer.from('not an image at all, just text'), { rev })).statusCode,
      415,
    );
    assert.equal((await f.putCover(png(), { rev, type: 'image/jpeg' })).statusCode, 415);
    assert.equal((await f.putCover(png(), { rev, type: 'image/gif' })).statusCode, 415);
    assert.equal((await f.putCover(png(), { rev, type: 'text/plain' })).statusCode, 415);
    const oversize = await f.putCover(
      Buffer.concat([png().subarray(0, 8), Buffer.alloc(2 * 1024 * 1024)]),
      { rev },
    );
    assert.equal(oversize.statusCode, 413);
    assert.match(oversize.json().type, /matching-file-too-large$/);
    assert.equal(await f.revision(), rev, 'nothing changed');
  } finally {
    await f.dispose();
  }
});

test('hand-entered details and cover survive automatic matching', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.putDetails({ title: 'Mine', details: { year: '1985' } })).statusCode,
      200,
    );
    assert.equal((await f.putCover(png())).statusCode, 200);
    const before = f.catalog.sourceMatches(f.source.id);
    await f.runMatchJob();
    const after = f.catalog.sourceMatches(f.source.id);
    assert.equal(after.revision, before.revision, 'automatic matching saved nothing');
    assert.deepEqual(
      after.matches.map((m) => [m.kind, m.providerId]),
      [
        ['artwork', 'manual'],
        ['metadata', 'manual'],
      ],
    );
  } finally {
    await f.dispose();
  }
});
