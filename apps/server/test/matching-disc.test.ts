import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { libraryFixture } from './library-fixture.js';

function psxDisc() {
  const image = Buffer.alloc(24 * 2048);
  const twin32 = (bytes: Buffer, at: number, value: number) => {
    bytes.writeUInt32LE(value, at);
    bytes.writeUInt32BE(value, at + 4);
  };
  const twin16 = (bytes: Buffer, at: number, value: number) => {
    bytes.writeUInt16LE(value, at);
    bytes.writeUInt16BE(value, at + 2);
  };
  const record = (lba: number, size: number, name: Buffer, flags = 0) => {
    const row = Buffer.alloc(33 + name.length + (name.length % 2 === 0 ? 1 : 0));
    row[0] = row.length;
    twin32(row, 2, lba);
    twin32(row, 10, size);
    row[25] = flags;
    twin16(row, 28, 1);
    row[32] = name.length;
    name.copy(row, 33);
    return row;
  };
  const config = Buffer.from('BOOT = cdrom:\\SLUS_123.45;1\n');
  const pvd = image.subarray(16 * 2048, 17 * 2048);
  pvd[0] = 1;
  pvd.write('CD001', 1, 'ascii');
  pvd[6] = 1;
  twin32(pvd, 80, 24);
  twin16(pvd, 120, 1);
  twin16(pvd, 124, 1);
  twin16(pvd, 128, 2048);
  const root = record(20, 2048, Buffer.from([0]), 2);
  root.copy(pvd, 156);
  Buffer.concat([
    root,
    record(20, 2048, Buffer.from([1]), 2),
    record(21, config.length, Buffer.from('SYSTEM.CNF;1')),
  ]).copy(image, 20 * 2048);
  config.copy(image, 21 * 2048);
  return image;
}
async function fixture(format: 'cue' | 'gdi' = 'gdi') {
  const plugins = await mkdtemp(join(tmpdir(), 'ecs-disc-matching-'));
  await mkdir(join(plugins, 'provider'));
  await writeFile(
    join(plugins, 'provider', 'plugin.json'),
    JSON.stringify({
      id: 'test.disc.provider',
      name: 'Generated disc metadata',
      kind: 'provider',
      version: '1',
      engine: 'ecs.plugin/1',
      entry: 'entry.mjs',
      provider: { capabilities: ['metadata', 'artwork'], network: false },
    }),
  );
  await writeFile(
    join(plugins, 'provider', 'entry.mjs'),
    `export default {search:async input=>{const ids=input.facts?.identifiers.filter(id=>id.verified&&id.type==='serial')??[];if(!ids.length)return[];const metadata={serials:JSON.stringify(ids.map(id=>id.value)),systemId:input.systemId,title:'Generated game',matchedGame:'Generated game',matchEvidence:'verified-serial'};const result=[{id:'meta',kind:'metadata',title:'Generated game',confidence:'checksum',metadata}];const art=input.companions.find(file=>file.name==='Game.png');if(art)result.push({id:'front',kind:'artwork',title:'Generated game',confidence:'local',fileId:art.id,metadata:{...metadata,artworkRole:'front'}});return result;}};`,
  );
  const f = await libraryFixture({ matchingPluginsDir: plugins });
  const path = join(f.base, format === 'cue' ? 'psx' : 'dreamcast');
  await mkdir(path);
  const descriptor =
    format === 'cue'
      ? 'FILE "Data.bin" BINARY\nTRACK 01 MODE1/2048\nINDEX 01 00:00:00\n'
      : '3\n1 0 0 2352 "Audio One.raw" 0\n2 450 0 2352 "Audio Two.raw" 0\n3 45000 4 2048 "Data.bin" 4096\n';
  await writeFile(join(path, `Game.${format}`), descriptor);
  for (const name of format === 'gdi' ? ['Audio One.raw', 'Audio Two.raw'] : [])
    await writeFile(join(path, name), Buffer.alloc(2352));
  const track = (serial: string) => {
    const bytes = Buffer.alloc(6144, 32);
    bytes.write('SEGA SEGAKATANA ', 4096, 'ascii');
    bytes.fill(32, 4096 + 0x40, 4096 + 0x4a);
    bytes.write(serial, 4096 + 0x40, 'ascii');
    bytes.write('Generated game', 4096 + 0x80, 'ascii');
    return bytes;
  };
  await writeFile(join(path, 'Data.bin'), format === 'cue' ? psxDisc() : track('T-12345N'));
  await writeFile(join(path, 'Game.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  const root = f.catalog.createContentRoot({
    path,
    label: 'Generated',
    libraryId: f.library.id,
    actorId: f.owner.id,
  });
  const scan = await f.app.inject({
    method: 'POST',
    url: `/api/v1/roots/${root.id}/scan`,
    headers: f.auth,
  });
  assert.equal(scan.statusCode, 200, scan.body);
  const source = f.catalog
    .listSources(root.id)
    .find((file) => file.displayName === `Game.${format}`);
  assert.ok(source);
  assert.equal(source.groupMembers?.length, format === 'cue' ? 2 : 4);
  const request = () =>
    f.app.inject({
      method: 'POST',
      url: `/api/v1/sources/${source.id}/matches`,
      headers: f.auth,
      payload: { checksum: true, providerIds: ['test.disc.provider'] },
    });
  return {
    ...f,
    root,
    source,
    path,
    track,
    request,
    dispose: async () => {
      await f.dispose();
      await rm(plugins, { recursive: true, force: true });
    },
  };
}
for (const format of ['cue', 'gdi'] as const)
  test(`${format} disc facts find verified metadata and front artwork without overwriting a saved choice`, async () => {
    const f = await fixture(format);
    try {
      const response = await f.request();
      assert.equal(response.statusCode, 200, response.body);
      const metadata = response
        .json()
        .candidates.find((c: { kind: string }) => c.kind === 'metadata');
      assert.ok(metadata);
      assert.equal(metadata.metadata.matchEvidence, 'verified-serial');
      const saved = await f.app.inject({
        method: 'PUT',
        url: `/api/v1/sources/${f.source.id}/matches/selections`,
        headers: f.auth,
        payload: {
          requestId: response.json().requestId,
          candidateId: metadata.id,
          expectedRevision: 0,
        },
      });
      assert.equal(saved.statusCode, 200, saved.body);
      const before = f.catalog
        .sourceMatches(f.source.id)
        .matches.find((m) => m.kind === 'metadata');
      assert.ok(before);
      const created = await f.app.inject({
        method: 'POST',
        url: '/api/v1/library-jobs',
        headers: f.auth,
        payload: {
          kind: 'match',
          rootId: f.root.id,
          options: { checksum: true, providerIds: ['test.disc.provider'] },
        },
      });
      assert.equal(created.statusCode, 202, created.body);
      const id = created.json().job.id,
        deadline = Date.now() + 10000;
      while (['queued', 'running'].includes(f.catalog.libraryJobs.get(id)?.state ?? '')) {
        assert.ok(Date.now() < deadline);
        await pause(5);
      }
      assert.equal(f.catalog.libraryJobs.get(id)?.failed, 0);
      assert.equal(f.catalog.libraryJobs.get(id)?.saved, 1);
      const after = f.catalog.sourceMatches(f.source.id).matches;
      assert.deepEqual(
        after.find((m) => m.kind === 'metadata'),
        before,
      );
      assert.ok(after.some((m) => m.kind === 'artwork' && m.artworkRole === 'front'));
    } finally {
      await f.dispose();
    }
  });
for (const problem of ['missing', 'escaped'] as const)
  test(`${problem} disc member cannot reuse cached facts or write an older proposal`, async () => {
    const f = await fixture();
    try {
      const first = await f.request();
      assert.equal(first.statusCode, 200, first.body);
      const candidate = first
        .json()
        .candidates.find((row: { kind: string }) => row.kind === 'metadata');
      assert.ok(candidate);
      await rm(join(f.path, 'Data.bin'));
      if (problem === 'escaped') {
        const outside = join(f.base, 'outside.bin');
        await writeFile(outside, f.track('T-12345N'));
        await symlink(outside, join(f.path, 'Data.bin'));
      }
      const next = await f.request();
      assert.notEqual(next.statusCode, 200, next.body);
      assert.ok(!next.body.includes(f.base));
      const stale = await f.app.inject({
        method: 'PUT',
        url: `/api/v1/sources/${f.source.id}/matches/selections`,
        headers: f.auth,
        payload: {
          requestId: first.json().requestId,
          candidateId: candidate.id,
          expectedRevision: 0,
        },
      });
      assert.notEqual(stale.statusCode, 200, stale.body);
      assert.equal(f.catalog.sourceMatches(f.source.id).matches.length, 0);
    } finally {
      await f.dispose();
    }
  });
test('changing a saved system cannot reuse old-system disc facts or hide the resulting review', async () => {
  const f = await fixture();
  try {
    const first = await f.request();
    assert.equal(first.statusCode, 200, first.body);
    const candidate = first
      .json()
      .candidates.find((row: { kind: string }) => row.kind === 'metadata');
    assert.ok(candidate);
    const saved = f.catalog.saveSourceMatch(
      f.source.id,
      0,
      'metadata',
      {
        ...candidate,
        id: 'keep-my-choice',
        metadata: { ...candidate.metadata, systemId: 'com.provenance.psx' },
        originKind: null,
        contentAvailable: false,
        contentType: null,
        fileName: null,
        updatedAt: new Date().toISOString(),
      },
      null,
      f.owner.id,
    );
    await rm(join(f.path, 'Game.png'));
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${f.root.id}/scan`, headers: f.auth });
    assert.equal(f.catalog.getSource(f.source.id)?.systemId, 'com.provenance.psx');
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/v1/library-jobs',
      headers: f.auth,
      payload: {
        kind: 'match',
        rootId: f.root.id,
        options: { checksum: true, providerIds: ['test.disc.provider'] },
      },
    });
    assert.equal(created.statusCode, 202, created.body);
    const id = created.json().job.id,
      deadline = Date.now() + 10000;
    while (['queued', 'running'].includes(f.catalog.libraryJobs.get(id)?.state ?? '')) {
      assert.ok(Date.now() < deadline);
      await pause(5);
    }
    assert.equal(f.catalog.libraryJobs.get(id)?.review, 1);
    assert.match(f.catalog.libraryJobs.items(id, 1)[0]?.error ?? '', /disagrees with this system/);
    assert.deepEqual(f.catalog.sourceMatches(f.source.id), saved);
  } finally {
    await f.dispose();
  }
});
test('a track change invalidates cached disc facts and rejects an older proposal before writing', async () => {
  const f = await fixture();
  try {
    let cacheHits = 0;
    const lookup = f.catalog.matchingIdentification.bind(f.catalog);
    f.catalog.matchingIdentification = (id, stamp) => {
      const found = lookup(id, stamp);
      if (found) cacheHits++;
      return found;
    };
    const first = await f.request();
    assert.equal(first.statusCode, 200, first.body);
    const again = await f.request();
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(cacheHits, 1);
    const metadata = first.json().candidates.find((c: { kind: string }) => c.kind === 'metadata');
    assert.ok(metadata);
    await writeFile(join(f.path, 'Data.bin'), f.track('T-54321N'));
    const stale = await f.app.inject({
      method: 'PUT',
      url: `/api/v1/sources/${f.source.id}/matches/selections`,
      headers: f.auth,
      payload: { requestId: first.json().requestId, candidateId: metadata.id, expectedRevision: 0 },
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(f.catalog.sourceMatches(f.source.id).matches.length, 0);
    const fresh = await f.request();
    assert.equal(fresh.statusCode, 200, fresh.body);
    assert.equal(cacheHits, 1);
    const candidate = fresh.json().candidates.find((c: { kind: string }) => c.kind === 'metadata');
    assert.ok(candidate);
    assert.deepEqual(JSON.parse(candidate.metadata.serials), ['T-54321N']);
  } finally {
    await f.dispose();
  }
});
