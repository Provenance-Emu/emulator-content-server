import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { SevenZipModuleFactory } from '7z-wasm';

const SevenZip = createRequire(import.meta.url)('7z-wasm') as SevenZipModuleFactory;

import { parsePlayerPackage } from '@ecs/plugins';
import { PlayerPackageCache } from '../src/player-cache.js';
import { createPlayerCatalogSnapshot } from '../src/player-catalog-snapshot.js';
import {
  type UpstreamArchiveSource,
  upstreamArchiveSources,
} from '../src/player-upstream-archive.js';
import { upstreamFixture } from './player-cache-fixture.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function archiveFixture(t: TestContext, compression = '-mx=1', large = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-upstream-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const generated = [1, 2, 3].map((revision) => {
    const core = upstreamFixture(revision);
    core.entry.id += `-${revision}`;
    assert.ok(core.entry.upstream?.manifest.player?.web);
    const player = core.entry.upstream.manifest.player;
    core.entry.upstream.manifest.id = core.entry.id;
    player.module = `core_${revision}.wasm`;
    core.entry.upstream.resources.forEach((resource, index) => {
      resource.file = index ? `core_${revision}.wasm` : `loader_${revision}.js`;
    });
    const web = player.web;
    assert.ok(web);
    web.loader.file = `loader_${revision}.js`;
    web.wasm.file = `core_${revision}.wasm`;
    return core;
  });
  if (large) {
    const core = generated[0];
    assert.ok(core?.entry.upstream?.manifest.player?.web);
    const resource = core.entry.upstream.resources[1];
    assert.ok(resource);
    const bytes = Buffer.alloc(60 * 1024 * 1024, 65);
    core.wasm.copy(bytes);
    core.wasm = bytes;
    core.files[1] = bytes;
    resource.sizeBytes = bytes.length;
    resource.sha256 = hash(bytes);
    core.entry.upstream.manifest.player.web.wasm.sha256 = hash(bytes);
    core.entry.downloadBytes = bytes.length + core.loader.length;
  }
  const seven = await SevenZip({ print() {}, printErr() {} });
  seven.FS.mkdir('/retroarch');
  for (const core of generated) {
    assert.ok(core.entry.upstream);
    core.entry.upstream.resources.forEach((resource, index) => {
      const bytes = core.files[index];
      assert.ok(bytes);
      seven.FS.writeFile(`/retroarch/${resource.file}`, bytes);
    });
  }
  seven.callMain(['a', '/generated.7z', '/retroarch', compression, '-bd', '-y']);
  const bytes = Buffer.from(seven.FS.readFile('/generated.7z'));
  const source: UpstreamArchiveSource = {
    url: 'https://buildbot.libretro.com/nightly/emscripten/2026-10-31_RetroArch.7z',
    sha256: hash(bytes),
    sizeBytes: bytes.length,
    entries: generated.map((core) => core.entry),
  };
  const snapshot = createPlayerCatalogSnapshot(source.entries);
  const cacheDirectory = join(directory, 'cache');
  const cache = new PlayerPackageCache(cacheDirectory, undefined, [source]);
  const [first, second, third] = generated;
  assert.ok(first && second && third);
  return {
    directory,
    cacheDirectory,
    generated,
    first,
    second,
    third,
    bytes,
    source,
    snapshot,
    cache,
  };
}

test('stale direct files recover three concurrent installs from one pinned archive and survive restart offline', async (t) => {
  const f = await archiveFixture(t);
  let archives = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('.7z')) {
      archives++;
      return new Response(f.bytes);
    }
    return new Response(Buffer.from('mutable upstream replacement'));
  });
  const results = await Promise.all(
    f.generated.map((core) => f.cache.download(f.snapshot, core.entry.id)),
  );
  assert.equal(archives, 1);
  results.forEach((bytes, index) => {
    assert.deepEqual([...parsePlayerPackage(bytes).files.values()], f.generated[index]?.files);
  });
  const names = await readdir(f.cacheDirectory);
  assert.equal(names.filter((name) => name.endsWith('.ecsplayer')).length, 3);
  assert.equal(
    names.some((name) => name.includes('staging') || name.endsWith('.7z')),
    false,
  );
  assert.deepEqual((await readdir(f.directory)).sort(), ['cache', 'player-upstream-cache']);
  assert.equal(
    (await readdir(join(f.directory, 'player-upstream-cache'))).includes('.staging'),
    false,
  );
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('offline');
  });
  const restarted = new PlayerPackageCache(f.cacheDirectory, undefined, [f.source]);
  for (const core of f.generated) assert.ok(await restarted.download(f.snapshot, core.entry.id));
});

test('archive checksum failure cleans staging and a later retry recovers without accepting replacement bytes', async (t) => {
  const f = await archiveFixture(t);
  let corrupt = true;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string) =>
      new Response(
        url.endsWith('.7z')
          ? corrupt
            ? Buffer.alloc(f.bytes.length)
            : f.bytes
          : Buffer.from('changed'),
      ),
  );
  await assert.rejects(f.cache.download(f.snapshot, f.first.entry.id), /archive.*checksum/i);
  assert.deepEqual((await readdir(f.directory)).sort(), ['cache', 'player-upstream-cache']);
  assert.equal(
    (await readdir(join(f.directory, 'player-upstream-cache'))).includes('.staging'),
    false,
  );
  assert.deepEqual(await readdir(f.cacheDirectory), []);
  corrupt = false;
  assert.ok(await f.cache.download(f.snapshot, f.first.entry.id));
});

test('changed operator pins and unknown profiles never select the built-in archive fallback', async (t) => {
  const f = await archiveFixture(t);
  const changed = structuredClone(f.first.entry);
  assert.ok(changed.upstream?.manifest.player?.web);
  const resource = changed.upstream.resources[0];
  assert.ok(resource);
  resource.sha256 = '0'.repeat(64);
  changed.upstream.manifest.player.web.loader.sha256 = '0'.repeat(64);
  let archives = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('.7z')) archives++;
    return new Response(Buffer.from('changed'));
  });
  await assert.rejects(f.cache.download(createPlayerCatalogSnapshot([changed]), changed.id));
  assert.equal(archives, 0);
});

for (const corruption of ['member-size', 'member-hash', 'archive-overflow'] as const) {
  test(`${corruption} cannot install recovered files and cleans all transient data`, async (t) => {
    const f = await archiveFixture(t);
    const source = structuredClone(f.source);
    const first = source.entries[0];
    assert.ok(first?.upstream?.manifest.player?.web);
    const resource = first.upstream.resources[0];
    assert.ok(resource);
    if (corruption === 'member-size') {
      resource.sizeBytes++;
      first.downloadBytes = (first.downloadBytes ?? 0) + 1;
    }
    if (corruption === 'member-hash') {
      resource.sha256 = '0'.repeat(64);
      first.upstream.manifest.player.web.loader.sha256 = '0'.repeat(64);
    }
    const snapshot = createPlayerCatalogSnapshot(source.entries);
    const cache = new PlayerPackageCache(f.cacheDirectory, undefined, [source]);
    t.mock.method(
      globalThis,
      'fetch',
      async (url: string) =>
        new Response(
          url.endsWith('.7z')
            ? corruption === 'archive-overflow'
              ? Buffer.concat([f.bytes, Buffer.from([1])])
              : f.bytes
            : Buffer.from('changed'),
        ),
    );
    await assert.rejects(cache.download(snapshot, first.id));
    assert.deepEqual((await readdir(f.directory)).sort(), ['cache', 'player-upstream-cache']);
    assert.equal(
      (await readdir(join(f.directory, 'player-upstream-cache'))).includes('.staging'),
      false,
    );
    assert.deepEqual(await readdir(f.cacheDirectory), []);
  });
}

test('independent cache instances share one preparation, and separate archive groups never overlap downloads', async (t) => {
  const f = await archiveFixture(t);
  const second = { ...f.source, sha256: f.source.sha256, entries: [f.third.entry] };
  const alternate = await archiveFixture(t, '-mx=0');
  const bytes = alternate.bytes;
  assert.notEqual(hash(bytes), hash(f.bytes));
  second.sha256 = hash(bytes);
  second.sizeBytes = bytes.length;
  second.url = 'https://buildbot.libretro.com/nightly/emscripten/2026-11-04_RetroArch.7z';
  const first = { ...f.source, entries: f.source.entries.slice(0, 2) };
  const cacheA = new PlayerPackageCache(f.cacheDirectory, undefined, [first, second]);
  const cacheB = new PlayerPackageCache(f.cacheDirectory, undefined, [first, second]);
  let active = 0;
  let maximum = 0;
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (!url.endsWith('.7z')) return new Response(Buffer.from('changed'));
    active++;
    maximum = Math.max(maximum, active);
    downloads++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return new Response(url.includes('11-04') ? bytes : f.bytes);
  });
  const results = await Promise.all([
    cacheA.download(f.snapshot, f.first.entry.id),
    cacheB.download(f.snapshot, f.second.entry.id),
    cacheA.download(f.snapshot, f.third.entry.id),
  ]);
  assert.equal(results.length, 3);
  assert.equal(downloads, 2);
  assert.equal(maximum, 1);
  assert.deepEqual((await readdir(f.directory)).sort(), ['cache', 'player-upstream-cache']);
  assert.equal(
    (await readdir(join(f.directory, 'player-upstream-cache'))).includes('.staging'),
    false,
  );
});

for (const mode of ['full', 'busy'] as const) {
  test(`verified recovery remains installable when optional package retention is ${mode}`, async (t) => {
    const f = await archiveFixture(t);
    await mkdir(f.cacheDirectory);
    if (mode === 'busy') await mkdir(join(f.cacheDirectory, '.write-lock'));
    const cache = new PlayerPackageCache(f.cacheDirectory, mode === 'full' ? 1 : undefined, [
      f.source,
    ]);
    let downloads = 0;
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      if (url.endsWith('.7z')) {
        downloads++;
        return new Response(f.bytes);
      }
      return new Response(Buffer.from('changed'));
    });
    assert.deepEqual(
      [...parsePlayerPackage(await cache.download(f.snapshot, f.first.entry.id)).files.values()],
      f.first.files,
    );
    assert.deepEqual(
      [...parsePlayerPackage(await cache.download(f.snapshot, f.third.entry.id)).files.values()],
      f.third.files,
    );
    assert.equal(downloads, 1);
    assert.equal(
      (await readdir(f.cacheDirectory)).filter((name) => name.endsWith('.ecsplayer')).length,
      0,
    );
    assert.equal(
      (await readdir(join(f.directory, 'player-upstream-cache'))).includes('.staging'),
      false,
    );
  });
}

test('a stalled stream and stalled cancellation cannot outlive the archive deadline', async (t) => {
  const f = await archiveFixture(t);
  let started = () => {};
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (!url.endsWith('.7z')) return new Response(Buffer.from('changed'));
    started();
    return new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          return new Promise(() => {});
        },
      }),
    );
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.cache.download(f.snapshot, f.first.entry.id);
  const rejected = assert.rejects(pending, /archive.*timed out/i);
  await reading;
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(600_001);
  await rejected;
  assert.equal(
    (await readdir(join(f.directory, 'player-upstream-cache'))).includes('.staging'),
    false,
  );
});

test('a crashed process releases the preparation lease and the next owner recovers', async (t) => {
  const f = await archiveFixture(t);
  const root = join(f.directory, 'player-upstream-cache');
  await mkdir(root);
  const code = `import { DatabaseSync } from 'node:sqlite'; const database = new DatabaseSync(process.argv[1]); database.exec('BEGIN EXCLUSIVE'); process.send({ready:true}); setInterval(()=>{},1000);`;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', code, join(root, '.prepare.sqlite')],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  t.after(() => {
    child.kill('SIGKILL');
  });
  await once(child, 'message');
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('.7z')) {
      downloads++;
      return new Response(f.bytes);
    }
    return new Response(Buffer.from('changed'));
  });
  const pending = f.cache.download(f.snapshot, f.first.entry.id);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(downloads, 0);
  child.kill('SIGKILL');
  await once(child, 'exit');
  assert.ok(await pending);
  assert.equal(downloads, 1);
});

test('obsolete managed raw groups are pruned while older package files stay intact', async (t) => {
  const f = await archiveFixture(t);
  const obsolete = join(f.directory, 'player-upstream-cache', 'a'.repeat(64), 'retroarch');
  await mkdir(obsolete, { recursive: true });
  await writeFile(join(obsolete, 'old.wasm'), Buffer.from([1, 2, 3]));
  await mkdir(f.cacheDirectory);
  await writeFile(join(f.cacheDirectory, 'older-package'), Buffer.from('preserve'));
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string) => new Response(url.endsWith('.7z') ? f.bytes : Buffer.from('changed')),
  );
  assert.ok(await f.cache.download(f.snapshot, f.first.entry.id));
  assert.equal(
    (await readdir(join(f.directory, 'player-upstream-cache'))).includes('a'.repeat(64)),
    false,
  );
  assert.equal(await readFile(join(f.cacheDirectory, 'older-package'), 'utf8'), 'preserve');
});

test('every built-in recovery resource matches its independently captured official archive receipt', async () => {
  const receipt = JSON.parse(
    await readFile(
      new URL(
        '../../../../docs/operations/upstream-archive-recovery-2026-11-07.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {
    archives: { url: string; sha256: string; sizeBytes: number }[];
    profiles: {
      id: string;
      archiveSha256: string;
      resources: { file: string; sizeBytes: number; sha256: string }[];
    }[];
  };
  for (const source of upstreamArchiveSources) {
    assert.deepEqual(
      receipt.archives.find((archive) => archive.sha256 === source.sha256),
      { url: source.url, sha256: source.sha256, sizeBytes: source.sizeBytes },
    );
    for (const entry of source.entries) {
      const captured = receipt.profiles.find((profile) => profile.id === entry.id);
      assert.equal(captured?.archiveSha256, source.sha256, entry.id);
      assert.deepEqual(
        entry.upstream?.resources.map(({ file, sizeBytes, sha256 }) => ({
          file,
          sizeBytes,
          sha256,
        })),
        captured?.resources.map(({ file, sizeBytes, sha256 }) => ({ file, sizeBytes, sha256 })),
        entry.id,
      );
    }
  }
});

async function archivePeer(t: TestContext, f: Awaited<ReturnType<typeof archiveFixture>>) {
  const input = join(f.directory, 'peer.json');
  const archive = join(f.directory, 'generated.7z');
  await writeFile(
    input,
    JSON.stringify({ source: f.source, snapshot: f.snapshot, directory: f.cacheDirectory }),
  );
  await writeFile(archive, f.bytes);
  const code = `
    import { readFile } from 'node:fs/promises';
    const { PlayerPackageCache } = await import(process.argv[1]);
    const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const bytes = await readFile(process.argv[3]);
    globalThis.fetch = async url => {
      if (!url.endsWith('.7z')) return new Response(Buffer.from('changed'));
      process.send({ downloading: true });
      await new Promise(resolve => process.once('message', resolve));
      return new Response(bytes);
    };
    try {
      await new PlayerPackageCache(input.directory, undefined, [input.source]).download(input.snapshot, input.source.entries[0].id);
      process.send({ done: true });
    } catch { process.exitCode = 1; }
    finally { process.disconnect(); }
  `;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      code,
      new URL('../src/player-cache.js', import.meta.url).href,
      input,
      archive,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  t.after(() => {
    child.kill('SIGKILL');
  });
  await once(child, 'message');
  return child;
}

test('two server processes share one archive preparation and reuse the published raw group', async (t) => {
  const f = await archiveFixture(t);
  const peer = await archivePeer(t, f);
  let archives = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('.7z')) archives++;
    return new Response(url.endsWith('.7z') ? f.bytes : Buffer.from('changed'));
  });
  const pending = f.cache.download(f.snapshot, f.third.entry.id);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(archives, 0);
  const exit = once(peer, 'exit');
  peer.send('continue');
  assert.deepEqual([...parsePlayerPackage(await pending).files.values()], f.third.files);
  assert.equal((await exit)[0], 0);
  assert.equal(archives, 0);
});

test('killing a preparing parent during extraction leaves no orphan lease or stale staging', async (t) => {
  const f = await archiveFixture(t, '-mx=1', true);
  const peer = await archivePeer(t, f);
  peer.send('continue');
  const database = new DatabaseSync(join(f.directory, 'player-upstream-cache', '.extract.sqlite'));
  let extracting = false;
  const deadline = performance.now() + 15_000;
  try {
    while (performance.now() < deadline) {
      try {
        database.exec('BEGIN EXCLUSIVE');
        database.exec('ROLLBACK');
      } catch (error) {
        if ((error as { errcode?: number }).errcode === 5) {
          extracting = true;
          break;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    database.close();
  }
  assert.equal(extracting, true);
  const exit = once(peer, 'exit');
  peer.kill('SIGKILL');
  await exit;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string) => new Response(url.endsWith('.7z') ? f.bytes : Buffer.from('changed')),
  );
  const recovered = await f.cache.download(f.snapshot, f.first.entry.id);
  assert.deepEqual([...parsePlayerPackage(recovered).files.values()], f.first.files);
  assert.equal(
    (await readdir(join(f.directory, 'player-upstream-cache'))).some((name) =>
      name.startsWith('.staging-'),
    ),
    false,
  );
});

test('an unusable optional package-cache path does not prevent verified raw recovery or overwrite that path', async (t) => {
  const f = await archiveFixture(t);
  await writeFile(f.cacheDirectory, 'operator-owned file');
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string) => new Response(url.endsWith('.7z') ? f.bytes : Buffer.from('changed')),
  );
  const bytes = await f.cache.download(f.snapshot, f.first.entry.id);
  assert.deepEqual([...parsePlayerPackage(bytes).files.values()], f.first.files);
  assert.equal(await readFile(f.cacheDirectory, 'utf8'), 'operator-owned file');
});
