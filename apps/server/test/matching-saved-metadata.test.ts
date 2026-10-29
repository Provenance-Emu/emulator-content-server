import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { libraryFixture } from './library-fixture.js';

async function fixture() {
  const plugins = await mkdtemp(join(tmpdir(), 'ecs-selected-art-'));
  await mkdir(join(plugins, 'provider'));
  await writeFile(
    join(plugins, 'provider', 'plugin.json'),
    JSON.stringify({
      id: 'test.selected.art',
      name: 'Generated selected artwork',
      kind: 'provider',
      version: '1',
      engine: 'ecs.plugin/1',
      entry: 'entry.mjs',
      provider: { capabilities: ['metadata', 'artwork'], network: false },
    }),
  );
  await writeFile(
    join(plugins, 'provider', 'entry.mjs'),
    `export default {search:async input=>{const result=[{id:'meta',kind:'metadata',title:'Generated game',confidence:'checksum',metadata:{md5:input.md5,hashSize:String(input.size),systemId:input.systemId,title:'Generated game',matchEvidence:'verified-hash'}}];const selected=input.selectedMetadata;const file=input.companions.find(row=>row.name.endsWith('.png'));if(selected&&file)result.push({id:'front',kind:'artwork',title:selected.title,confidence:'local',fileId:file.id,metadata:{artworkRole:'front',systemId:selected.systemId,matchedGame:selected.title,savedMetadataId:selected.id,savedMetadataRevision:String(selected.revision),matchEvidence:'saved-selection'}});return result}};`,
  );
  const f = await libraryFixture({ matchingPluginsDir: plugins });
  const path = join(f.base, 'games');
  await mkdir(path);
  await writeFile(join(path, 'Game.nes'), Buffer.from([1, 2, 3, 4]));
  await writeFile(join(path, 'Game.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  const root = f.catalog.createContentRoot({
    path,
    label: 'Generated',
    libraryId: f.library.id,
    actorId: f.owner.id,
  });
  await f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
  const source = f.catalog.listSources(root.id).find((s) => s.displayName === 'Game.nes');
  assert.ok(source);
  return {
    ...f,
    root,
    source,
    dispose: async () => {
      await f.dispose();
      await rm(plugins, { recursive: true, force: true });
    },
  };
}
test('shared matching saves verified metadata, rematches its private selection, and adds its front cover in the same job', async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/v1/library-jobs',
      headers: f.auth,
      payload: {
        kind: 'match',
        rootId: f.root.id,
        options: { checksum: true, providerIds: ['test.selected.art'] },
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
    assert.equal(f.catalog.libraryJobs.get(id)?.saved, 2);
    assert.deepEqual(
      f.catalog
        .sourceMatches(f.source.id)
        .matches.map((m) => m.kind)
        .sort(),
      ['artwork', 'metadata'],
    );
  } finally {
    await f.dispose();
  }
});
test('a front-cover proposal tied to an old saved metadata choice is rejected after that choice changes', async () => {
  const f = await fixture();
  try {
    const request = () =>
      f.app.inject({
        method: 'POST',
        url: `/api/v1/sources/${f.source.id}/matches`,
        headers: f.auth,
        payload: { checksum: true, providerIds: ['test.selected.art'] },
      });
    const first = (await request()).json();
    const meta = first.candidates.find((c: { kind: string }) => c.kind === 'metadata');
    assert.ok(meta);
    const saved = await f.app.inject({
      method: 'PUT',
      url: `/api/v1/sources/${f.source.id}/matches/selections`,
      headers: f.auth,
      payload: { requestId: first.requestId, candidateId: meta.id, expectedRevision: 0 },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const next = (await request()).json();
    const art = next.candidates.find((c: { kind: string }) => c.kind === 'artwork');
    assert.ok(art);
    const before = f.catalog.sourceMatches(f.source.id);
    f.catalog.saveSourceMatch(f.source.id, before.revision, 'metadata', null, null, f.owner.id);
    const changed = f.catalog.sourceMatches(f.source.id);
    const response = await f.app.inject({
      method: 'PUT',
      url: `/api/v1/sources/${f.source.id}/matches/selections`,
      headers: f.auth,
      payload: {
        requestId: next.requestId,
        candidateId: art.id,
        expectedRevision: changed.revision,
      },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(f.catalog.sourceMatches(f.source.id).matches.length, 0);
  } finally {
    await f.dispose();
  }
});
