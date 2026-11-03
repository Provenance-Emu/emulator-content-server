import assert from 'node:assert/strict';
import fs, { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DomainError } from '@ecs/domain';
import type { ServerContext } from '../src/context.js';
import { PlayerManager } from '../src/player-manager.js';
import { upstreamFixture } from './player-cache-fixture.js';

function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

function generated(id: string, revision = 1) {
  const fixture = upstreamFixture(revision);
  const upstream = fixture.entry.upstream;
  assert.ok(upstream);
  fixture.entry.id = id;
  upstream.manifest.id = id;
  const header = Buffer.from(
    JSON.stringify({
      manifest: upstream.manifest,
      files: upstream.resources.map((resource) => ({
        name: resource.file,
        size: resource.sizeBytes,
      })),
    }),
  );
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(header.length);
  return { ...fixture, bytes: Buffer.concat([prefix, header, ...fixture.files]) };
}

async function fixture(
  t: TestContext,
  downloading: ReturnType<typeof generated>,
  fail = false,
  catalog = [downloading.entry],
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ecs-player-concurrency-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const context = {
    dataDir,
    playerProfiles: new Map(),
    defaultPlayerProfileId: null,
  } as unknown as ServerContext;
  const manager = new PlayerManager(context, new Map(), catalog);
  await manager.initialize();
  const started = signal();
  const release = signal();
  const network = t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('.js')) {
      started.resolve();
      await release.promise;
      if (fail) throw new Error('generated unavailable upstream');
    }
    return new Response(url.endsWith('.wasm') ? downloading.wasm : downloading.loader);
  });
  return { manager, context, started, release, network };
}

/** The deadline only detects a regression; the download gate determines ordering. */
function whileDownloading<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Management mutation blocked by core download')),
      2000,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

for (const fail of [false, true]) {
  test(`owner mutations finish during a stalled catalog download that ${fail ? 'fails' : 'succeeds'}`, async (t) => {
    const downloading = generated('org.example.downloading');
    const existing = generated('org.example.existing');
    const uploaded = generated('org.example.uploaded', 2);
    const f = await fixture(t, downloading, fail);
    await f.manager.install(existing.bytes);
    const pending = f.manager.installCatalog(downloading.entry.id).then(
      () => null,
      (error: unknown) => error,
    );
    await f.started.promise;
    try {
      assert.equal(f.context.playerProfiles.has(downloading.entry.id), false);
      await whileDownloading(f.manager.configure(existing.entry.id, { enabled: false }));
      await whileDownloading(
        f.manager.systemFile(existing.entry.id, 'generated.bin', Buffer.from([1, 2])),
      );
      await whileDownloading(f.manager.install(uploaded.bytes));
      await whileDownloading(f.manager.configure(uploaded.entry.id, { default: true }));
      await whileDownloading(f.manager.remove(existing.entry.id));
    } finally {
      f.release.resolve();
      await pending;
    }
    const error = await pending;
    if (fail) assert.ok(error instanceof DomainError && error.status === 400);
    else assert.equal(error, null);
    assert.equal(f.context.playerProfiles.has(existing.entry.id), false);
    assert.equal(f.context.playerProfiles.has(downloading.entry.id), !fail);
    assert.deepEqual(f.context.playerProfiles.get(uploaded.entry.id)?.loader, uploaded.loader);
    assert.equal(f.context.defaultPlayerProfileId, uploaded.entry.id);
    if (fail) {
      f.network.mock.restore();
      t.mock.method(
        globalThis,
        'fetch',
        async (url: string) =>
          new Response(url.endsWith('.wasm') ? downloading.wasm : downloading.loader),
      );
      await f.manager.installCatalog(downloading.entry.id);
      assert.deepEqual(f.context.playerProfiles.get(downloading.entry.id)?.wasm, downloading.wasm);
      assert.equal(f.context.defaultPlayerProfileId, uploaded.entry.id);
    }
  });
}

test('activation rechecks conflicts and preserves a same-ID upload, firmware and settings made during download', async (t) => {
  const downloading = generated('org.example.racing');
  const uploaded = generated(downloading.entry.id, 2);
  const f = await fixture(t, downloading);
  const pending = f.manager.installCatalog(downloading.entry.id).then(
    () => null,
    (error: unknown) => error,
  );
  await f.started.promise;
  try {
    await whileDownloading(f.manager.install(uploaded.bytes));
    await whileDownloading(
      f.manager.systemFile(uploaded.entry.id, 'generated.bin', Buffer.from([3, 4])),
    );
    await whileDownloading(f.manager.configure(uploaded.entry.id, { enabled: false }));
  } finally {
    f.release.resolve();
    await pending;
  }
  const error = await pending;
  assert.ok(error instanceof DomainError && error.status === 409);
  const item = f.manager.view().items.find((item) => item.profile.id === uploaded.entry.id);
  assert.ok(item);
  assert.equal(item.enabled, false);
  await f.manager.configure(uploaded.entry.id, { enabled: true });
  const profile = f.context.playerProfiles.get(uploaded.entry.id);
  assert.deepEqual(profile?.loader, uploaded.loader);
  assert.deepEqual(profile?.wasm, uploaded.wasm);
  assert.deepEqual(profile?.assets.get('generated.bin'), Buffer.from([3, 4]));
});

test('catalog preflight runs after earlier queued removals and rejects duplicates without fetching', async (t) => {
  const downloading = generated('org.example.reinstall');
  const f = await fixture(t, downloading);
  await f.manager.install(downloading.bytes);
  await assert.rejects(
    f.manager.installCatalog(downloading.entry.id),
    (error: unknown) => error instanceof DomainError && error.status === 409,
  );
  await assert.rejects(
    f.manager.installCatalog('org.example.unknown'),
    (error: unknown) => error instanceof DomainError && error.status === 404,
  );
  assert.equal(f.network.mock.callCount(), 0);
  const removal = f.manager.remove(downloading.entry.id);
  const reinstall = f.manager.installCatalog(downloading.entry.id);
  f.release.resolve();
  await removal;
  await reinstall;
  assert.deepEqual(f.context.playerProfiles.get(downloading.entry.id)?.loader, downloading.loader);
});

test('concurrent catalog requests activate one complete version and reject the duplicate', async (t) => {
  const downloading = generated('org.example.concurrent');
  const f = await fixture(t, downloading);
  const results = Promise.allSettled([
    f.manager.installCatalog(downloading.entry.id),
    f.manager.installCatalog(downloading.entry.id),
  ]);
  try {
    await f.started.promise;
  } finally {
    f.release.resolve();
  }
  const outcomes = await results;
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
  assert.ok(rejected?.status === 'rejected');
  assert.ok(rejected.reason instanceof DomainError && rejected.reason.status === 409);
  assert.deepEqual(f.context.playerProfiles.get(downloading.entry.id)?.loader, downloading.loader);
  assert.deepEqual(f.context.playerProfiles.get(downloading.entry.id)?.wasm, downloading.wasm);
});

test('catalog preparation stays bounded while an earlier activation waits on disk', {
  timeout: 30000,
}, async (t) => {
  const first = generated('org.example.first'),
    second = generated('org.example.second', 2),
    existing = generated('org.example.existing');
  for (const [index, player] of [first, second].entries()) {
    assert.ok(player.entry.upstream);
    for (const resource of player.entry.upstream.resources)
      resource.url = `https://web.libretro.com/queue_${index}_libretro.${resource.file.endsWith('.wasm') ? 'wasm' : 'js'}`;
  }
  const f = await fixture(t, first, false, [first.entry, second.entry]);
  await f.manager.install(existing.bytes);
  f.network.mock.restore();
  const secondStarted = signal(),
    activationStarted = signal(),
    allowActivation = signal();
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const player = url.includes('queue_0_') ? first : second;
    if (player === first) {
      f.started.resolve();
      await f.release.promise;
    } else secondStarted.resolve();
    return new Response(url.endsWith('.wasm') ? player.wasm : player.loader);
  });
  const installs = Promise.allSettled([
    f.manager.installCatalog(first.entry.id),
    f.manager.installCatalog(second.entry.id),
  ]);
  let restoreWrites = () => {};
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await whileDownloading(f.started.promise);
    // Drain earlier preflights before releasing the first download.
    await whileDownloading(f.manager.configure(existing.entry.id, { default: true }));
    const write = fs.writeFile;
    const writes = t.mock.method(
      fs,
      'writeFile',
      async (...args: Parameters<typeof fs.writeFile>) => {
        if (
          typeof args[0] === 'string' &&
          args[0].startsWith(join(f.context.dataDir, 'player-settings-'))
        ) {
          activationStarted.resolve();
          await allowActivation.promise;
        }
        return write(...args);
      },
    );
    restoreWrites = () => {
      writes.mock.restore();
      syncBuiltinESMExports();
    };
    syncBuiltinESMExports();
    f.release.resolve();
    await whileDownloading(activationStarted.promise);
    const advanced = await Promise.race([
      secondStarted.promise.then(() => true),
      new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => resolve(false), 2000);
      }),
    ]);
    assert.equal(
      advanced,
      false,
      'Another catalog download accumulated behind a blocked activation',
    );
    allowActivation.resolve();
    assert.deepEqual(
      (await installs).map((result) => result.status),
      ['fulfilled', 'fulfilled'],
    );
    assert.equal(f.context.defaultPlayerProfileId, existing.entry.id);
    assert.deepEqual(f.context.playerProfiles.get(first.entry.id)?.wasm, first.wasm);
    assert.deepEqual(f.context.playerProfiles.get(second.entry.id)?.wasm, second.wasm);
  } finally {
    clearTimeout(deadline);
    f.release.resolve();
    allowActivation.resolve();
    await installs;
    restoreWrites();
  }
});
