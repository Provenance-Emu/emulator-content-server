import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandChannel } from '../src/player/commands.js';
import { SaveSynchronizer } from '../src/player/saves.js';
import { statePath } from '../src/player/states.js';
import { fixture } from './player-fixture.js';

function setup(deadlineMs = 30_000) {
  const f = fixture();
  const sync = new SaveSynchronizer(
    f.client,
    f.runtime,
    new CommandChannel(f.runtime, { deadlineMs, pollMs: 1 }),
    {
      libraryId: 'library',
      itemId: 'item',
      revision: 7,
      batteryPath: 'original.sav',
      statePath: 'original.state',
      selectedState: new Uint8Array([6, 7]),
    },
  );
  f.fs.set('/ecs/states/game.state', new Uint8Array([9]));
  f.fs.set('/ecs/saves/game.srm', new Uint8Array([4, 5]));
  return { ...f, sync };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
test('delayed multi-chunk replacement never reads/uploads old or partial state before matching success', async () => {
  const f = setup();
  f.runtime.EmscriptenSendCommand = (command) => {
    assert.equal(command, 'SAVE_STATE_SLOT 0');
  };
  const saving = f.sync.capture('save_state');
  await tick();
  assert.equal(f.uploads.length, 0);
  assert.equal(
    f.events.some((event) => event.startsWith('read:')),
    false,
  );
  f.fs.set('/ecs/states/game.state', new Uint8Array([1, 2]));
  await tick();
  assert.equal(f.uploads.length, 0);
  f.fs.set('/ecs/states/game.state', new Uint8Array([1, 2, 3, 4]));
  f.replies.push('SAVE_STATE_SLOT 0');
  await saving;
  assert.deepEqual(f.uploads[0]?.body, new Uint8Array([1, 2, 3, 4]));
  f.fs.get('/ecs/states/game.state')?.fill(99);
  assert.deepEqual(f.uploads[0]?.body, new Uint8Array([1, 2, 3, 4]), 'snapshot owns its bytes');
  assert.equal(f.uploads[0]?.relativePath, 'original.state');
});
for (const reply of ['SAVE_STATE_SLOT ERROR disk full', 'SAVE_STATE_SLOT 1', 'OK', undefined]) {
  test(`command failure ${String(reply)} never reads/uploads the old file`, async () => {
    const f = setup(15);
    f.runtime.EmscriptenSendCommand = () => {
      if (reply) f.replies.push(reply);
    };
    await assert.rejects(f.sync.capture('save_state'));
    assert.equal(f.uploads.length, 0);
    assert.equal(
      f.events.some((event) => event.startsWith('read:')),
      false,
    );
    assert.equal(f.sync.pending, null);
  });
}
test('unchanged SRAM acknowledges without a write and advances baseline by exactly one, ignoring Asset.revision', async () => {
  const f = setup();
  await f.sync.capture('battery_save');
  await f.sync.capture('battery_save');
  assert.deepEqual(
    f.uploads.map((request) => request.baseRevision),
    [7, 8],
  );
  assert.deepEqual(f.uploads[0]?.body, new Uint8Array([4, 5]));
  assert.equal(f.uploads[0]?.relativePath, 'original.sav');
});
test('failed upload retains bytes/body/key/base, blocks overlap, and retries the same logical save', async () => {
  const f = setup();
  const upload = f.client.upload;
  f.client.upload = async (request) => {
    f.uploads.push(request);
    throw new Error('forbidden/offline');
  };
  await assert.rejects(f.sync.capture('save_state'), /forbidden/);
  assert.deepEqual(f.sync.exportPending(), new Uint8Array([9]));
  f.sync.exportPending().fill(33);
  assert.deepEqual(
    f.sync.exportPending(),
    new Uint8Array([9]),
    'export cannot mutate retained bytes',
  );
  assert.equal(f.sync.pending?.baseRevision, 7);
  await assert.rejects(f.sync.capture('battery_save'), /pending/i);
  f.fs.set('/ecs/states/game.state', new Uint8Array([55]));
  f.client.upload = upload;
  await f.sync.retry();
  assert.equal(f.uploads.length, 2);
  assert.equal(f.uploads[0], f.uploads[1], 'same request retains body and key identity');
  assert.ok(f.uploads[0]?.idempotencyKey);
  assert.deepEqual(f.uploads[1]?.body, new Uint8Array([9]));
  assert.equal(f.sync.pending, null);
});
test('overlapping capture cannot issue a second command or upload', async () => {
  const f = setup();
  f.runtime.EmscriptenSendCommand = () => {};
  const first = f.sync.capture('save_state');
  await assert.rejects(f.sync.capture('battery_save'), /progress|pending/i);
  f.replies.push('SAVE_STATE_SLOT 0');
  await first;
  assert.equal(f.uploads.length, 1);
});
test('missing or oversized expected file fails even after OK, never uploading old/empty bytes', async () => {
  const f = setup();
  f.fs.delete('/ecs/saves/game.srm');
  await assert.rejects(f.sync.capture('battery_save'));
  assert.equal(f.uploads.length, 0);
  f.fs.set('/ecs/saves/game.srm', new Uint8Array(64 * 1024 * 1024 + 1));
  await assert.rejects(f.sync.capture('battery_save'), /size|limit/i);
  assert.equal(f.uploads.length, 0);
});
test('load selected state rewrites selected bytes and waits for actual completion', async () => {
  const f = setup();
  await f.sync.loadSelectedState();
  assert.deepEqual(f.fs.get('/ecs/states/game.state'), new Uint8Array([6, 7]));
  assert.ok(
    f.events.indexOf('write:/ecs/states/game.state') < f.events.indexOf('LOAD_STATE_SLOT 0'),
  );
});

for (const kind of ['battery_save', 'save_state'] as const) {
  test(`LAN HTTP ${kind} capture retains body/key/base for Export and Retry without secure-context crypto APIs`, async (t) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    assert.ok(descriptor);
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues },
    });
    t.after(() => Object.defineProperty(globalThis, 'crypto', descriptor));
    assert.equal(globalThis.crypto.randomUUID, undefined);
    assert.equal(globalThis.crypto.subtle, undefined);

    const f = setup();
    const path = kind === 'battery_save' ? '/ecs/saves/game.srm' : '/ecs/states/game.state';
    await f.sync.capture(kind);
    const first = f.uploads[0];
    assert.ok(first?.idempotencyKey, 'LAN capture reaches upload with a logical save key');

    f.fs.set(path, new Uint8Array([6, 7, 8]));
    const upload = f.client.upload;
    f.client.upload = async (request) => {
      f.uploads.push(request);
      throw new Error('generated offline upload');
    };
    await assert.rejects(f.sync.capture(kind), /offline upload/);
    const pending = f.uploads[1];
    assert.ok(pending?.idempotencyKey);
    assert.notEqual(pending.idempotencyKey, first.idempotencyKey, 'a new capture owns a new key');
    assert.equal(f.sync.pending?.baseRevision, 8);
    assert.deepEqual(f.sync.exportPending(), new Uint8Array([6, 7, 8]));
    f.fs.set(path, new Uint8Array([90]));
    f.sync.exportPending().fill(99);
    assert.deepEqual(f.sync.exportPending(), new Uint8Array([6, 7, 8]));

    f.client.upload = upload;
    await f.sync.retry();
    assert.equal(f.uploads[2], pending, 'Retry retains the same request, body and key');
    assert.equal(f.uploads[2]?.baseRevision, 8);
    assert.deepEqual(f.uploads[2]?.body, new Uint8Array([6, 7, 8]));
    assert.equal(f.sync.pending, null);
  });
}

function snapshotSetup() {
  const f = fixture();
  const target = { libraryId: 'library', itemId: 'item', revision: 7, core: f.core };
  const sync = new SaveSynchronizer(
    f.client,
    f.runtime,
    new CommandChannel(f.runtime, { deadlineMs: 100, pollMs: 1 }),
    target,
  );
  const png = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  f.fs.set('/ecs/states/game.state', new Uint8Array([9]));
  f.runtime.prepareStatePreview = async () => {
    f.events.push('clear-preview');
    return true;
  };
  f.runtime.captureStatePreview = async () => {
    f.events.push('read-preview');
    return png;
  };
  f.client.upload = async (request) => {
    f.uploads.push(request);
    return {
      id: `saved-${f.uploads.length}`,
      relativePath: request.relativePath,
      conflictOf: null,
      revision: 300,
    } as import('@ecs/client').Asset;
  };
  return { ...f, sync, png };
}
test('snapshot capture clears the preview before save and uploads a unique state with its exact companion', async () => {
  const f = snapshotSetup();
  await f.sync.capture('save_state');
  await f.sync.capture('save_state');
  assert.equal(f.uploads.length, 4);
  assert.match(f.uploads[0]!.relativePath, /^browser-states\/v1\//);
  assert.notEqual(f.uploads[0]!.relativePath, f.uploads[2]!.relativePath);
  assert.equal(f.uploads[1]!.relativePath, f.uploads[0]!.relativePath + '.png');
  assert.equal(f.uploads[1]!.kind, 'screenshot');
  assert.deepEqual(
    f.uploads.map((r) => r.baseRevision),
    [7, 8, 9, 10],
  );
  assert.ok(f.events.indexOf('clear-preview') < f.events.indexOf('SAVE_STATE_SLOT 0'));
  assert.ok(f.events.indexOf('read-preview') > f.events.indexOf('SAVE_STATE_SLOT 0'));
});
test('failed preview retains one image retry and never duplicates the successfully uploaded state', async () => {
  const f = snapshotSetup();
  const upload = f.client.upload;
  f.client.upload = async (request) => {
    if (request.kind === 'screenshot') {
      f.uploads.push(request);
      throw Error('offline preview');
    }
    return upload(request);
  };
  await f.sync.capture('save_state');
  assert.equal(f.uploads.length, 2);
  assert.equal(f.sync.pending?.kind, 'screenshot');
  const pending = f.uploads[1];
  f.client.upload = upload;
  await f.sync.retry();
  assert.equal(f.uploads[2], pending);
  assert.equal(f.uploads.filter((r) => r.kind === 'save_state').length, 1);
});
test('missing or invalid thumbnail still saves the state without uploading unrelated bytes', async () => {
  const f = snapshotSetup();
  f.runtime.captureStatePreview = async () => new Uint8Array([1, 2, 3]);
  await f.sync.capture('save_state');
  assert.equal(f.uploads.length, 1);
  assert.equal(f.sync.pending, null);
});
test('preview revision rejection preserves the committed state and can be explicitly dismissed', async () => {
  const f = snapshotSetup();
  const upload = f.client.upload;
  f.client.upload = async (r) => {
    if (r.kind === 'screenshot') {
      f.uploads.push(r);
      throw Object.assign(Error('changed'), { status: 409 });
    }
    return upload(r);
  };
  const state = await f.sync.capture('save_state');
  assert.equal(state.id, 'saved-1');
  assert.equal(f.sync.pending?.canRetry, false);
  assert.equal(f.sync.pending?.preview, true);
  await assert.rejects(f.sync.retry(), /changed/);
  f.sync.dismissPendingImage();
  assert.equal(f.sync.pending, null);
  assert.equal(f.sync.lastState?.id, state.id);
});
test('preview pairs with the returned conflict path and never refreshes a remote revision', async () => {
  const f = snapshotSetup();
  f.client.upload = async (r) => {
    f.uploads.push(r);
    return {
      id: 'conflict',
      relativePath:
        r.kind === 'save_state' ? r.relativePath + '.conflict-1234abcd' : r.relativePath,
      conflictOf: r.kind === 'save_state' ? 'live' : null,
      revision: 999,
    } as import('@ecs/client').Asset;
  };
  await f.sync.capture('save_state');
  assert.equal(f.uploads[1]!.relativePath, f.uploads[0]!.relativePath + '.conflict-1234abcd.png');
  assert.equal(f.uploads[1]!.baseRevision, 7);
});
test('in-session loading rejects another build before fetching and retains its original upload baseline', async () => {
  const f = snapshotSetup();
  const foreign = statePath({ ...f.core, wasm: { ...f.core.wasm, sha256: 'c'.repeat(64) } });
  f.manifest.files.push({ ...f.manifest.files[2]!, id: 'foreign', relativePath: foreign });
  await assert.rejects(f.sync.loadAsset('foreign', true), /different emulator build/);
  assert.ok(!f.events.includes('collect:foreign'));
  await assert.rejects(f.sync.loadAsset('state'), /Confirm/);
  f.manifest.revision = 88;
  await f.sync.loadAsset('state', true);
  await f.sync.capture('save_state');
  assert.equal(f.uploads[0]!.baseRevision, 7);
});
