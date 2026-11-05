import assert from 'node:assert/strict';
import test from 'node:test';
import { playerCatalog } from '../src/player-catalog.js';
import { parsePlayerCatalogSnapshot } from '../src/player-catalog-file.js';
import {
  createPlayerCatalogSnapshot,
  playerCatalogEntryId,
} from '../src/player-catalog-snapshot.js';
import { upstreamFixture } from './player-cache-fixture.js';

test('published source-built packages retain matching pinned source, notice and build receipts', () => {
  for (const id of [
    'prosystem',
    'stella2014',
    'freeintv',
    'atari800',
    'pokemini',
    'potator',
    'sameduck',
    'mednafen-pcfx',
  ]) {
    const entry = playerCatalog.find((entry) => entry.id === `org.libretro.${id}`);
    assert.ok(entry?.provenance);
    assert.equal(entry.provenance.sourceMapping, 'release-receipt');
    assert.ok(entry.provenance.license);
    const artifacts = entry.provenance.artifacts ?? [];
    assert.deepEqual(artifacts.map((artifact) => artifact.kind).sort(), [
      'build',
      'notices',
      'source',
    ]);
    for (const artifact of artifacts) {
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
      assert.ok(artifact.sizeBytes > 0);
      assert.equal(new URL(artifact.url).origin, 'https://github.com');
      assert.equal(
        artifact.url.slice(0, artifact.url.lastIndexOf('/')),
        entry.url?.slice(0, entry.url.lastIndexOf('/')),
      );
    }
    const build = artifacts.find((artifact) => artifact.kind === 'build');
    assert.equal(build?.url, entry.provenance.sourceInfo);
    assert.equal(build?.sha256, entry.provenance.infoSha256);
  }
});

test('legacy packages and official pairs do not invent a verified source mapping', () => {
  const fceumm = playerCatalog.find((entry) => entry.id === 'org.libretro.fceumm');
  const jaguar = playerCatalog.find((entry) => entry.id === 'org.libretro.virtualjaguar');
  assert.equal(fceumm?.provenance?.sourceMapping, 'unverified');
  assert.ok(fceumm?.provenance);
  assert.equal(
    fceumm.provenance.artifacts?.find((artifact) => artifact.kind === 'source')?.sha256,
    '690b662a4d3466d7f8a626f752425c81629bb324d14cac10f67f48dba08f3fff',
  );
  assert.equal(jaguar?.provenance?.sourceMapping, 'unverified');
  assert.ok(jaguar?.provenance);
  assert.deepEqual(jaguar.provenance.artifacts, []);
  for (const entry of playerCatalog.filter((entry) => entry.upstream))
    assert.notEqual(entry.provenance?.sourceMapping, 'release-receipt');
});

function enriched() {
  const entry = upstreamFixture().entry;
  entry.provenance = {
    sourceInfo: 'https://example.com/build.json',
    infoSha256: 'a'.repeat(64),
    license: 'Generated fixture',
    sourceMapping: 'release-receipt',
    artifacts: ['source', 'notices', 'build'].map((kind) => ({
      kind: kind as 'source' | 'notices' | 'build',
      url: `https://example.com/${kind === 'build' ? 'build.json' : kind}`,
      sha256: 'a'.repeat(64),
      sizeBytes: 10,
    })),
  };
  return entry;
}

test('snapshot identities retain provenance artifact pins while old snapshots stay readable', () => {
  const entry = enriched();
  const snapshot = createPlayerCatalogSnapshot([entry]);
  assert.deepEqual(parsePlayerCatalogSnapshot(snapshot, snapshot.id), snapshot);
  const changed = structuredClone(entry);
  const artifact = changed.provenance?.artifacts?.[0];
  assert.ok(artifact);
  artifact.sha256 = 'b'.repeat(64);
  assert.notEqual(playerCatalogEntryId(entry), playerCatalogEntryId(changed));
  const old = createPlayerCatalogSnapshot([upstreamFixture().entry]);
  assert.equal(parsePlayerCatalogSnapshot(old, old.id).id, old.id);
});

for (const mode of [
  'kind',
  'kind-array',
  'mapping-array',
  'hash',
  'size',
  'credentials',
  'http',
  'unknown',
  'incomplete',
  'duplicate',
] as const) {
  test(`provenance rejects invalid ${mode} metadata without downloading anything`, (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      throw new Error('No metadata fetch');
    });
    const entry = enriched();
    const provenance = entry.provenance;
    const artifact = provenance?.artifacts?.[0];
    assert.ok(provenance && artifact);
    if (mode === 'kind') Object.assign(artifact, { kind: 'executable' });
    if (mode === 'kind-array') {
      provenance.sourceMapping = 'unverified';
      Object.assign(artifact, { kind: ['source'] });
    }
    if (mode === 'mapping-array') Object.assign(provenance, { sourceMapping: ['unverified'] });
    if (mode === 'hash') artifact.sha256 = 'bad';
    if (mode === 'size') artifact.sizeBytes = 0;
    if (mode === 'credentials') artifact.url = 'https://generated-secret@example.com/source';
    if (mode === 'http') artifact.url = 'http://example.com/source';
    if (mode === 'unknown') Object.assign(artifact, { ignored: true });
    if (mode === 'incomplete') provenance.artifacts = [artifact];
    if (mode === 'duplicate') provenance.artifacts?.push({ ...artifact });
    const snapshot = createPlayerCatalogSnapshot([entry]);
    assert.throws(() => parsePlayerCatalogSnapshot(snapshot, snapshot.id), /snapshot/i);
    assert.equal(calls, 0);
  });
}
