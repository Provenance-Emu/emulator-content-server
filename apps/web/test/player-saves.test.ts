import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandChannel } from '../src/player/commands.js';
import { SaveSynchronizer } from '../src/player/saves.js';
import { fixture } from './player-fixture.js';

function setup(deadlineMs = 200) {
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
