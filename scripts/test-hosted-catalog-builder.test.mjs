import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  validateHostedCatalogIndex,
  validateHostedCatalogShard,
} from '../packages/plugins/dist/src/hosted-catalog.js';
import { patchFingerprint } from '../packages/plugins/dist/src/matching.js';
import { buildCatalog } from './build-hosted-catalog.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const baseSource = {
  id: 'fixture-dat',
  name: 'Generated test DAT',
  path: 'metadat',
  license: 'CC0-1.0 generated test facts',
  notice: 'Synthetic fixture only.',
};
const flycastFixture = Buffer.from(
  'const Game Games[] = { { "neshort", nullptr, "Example Naomi (Export)", 0, 0, "naomi", M1, ROT0, {}, "gds-1234" }, };',
);
const noPatchFetch = async (url) => {
  assert.match(url, /\/src\.cpp$/);
  return new Response(flycastFixture);
};
function config() {
  return {
    libretro: {
      repository: 'https://github.com/libretro/libretro-database',
      revision: 'a'.repeat(40),
      sources: [
        baseSource,
        {
          id: 'libretro-cheats',
          name: 'Generated test CHT',
          path: 'cht',
          license: 'CC0-1.0 generated test facts',
          notice: 'Synthetic fixture only.',
        },
      ],
      metadataFiles: [
        {
          path: 'metadat/test.dat',
          systemId: 'com.provenance.nes',
          sourceId: 'fixture-dat',
        },
      ],
      cheatFolders: [{ path: 'cht/NES', systemId: 'com.provenance.nes' }],
    },
    flycast: {
      repository: 'https://github.com/example/flycast',
      revision: 'b'.repeat(40),
      path: 'src.cpp',
      sourceId: 'flycast-test',
      sourceName: 'Generated test Flycast catalog',
      license: 'CC0-1.0 generated test facts',
      notice: 'Synthetic fixture only.',
      bytes: flycastFixture.length,
      sha256: digest(flycastFixture),
    },
    patches: [],
  };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ecs-hosted-catalog-builder-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'metadat'), { recursive: true });
  await mkdir(join(root, 'cht', 'NES'), { recursive: true });
  await writeFile(
    join(root, 'metadat', 'test.dat'),
    `clrmamepro ( name "test" )\ngame ( name "Demo A" serial "ABC123" rom ( name "Demo A.nes" size 4 crc 1234ABCD ) )\ngame ( name "Demo B" rom ( name "Demo B.nes" size 8 crc 5678EF01 ) )`,
  );
  await writeFile(
    join(root, 'cht', 'NES', 'Demo A.cht'),
    'cheats = "1"\ncheat0_code = "0000:01"\ncheat0_enable = "false"\n',
  );
  return root;
}

const smallLimits = { index: 256 * 1024, shard: 700, cheats: 256 * 1024, patch: 2 * 1024 * 1024 };

test('builder emits reproducible pinned metadata/cheat shards with bounded sizes and provenance', async (t) => {
  const sourceRoot = await fixture(t);
  const first = await buildCatalog({
    sourceRoot,
    config: config(),
    release: 'catalog-test-1',
    fetcher: noPatchFetch,
    limits: smallLimits,
  });
  const second = await buildCatalog({
    sourceRoot,
    config: config(),
    release: 'catalog-test-1',
    fetcher: noPatchFetch,
    limits: smallLimits,
  });
  assert.deepEqual([...first.assets.keys()], [...second.assets.keys()]);
  for (const [name, bytes] of first.assets) assert.deepEqual(bytes, second.assets.get(name), name);
  assert.equal(first.summary.metadataRecords, 3);
  assert.equal(first.summary.cheatRecords, 1);
  assert.ok(first.indexBytes.byteLength <= smallLimits.index);
  assert.equal(
    validateHostedCatalogIndex(JSON.parse(first.indexBytes.toString())).release,
    'catalog-test-1',
  );
  for (const descriptor of first.index.shards) {
    const bytes = first.assets.get(descriptor.url.split('/').at(-1));
    assert.ok(bytes);
    assert.ok(bytes.byteLength <= smallLimits.shard);
    assert.equal(digest(bytes), descriptor.sha256);
    const shard = validateHostedCatalogShard(JSON.parse(bytes.toString()), descriptor, first.index);
    assert.equal(shard.records.length, descriptor.records);
    for (const record of shard.records) {
      assert.ok(record.sourceIds.length > 0);
      if (descriptor.kind === 'cheats') {
        assert.equal(record.resource?.format, 'retroarch-cht');
        assert.match(
          record.resource?.url ?? '',
          /raw\.githubusercontent\.com\/libretro\/libretro-database\//,
        );
      }
    }
  }
  const metadata = first.index.shards
    .filter((shard) => shard.kind === 'metadata')
    .flatMap(
      (shard) => JSON.parse(first.assets.get(shard.url.split('/').at(-1)).toString()).records,
    );
  assert.ok(metadata.some((record) => record.serials?.includes('ABC123')));
  assert.ok(metadata.some((record) => record.serials?.includes('gds-1234')));
  assert.equal(first.assets.has('SOURCES.md'), true);
  assert.equal(first.assets.has('EXCLUDED.json'), true);
  assert.match(first.assets.get('SOURCES.md').toString(), /Synthetic fixture only/);
});

test('builder excludes cheat resources above hosted size cap and reports exact source facts', async (t) => {
  const sourceRoot = await fixture(t);
  await writeFile(join(sourceRoot, 'cht', 'NES', 'Oversized.cht'), 'x'.repeat(301));
  const built = await buildCatalog({
    sourceRoot,
    config: config(),
    release: 'catalog-test-2',
    fetcher: noPatchFetch,
    limits: { ...smallLimits, cheats: 300 },
  });
  assert.equal(built.summary.excludedResources, 1);
  const excluded = JSON.parse(built.assets.get('EXCLUDED.json').toString());
  assert.deepEqual(excluded.excludedResources, [
    { path: 'cht/NES/Oversized.cht', bytes: 301, reason: 'exceeds 300 byte hosted cheat limit' },
  ]);
  assert.equal(built.summary.cheatRecords, 1);
});

test('builder verifies pinned patch bytes and BPS base size/CRC without releasing patch bytes', async (t) => {
  const sourceRoot = await fixture(t);
  const patchBytes = Buffer.concat([
    Buffer.from('BPS1'),
    Buffer.from([0x84, 0x85, 0x80]),
    Buffer.alloc(12),
  ]);
  patchBytes.writeUInt32LE(0x1234abcd, patchBytes.length - 12);
  patchBytes.writeUInt32LE(
    (await import('node:zlib')).crc32(patchBytes.subarray(0, -4)),
    patchBytes.length - 4,
  );
  const hash = digest(patchBytes);
  const patchConfig = {
    sourceId: 'patch-fixture',
    sourceName: 'Generated test patch',
    repositoryUrl: 'https://github.com/example/repo',
    license: 'CC0-1.0 generated test patch',
    notice: 'Generated fixture only.',
    sourceCommit: 'b'.repeat(40),
    path: 'demo.bps',
    systemId: 'com.provenance.nes',
    title: 'Demo translation patch',
    patchType: 'translation',
    licenseMetadata: 'CC0-1.0',
    sha256: hash,
    bytes: patchBytes.byteLength,
    sourceSize: 4,
    sourceCrc32: '1234abcd',
  };
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/src.cpp')) return new Response(flycastFixture);
    assert.equal(url, `https://raw.githubusercontent.com/example/repo/${'b'.repeat(40)}/demo.bps`);
    return new Response(patchBytes);
  };
  const built = await buildCatalog({
    sourceRoot,
    config: { ...config(), patches: [patchConfig] },
    release: 'catalog-test-patch',
    fetcher,
    limits: smallLimits,
  });
  const patchShard = built.index.shards.find((shard) => shard.kind === 'patch');
  const patchRecord = JSON.parse(built.assets.get(patchShard.url.split('/').at(-1)).toString())
    .records[0];
  assert.deepEqual(patchFingerprint(patchBytes), {
    format: 'bps',
    sourceSize: 4,
    sourceCrc32: '1234abcd',
  });
  assert.deepEqual(patchRecord.resource, {
    url: `https://raw.githubusercontent.com/example/repo/${'b'.repeat(40)}/demo.bps`,
    sha256: hash,
    bytes: patchBytes.byteLength,
    format: 'bps',
  });
  assert.ok(![...built.assets.values()].some((bytes) => bytes.equals(patchBytes)));
  await assert.rejects(
    buildCatalog({
      sourceRoot,
      config: { ...config(), patches: [{ ...patchConfig, sha256: '0'.repeat(64) }] },
      release: 'catalog-test-bad-patch',
      fetcher,
      limits: smallLimits,
    }),
    /identity mismatch/,
  );
});
