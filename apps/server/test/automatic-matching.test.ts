import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import Fastify from 'fastify';
import type { ServerContext } from '../src/context.js';
import { registerLibraryJobs } from '../src/library-jobs.js';
import { libraryFixture } from './library-fixture.js';

async function fixture(automaticMatching = false, alternatives = false, coverAlternatives = false) {
  const plugins = await mkdtemp(join(tmpdir(), 'ecs-autofill-'));
  for (const id of ['test.fill', 'test.unavailable']) {
    const path = join(plugins, id);
    await mkdir(path);
    await writeFile(
      join(path, 'plugin.json'),
      JSON.stringify({
        id,
        name: id,
        kind: 'provider',
        version: '1',
        engine: 'ecs.plugin/1',
        entry: 'entry.mjs',
        provider: { capabilities: ['metadata', 'artwork'], network: true },
      }),
    );
    await writeFile(
      join(path, 'entry.mjs'),
      id === 'test.unavailable'
        ? "export default {search:async()=>{throw new Error('Generated provider outage')}};"
        : `export default {search:async input=>{if(!input.online||!input.md5)throw new Error('Expected online lookup with verified hashing');const metadata={md5:input.md5,hashSize:String(input.size),hashRepresentation:'raw',systemId:input.systemId};const candidates=[{id:'verified',kind:'metadata',title:'Verified game',confidence:'checksum',metadata}];if(${alternatives})candidates.push({id:'alternative',kind:'metadata',title:'Different game',confidence:'checksum',metadata});else {const file=input.companions.find(file=>file.name.endsWith('.png'));if(file)candidates.push({id:'cover',kind:'artwork',title:'Verified game',confidence:'checksum',fileId:file.id,metadata:{...metadata,artworkRole:'front'}});}return candidates;}};`,
    );
  }
  if (coverAlternatives) {
    await writeFile(
      join(plugins, 'test.fill', 'entry.mjs'),
      `export default {search:async input=>{const file=input.companions.find(f=>f.name.endsWith('.png'));return [{id:'game',kind:'metadata',title:'Verified game (USA)',confidence:'checksum',metadata:{md5:input.md5,hashSize:String(input.size),hashRepresentation:'raw',systemId:input.systemId}},...['Verified game (Europe) (Rev 2)','Verified game (Europe)'].map((title,i)=>({id:'cover-'+i,kind:'artwork',title,confidence:'name',fileId:file.id,metadata:{systemId:input.systemId,artworkRole:'front',artworkReviewRequired:'true'}}))];}};`,
    );
  }
  const f = await libraryFixture({ matchingPluginsDir: plugins, automaticMatching });
  const path = join(f.base, 'NES');
  await mkdir(path);
  await writeFile(join(path, 'Game.nes'), Buffer.from([1, 2, 3, 4]));
  await writeFile(join(path, 'Game.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  const root = f.catalog.createContentRoot({
    path,
    label: 'Games',
    libraryId: f.library.id,
    actorId: f.owner.id,
  });
  return {
    ...f,
    matchingPluginsDir: plugins,
    root,
    async dispose() {
      await f.dispose();
      await rm(plugins, { recursive: true, force: true });
    },
  };
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Automatic matching did not finish');
    await pause(10);
  }
}

test('a known game automatically uses a cover even when multiple scans have different editions', async () => {
  const f = await fixture(false, false, true);
  try {
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${f.root.id}/scan`, headers: f.auth });
    const source = f.catalog.listSources(f.root.id).find((file) => file.kind === 'rom');
    assert.ok(source);
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/sources/${source.id}/matches`,
      headers: f.auth,
      payload: { online: true, checksum: true, autoSave: true, providerIds: ['test.fill'] },
    });
    assert.equal(response.statusCode, 200, response.body);
    const cover = f.catalog
      .sourceMatches(source.id)
      .matches.find((match) => match.kind === 'artwork');
    assert.ok(cover, response.body);
    assert.equal(cover.title, 'Verified game (Europe)');
    assert.equal(cover.contentAvailable, true);
  } finally {
    await f.dispose();
  }
});

test('automatic filling chooses the best name when no catalog hash matches and fills its cover', async () => {
  const f = await fixture();
  try {
    const entry = join(f.matchingPluginsDir ?? '', 'test.fill', 'entry.mjs');
    await writeFile(
      entry,
      `export default {search:async input=>{const file=input.companions.find(f=>f.name.endsWith('.png'));return ['Game (USA)','Game (Europe)'].map((title,i)=>({id:'name-'+i,kind:'metadata',title,confidence:'name',metadata:{systemId:input.systemId,md5:'ffffffffffffffffffffffffffffffff',hashSize:String(input.size)}})).concat([{id:'cover',kind:'artwork',title:'Game (USA)',confidence:'name',fileId:file.id,metadata:{systemId:input.systemId,artworkRole:'front'}}]);}};`,
    );
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${f.root.id}/scan`, headers: f.auth });
    const source = f.catalog.listSources(f.root.id).find((file) => file.kind === 'rom');
    assert.ok(source);
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/sources/${source.id}/matches`,
      headers: f.auth,
      payload: {
        online: true,
        checksum: true,
        allowExactNames: true,
        autoSave: true,
        providerIds: ['test.fill'],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const saved = f.catalog.sourceMatches(source.id).matches;
    assert.ok(
      saved.some((match) => match.kind === 'metadata'),
      response.body,
    );
    assert.ok(
      saved.some((match) => match.kind === 'artwork' && match.contentAvailable),
      response.body,
    );
  } finally {
    await f.dispose();
  }
});

test('single-game automatic search saves unique verified metadata and cover despite another provider outage', async () => {
  const f = await fixture();
  try {
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${f.root.id}/scan`, headers: f.auth });
    const source = f.catalog.listSources(f.root.id).find((file) => file.kind === 'rom');
    assert.ok(source);
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/sources/${source.id}/matches`,
      headers: f.auth,
      payload: {
        online: true,
        checksum: true,
        autoSave: true,
        providerIds: ['test.fill', 'test.unavailable'],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().automatic?.saved, 2);
    assert.equal(response.json().automatic?.status, 'saved');
    assert.deepEqual(
      f.catalog
        .sourceMatches(source.id)
        .matches.map((match) => match.kind)
        .sort(),
      ['artwork', 'metadata'],
    );
    assert.ok(response.json().problems.length);
    assert.equal(
      f.catalog.sourceMatches(source.id).matches.find((match) => match.kind === 'artwork')
        ?.contentAvailable,
      true,
    );
  } finally {
    await f.dispose();
  }
});

test('automatic search retains alternatives with conflicting verified identities for review', async () => {
  const f = await fixture(false, true);
  try {
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${f.root.id}/scan`, headers: f.auth });
    const source = f.catalog.listSources(f.root.id).find((file) => file.kind === 'rom');
    assert.ok(source);
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/sources/${source.id}/matches`,
      headers: f.auth,
      payload: {
        online: true,
        checksum: true,
        autoSave: true,
        providerIds: ['test.fill', 'test.unavailable'],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().automatic?.saved, 0);
    assert.equal(f.catalog.sourceMatches(source.id).matches.length, 0);
    assert.equal(response.json().automatic?.status, 'review');
  } finally {
    await f.dispose();
  }
});

test('a folder scan fills metadata and artwork automatically using online sources and skips repeated unchanged scans', async () => {
  const f = await fixture();
  const worker = Fastify();
  registerLibraryJobs(worker, { catalog: f.catalog, automaticMatching: true } as ServerContext, {
    async autoMatch(_actor, sourceId, options) {
      assert.equal(options.online, true);
      assert.equal(options.checksum, true);
      assert.equal(options.providerIds, undefined);
      for (const kind of ['metadata', 'artwork'] as const) {
        const current = f.catalog.sourceMatches(sourceId);
        f.catalog.saveSourceMatch(
          sourceId,
          current.revision,
          kind,
          {
            id: kind,
            providerId: 'test.fill',
            kind,
            title: 'Generated game',
            confidence: 'checksum',
            metadata: {},
            originKind: null,
            contentAvailable: false,
            contentType: null,
            fileName: null,
            updatedAt: new Date().toISOString(),
          },
          null,
          f.owner.id,
        );
      }
      return { status: 'saved', saved: 2, suggestions: 0, error: null };
    },
  });
  await worker.ready();
  try {
    const scan = () =>
      f.app.inject({ method: 'POST', url: `/api/v1/roots/${f.root.id}/scan`, headers: f.auth });
    assert.equal((await scan()).statusCode, 200);
    const source = f.catalog.listSources(f.root.id).find((file) => file.kind === 'rom');
    assert.ok(source);
    await waitFor(() => f.catalog.sourceMatches(source.id).matches.length === 2);
    const jobs = f.catalog.libraryJobs.list(100).filter((job) => job.kind === 'match');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.options.online, true);
    assert.equal(jobs[0]?.options.checksum, true);
    assert.equal(jobs[0]?.options.providerIds, undefined);
    assert.equal((await scan()).statusCode, 200);
    assert.equal(f.catalog.libraryJobs.list(100).filter((job) => job.kind === 'match').length, 1);
  } finally {
    await worker.close();
    await f.dispose();
  }
});

test('automatic matching saves all local artwork roles before an enabled organization rule moves the game', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root.path, 'Game.json'), JSON.stringify({ title: 'Local game' }));
    await writeFile(
      join(f.root.path, 'Game [back].png'),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    );
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${f.root.id}/scan`, headers: f.auth });
    const source = f.catalog.listSources(f.root.id).find((file) => file.kind === 'rom');
    assert.ok(source);
    const target = join(f.base, 'organized');
    await mkdir(target);
    const root = f.catalog.createContentRoot({
      path: target,
      label: 'Organized',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    f.catalog.setSourceOrganizationPolicy({
      sourceRootId: f.root.id,
      targetRootId: root.id,
      libraryId: f.library.id,
      sourceRootPath: f.root.path,
      targetRootPath: root.path,
      mode: 'move',
      enabledBy: f.owner.id,
      enabledAt: new Date().toISOString(),
    });
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/sources/${source.id}/matches`,
      headers: f.auth,
      payload: {
        online: false,
        checksum: true,
        allowExactNames: true,
        autoSave: true,
        providerIds: ['org.ecs.local'],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().automatic.saved, 3);
    assert.equal(f.catalog.getSource(source.id)?.rootId, root.id);
    const matches = f.catalog.sourceMatches(source.id).matches;
    assert.equal(
      matches.filter((match) => match.kind === 'artwork' && match.contentAvailable).length,
      2,
    );
    assert.ok(matches.some((match) => match.artworkRole === 'back'));
  } finally {
    await f.dispose();
  }
});

test('concurrent automatic searches share their writes and preserve a single selection revision', async () => {
  const f = await fixture();
  try {
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${f.root.id}/scan`, headers: f.auth });
    const source = f.catalog.listSources(f.root.id).find((file) => file.kind === 'rom');
    assert.ok(source);
    const request = () =>
      f.app.inject({
        method: 'POST',
        url: `/api/v1/sources/${source.id}/matches`,
        headers: f.auth,
        payload: {
          online: true,
          checksum: true,
          autoSave: true,
          providerIds: ['test.fill', 'test.unavailable'],
        },
      });
    const responses = await Promise.all([request(), request()]);
    for (const response of responses) assert.equal(response.statusCode, 200, response.body);
    assert.equal(f.catalog.sourceMatches(source.id).revision, 2);
    assert.equal(f.catalog.sourceMatches(source.id).matches.length, 2);
  } finally {
    await f.dispose();
  }
});
