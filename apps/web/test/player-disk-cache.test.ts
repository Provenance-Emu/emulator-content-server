import assert from 'node:assert/strict';
import test from 'node:test';
import { cachePlayerDisk } from '../src/player/disk-cache.js';

function fixture(size = 4) {
  let length = 0,
    largest = 0,
    removes = 0,
    aborts = 0;
  const writer = {
    async truncate(n: number) {
      length = n;
    },
    async seek() {},
    async write(part: Uint8Array) {
      largest = Math.max(largest, part.length);
      length += part.length;
    },
    async close() {},
    async abort() {
      aborts++;
    },
  };
  const directory = {
    async getDirectoryHandle() {
      return directory;
    },
    async getFileHandle() {
      return {
        async createWritable() {
          return writer;
        },
        async getFile() {
          return { size: length } as File;
        },
      };
    },
    async removeEntry() {
      removes++;
    },
  };
  const storage = {
    async estimate() {
      return { quota: size + 32 * 1024 ** 2, usage: 0 };
    },
    async getDirectory() {
      return directory as unknown as FileSystemDirectoryHandle;
    },
  };
  return { storage, metrics: () => ({ length, largest, removes, aborts }) };
}
test('disc staging truncates on representation restart, bounds writes and removes only its session file', async () => {
  const f = fixture(200000);
  const staged = await cachePlayerDisk(
    200000,
    async (sink) => {
      await sink.reset();
      await sink.write(new Uint8Array(100));
      await sink.reset();
      await sink.write(new Uint8Array(200000));
      await sink.close();
    },
    { storage: f.storage },
  );
  assert.equal(staged.file.size, 200000);
  assert.equal(f.metrics().largest, 65536);
  assert.equal(f.metrics().removes, 0);
  await staged.release();
  await staged.release();
  assert.equal(f.metrics().removes, 1);
});
test('short, oversized and cancelled streams clean their private staging file', async () => {
  for (const mode of ['short', 'oversize', 'cancel']) {
    const f = fixture();
    const signal = new AbortController();
    await assert.rejects(
      cachePlayerDisk(
        4,
        async (sink) => {
          await sink.reset();
          if (mode === 'cancel') signal.abort();
          await sink.write(new Uint8Array(mode === 'oversize' ? 5 : 2));
          await sink.close();
        },
        { storage: f.storage, signal: signal.signal },
      ),
    );
    assert.equal(f.metrics().removes, 1);
  }
});
test('insufficient quota fails before opening or downloading a disc', async () => {
  const f = fixture();
  let downloads = 0;
  await assert.rejects(
    cachePlayerDisk(
      100 * 1024 ** 2,
      async () => {
        downloads++;
      },
      { storage: f.storage },
    ),
    /disk space/,
  );
  assert.equal(downloads, 0);
  assert.equal(f.metrics().removes, 0);
});

test('large Dolphin preflight streams to a disk destination and cleans it when core verification fails', async () => {
  const { fixture: playerFixture } = await import('./player-fixture.js');
  const { preparePlayer } = await import('../src/player/preflight.js');
  const { startPlayer } = await import('../src/player/controller.js');
  const { dolphinBuild } = await import('../src/player/dolphin.js');
  const f = playerFixture();
  const size = 1459978240;
  const profile = {
    profileVersion: 1,
    id: dolphinBuild.id,
    name: 'Dolphin',
    systems: ['com.provenance.gamecube'],
    runtime: 'dolphin-wasm-esm',
    threaded: true,
    filesystem: 'memfs',
    saveCompletion: 'none',
    contentExtensions: ['iso'],
    maxContentBytes: 9 * 1024 ** 3,
    buildVersion: 'reviewed',
    assets: [],
    loader: { ...f.core.loader, sha256: dolphinBuild.loader },
    wasm: { ...f.core.wasm, sha256: dolphinBuild.wasm },
  };
  f.item.systemIdentifier = 'com.provenance.gamecube';
  const rom = f.manifest.files[0];
  assert.ok(rom);
  rom.size = size;
  rom.relativePath = 'original.iso';
  f.client.playerProfile = async () => profile;
  f.client.collect = async () => {
    throw new Error('A large disc must never be collected in memory');
  };
  let downloads = 0,
    releases = 0;
  f.client.downloadTo = async (_id, sink) => {
    downloads++;
    await sink.reset();
    await sink.close();
  };
  const stageDisk: typeof cachePlayerDisk = async (bytes, download) => {
    assert.equal(bytes, size);
    await download({ async reset() {}, async write() {}, async close() {}, async abort() {} });
    return {
      file: { size } as File,
      async release() {
        releases++;
      },
    };
  };
  const options = {
    profileId: profile.id,
    canvas: {} as HTMLCanvasElement,
    importer: f.importer,
    stageDisk,
  };
  const selection = { kind: 'asset', itemId: 'item', assetId: 'rom' } as const;
  const prepared = await preparePlayer(f.client, selection, options);
  assert.equal(prepared.content.length, 0);
  assert.equal(prepared.disk?.file.size, size);
  assert.equal(downloads, 1);
  await prepared.disk?.release();
  f.client.playerProfileAssets = async () => ({
    ...(await f.client.playerCoreAssets(f.core.id)),
    assets: [],
  });
  await assert.rejects(startPlayer(f.client, selection, options), /profile changed/);
  assert.equal(releases, 2);
  assert.equal(f.events.includes('import'), false);
});

test('abandoned-disc reclamation skips live locks, unknown files and directories', async () => {
  const { reclaimPlayerDiscs } = await import('../src/player/disk-cache.js');
  const live = '11111111-1111-1111-1111-111111111111.disc',
    stale = '22222222-2222-2222-2222-222222222222.disc';
  const removed: string[] = [];
  const directory = {
    async *entries() {
      for (const [name, kind] of [
        [live, 'file'],
        [stale, 'file'],
        ['notes.txt', 'file'],
        ['33333333-3333-3333-3333-333333333333.disc', 'directory'],
      ])
        yield [name, { kind }];
    },
    async removeEntry(name: string) {
      removed.push(name);
    },
  } as unknown as FileSystemDirectoryHandle;
  const locks = {
    request: async (name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) =>
      callback(name.endsWith(live) ? null : {}),
  } as unknown as Pick<LockManager, 'request'>;
  await reclaimPlayerDiscs(directory, locks);
  assert.deepEqual(removed, [stale]);
  removed.length = 0;
  await reclaimPlayerDiscs(directory);
  assert.deepEqual(removed, []);
});

test('staging holds its lock through playback and releases it after its file is removed', async () => {
  const f = fixture();
  let locked = false;
  const locks = {
    request: async (_name: string, callback: (lock: unknown) => Promise<void>) => {
      locked = true;
      try {
        return await callback({});
      } finally {
        locked = false;
      }
    },
  } as unknown as Pick<LockManager, 'request'>;
  const staged = await cachePlayerDisk(
    4,
    async (sink) => {
      assert.equal(locked, true);
      await sink.reset();
      await sink.write(new Uint8Array(4));
      await sink.close();
    },
    { storage: f.storage, locks },
  );
  assert.equal(locked, true);
  await staged.release();
  assert.equal(locked, false);
  assert.equal(f.metrics().removes, 1);
});

test('browsers without locks use a namespace that is never scavenged', async () => {
  const f = fixture();
  let folder = '';
  const root = await f.storage.getDirectory();
  const old = root.getDirectoryHandle.bind(root);
  root.getDirectoryHandle = async (name) => {
    folder = name;
    return old(name);
  };
  const staged = await cachePlayerDisk(
    4,
    async (sink) => {
      await sink.reset();
      await sink.write(new Uint8Array(4));
      await sink.close();
    },
    { storage: f.storage },
  );
  assert.equal(folder, 'ecs-player-staging-unlocked');
  await staged.release();
});

test('mid-stream browser quota failure removes partial data and gives a disk-space message', async () => {
  const f = fixture();
  await assert.rejects(
    cachePlayerDisk(
      4,
      async (sink) => {
        await sink.reset();
        await sink.write(new Uint8Array(2));
        const error = new Error('quota');
        error.name = 'QuotaExceededError';
        throw error;
      },
      { storage: f.storage },
    ),
    /ran out of disk storage/,
  );
  assert.equal(f.metrics().removes, 1);
});
