import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parsePlayerPackage } from '@ecs/plugins';
import { PlayerPackageCache } from '../src/player-cache.js';
import { parsePlayerCatalogSnapshot } from '../src/player-catalog-file.js';
import {
  createPlayerCatalogSnapshot,
  playerCatalogEntryId,
} from '../src/player-catalog-snapshot.js';
import { downloadCatalogPlayer } from '../src/player-download.js';
import { upstreamFixture } from './player-cache-fixture.js';

async function fixture(t: TestContext, maxBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), 'ecs-player-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'cache');
  return { root, directory, cache: new PlayerPackageCache(directory, maxBytes) };
}

function online(t: TestContext, revision = 1) {
  const generated = upstreamFixture(revision);
  let calls = 0;
  const mocked = t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls++;
    return new Response(url.endsWith('.wasm') ? generated.wasm : generated.loader);
  });
  return { ...generated, mocked, calls: () => calls };
}

function offline(t: TestContext) {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('offline');
  });
}

test('complete cache survives restart and reuses exact bytes offline with a retained catalog receipt', async (t) => {
  const f = await fixture(t);
  const generated = online(t);
  const snapshot = createPlayerCatalogSnapshot([generated.entry]);
  const bytes = await f.cache.download(snapshot, generated.entry.id);
  assert.equal(generated.calls(), 2);
  const receipt = JSON.parse(
    await readFile(join(f.directory, `catalog-${snapshot.id}.json`), 'utf8'),
  );
  assert.deepEqual(receipt, snapshot);
  generated.mocked.mock.restore();
  offline(t);
  assert.deepEqual(
    await new PlayerPackageCache(f.directory).download(snapshot, generated.entry.id),
    bytes,
  );
});

test('published custom packages retain their whole-package hash and work offline too', async (t) => {
  const f = await fixture(t);
  const generated = online(t);
  const bytes = await downloadCatalogPlayer(generated.entry);
  generated.mocked.mock.restore();
  const packaged = structuredClone(generated.entry);
  delete packaged.upstream;
  packaged.url = 'https://github.com/example/generated/releases/download/v1/core.ecsplayer';
  packaged.sha256 = createHash('sha256').update(bytes).digest('hex');
  packaged.downloadBytes = bytes.length;
  const snapshot = createPlayerCatalogSnapshot([packaged]);
  const network = t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  assert.deepEqual(await f.cache.download(snapshot, packaged.id), bytes);
  network.mock.restore();
  offline(t);
  assert.deepEqual(
    await new PlayerPackageCache(f.directory).download(snapshot, packaged.id),
    bytes,
  );
});

test('unavailable upstream and changed bytes never publish a partial package or catalog', async (t) => {
  const f = await fixture(t);
  const { entry, loader } = upstreamFixture();
  const snapshot = createPlayerCatalogSnapshot([entry]);
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    url.endsWith('.js') ? new Response(loader) : new Response(null, { status: 404 }),
  );
  await assert.rejects(f.cache.download(snapshot, entry.id));
  assert.deepEqual(await readdir(f.directory), []);
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.alloc(loader.length)));
  await assert.rejects(f.cache.download(snapshot, entry.id));
  assert.deepEqual(await readdir(f.directory), []);
});

test('two revisions stay coherent and the old pair remains usable for offline rollback', async (t) => {
  const f = await fixture(t);
  const first = online(t);
  const a = createPlayerCatalogSnapshot([first.entry]);
  const original = await f.cache.download(a, first.entry.id);
  first.mocked.mock.restore();
  const second = online(t, 2);
  const b = createPlayerCatalogSnapshot([second.entry]);
  const updated = await f.cache.download(b, second.entry.id);
  second.mocked.mock.restore();
  offline(t);
  assert.notDeepEqual(original, updated);
  for (const [snapshot, expected, generated] of [
    [a, original, first],
    [b, updated, second],
  ] as const) {
    const bytes = await f.cache.download(snapshot, generated.entry.id);
    assert.deepEqual(bytes, expected);
    const parsed = parsePlayerPackage(bytes);
    assert.deepEqual(parsed.files.get('loader.js'), generated.loader);
    assert.deepEqual(parsed.files.get('core.wasm'), generated.wasm);
  }
});

for (const mode of ['corruption', 'manifest', 'symlink'] as const) {
  test(`offline cache rejects ${mode} even when a cache file exists`, async (t) => {
    const f = await fixture(t);
    const generated = online(t);
    const snapshot = createPlayerCatalogSnapshot([generated.entry]);
    const bytes = await f.cache.download(snapshot, generated.entry.id);
    generated.mocked.mock.restore();
    const path = join(f.directory, `player-${playerCatalogEntryId(generated.entry)}.ecsplayer`);
    if (mode === 'symlink') {
      const outside = join(f.root, 'outside');
      await writeFile(outside, bytes);
      await rm(path);
      await symlink(outside, path);
    } else if (mode === 'manifest') {
      const size = bytes.readUInt32BE(0);
      const header = JSON.parse(bytes.subarray(4, size + 4).toString());
      header.manifest.player.web.maxContentBytes++;
      const modified = Buffer.from(JSON.stringify(header));
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(modified.length);
      await writeFile(path, Buffer.concat([prefix, modified, bytes.subarray(size + 4)]));
    } else await writeFile(path, Buffer.alloc(bytes.length));
    offline(t);
    await assert.rejects(f.cache.download(snapshot, generated.entry.id));
  });
}

test('full cache skips new retention, preserves older snapshots and still permits verified online installs', async (t) => {
  const f = await fixture(t);
  const first = online(t);
  const a = createPlayerCatalogSnapshot([first.entry]);
  const original = await f.cache.download(a, first.entry.id);
  const names = await readdir(f.directory);
  first.mocked.mock.restore();
  const second = online(t, 2);
  const b = createPlayerCatalogSnapshot([second.entry]);
  assert.ok(await new PlayerPackageCache(f.directory, 1).download(b, second.entry.id));
  assert.deepEqual(await readdir(f.directory), names);
  second.mocked.mock.restore();
  offline(t);
  assert.deepEqual(await f.cache.download(a, first.entry.id), original);
  await assert.rejects(f.cache.download(b, second.entry.id));
});

test('concurrent cache requests publish one complete pair without temporary files', async (t) => {
  const f = await fixture(t);
  const generated = online(t);
  const snapshot = createPlayerCatalogSnapshot([generated.entry]);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => f.cache.download(snapshot, generated.entry.id)),
  );
  assert.equal(generated.calls(), 2);
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal((await readdir(f.directory)).length, 2);
});

test('a symlink cache root is never read or written, but a verified online install can proceed', async (t) => {
  const f = await fixture(t);
  const generated = online(t);
  const outside = await mkdtemp(join(tmpdir(), 'ecs-player-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, f.directory);
  assert.ok(
    await f.cache.download(createPlayerCatalogSnapshot([generated.entry]), generated.entry.id),
  );
  assert.deepEqual(await readdir(outside), []);
});

test('busy or failed cache writes preserve successful online installs and leave no partial package', async (t) => {
  const f = await fixture(t);
  const generated = online(t);
  const snapshot = createPlayerCatalogSnapshot([generated.entry]);
  await mkdir(f.directory);
  await mkdir(join(f.directory, '.write-lock'));
  assert.ok(await f.cache.download(snapshot, generated.entry.id));
  assert.deepEqual(await readdir(f.directory), ['.write-lock']);
  await rm(join(f.directory, '.write-lock'), { recursive: true });
  // A destination that cannot be written as a regular receipt must not be replaced.
  const receipt = `catalog-${snapshot.id}.json`;
  await mkdir(join(f.directory, receipt));
  assert.ok(await f.cache.download(snapshot, generated.entry.id));
  assert.deepEqual(await readdir(f.directory), [receipt]);
});

test('independent cache instances cannot overwrite a published version', async (t) => {
  const f = await fixture(t);
  const generated = online(t);
  const snapshot = createPlayerCatalogSnapshot([generated.entry]);
  const results = await Promise.all([
    f.cache.download(snapshot, generated.entry.id),
    new PlayerPackageCache(f.directory).download(snapshot, generated.entry.id),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal((await readdir(f.directory)).length, 2);
});

test('provenance-only catalog updates preserve offline reuse through the older pinned snapshot', async (t) => {
  const f = await fixture(t);
  const generated = online(t);
  const bytes = await downloadCatalogPlayer(generated.entry);
  generated.mocked.mock.restore();
  const oldEntry = structuredClone(generated.entry);
  delete oldEntry.upstream;
  oldEntry.url = 'https://github.com/example/generated/releases/download/v1/core.ecsplayer';
  oldEntry.sha256 = createHash('sha256').update(bytes).digest('hex');
  oldEntry.downloadBytes = bytes.length;
  const oldSnapshot = createPlayerCatalogSnapshot([oldEntry]);
  const initial = t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  await f.cache.download(oldSnapshot, oldEntry.id);
  initial.mock.restore();

  const updatedEntry = structuredClone(oldEntry);
  updatedEntry.provenance = {
    sourceInfo: 'https://example.com/build.json',
    infoSha256: 'a'.repeat(64),
    license: 'Generated fixture',
    sourceMapping: 'release-receipt',
    artifacts: [
      { kind: 'source', url: 'https://example.com/source', sha256: 'b'.repeat(64), sizeBytes: 10 },
      {
        kind: 'notices',
        url: 'https://example.com/notices',
        sha256: 'c'.repeat(64),
        sizeBytes: 10,
      },
      {
        kind: 'build',
        url: 'https://example.com/build.json',
        sha256: 'a'.repeat(64),
        sizeBytes: 10,
      },
    ],
  };
  const updatedSnapshot = createPlayerCatalogSnapshot([updatedEntry]);
  assert.notEqual(oldSnapshot.id, updatedSnapshot.id);
  assert.notEqual(playerCatalogEntryId(oldEntry), playerCatalogEntryId(updatedEntry));
  assert.equal(oldEntry.sha256, updatedEntry.sha256);
  offline(t);
  const restarted = new PlayerPackageCache(f.directory);
  assert.deepEqual(await restarted.download(oldSnapshot, oldEntry.id), bytes);
  await assert.rejects(restarted.download(updatedSnapshot, updatedEntry.id));
  const urls: string[] = [];
  const refreshed = t.mock.method(globalThis, 'fetch', async (url: string) => {
    urls.push(url);
    return new Response(bytes);
  });
  assert.deepEqual(await restarted.download(updatedSnapshot, updatedEntry.id), bytes);
  assert.deepEqual(urls, [updatedEntry.url]);
  refreshed.mock.restore();
  for (const snapshot of [oldSnapshot, updatedSnapshot]) {
    const receipt = JSON.parse(
      await readFile(join(f.directory, `catalog-${snapshot.id}.json`), 'utf8'),
    );
    assert.deepEqual(parsePlayerCatalogSnapshot(receipt, snapshot.id), snapshot);
    assert.deepEqual(
      await new PlayerPackageCache(f.directory).download(snapshot, oldEntry.id),
      bytes,
    );
  }
});
