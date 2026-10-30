import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandChannel, type CommandRuntime } from '../src/player/commands.js';

function runtime() {
  const replies: string[] = [];
  const sent: string[] = [];
  const core: CommandRuntime = {
    EmscriptenSendCommand(command) {
      sent.push(command);
    },
    EmscriptenReceiveCommandReply() {
      return replies.shift();
    },
  };
  return { replies, sent, core };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('delayed completion gates resolution and all commands serialize as direct JS strings', async () => {
  const f = runtime();
  f.replies.push('old startup reply');
  const channel = new CommandChannel(f.core);
  let done = false;
  const first = channel.run('SAVE_STATE_SLOT 0').then(() => {
    done = true;
  });
  const second = channel.run('LOAD_STATE_SLOT 0');
  await tick();
  assert.equal(done, false, 'enqueue is not completion');
  assert.deepEqual(f.sent, ['SAVE_STATE_SLOT 0']);
  f.replies.push('SAVE_STATE_SLOT 0\r\n');
  await first;
  await tick();
  assert.deepEqual(f.sent, ['SAVE_STATE_SLOT 0', 'LOAD_STATE_SLOT 0']);
  f.replies.push('LOAD_STATE_SLOT 0, queue ended');
  await second;
});

for (const reply of [
  'OK ',
  'anything',
  'SAVE_STATE_SLOT 1',
  'LOAD_STATE_SLOT 0',
  'SAVE_STATE_SLOT ERROR disk full',
]) {
  test(`state rejects unexpected/error reply ${reply}`, async () => {
    const f = runtime();
    const channel = new CommandChannel(f.core, { deadlineMs: 100, pollMs: 1 });
    const result = channel.run('SAVE_STATE_SLOT 0');
    await tick();
    f.replies.push(reply);
    await assert.rejects(result);
  });
}

test('battery accepts only OK with trailing CR/LF, including unchanged SRAM', async () => {
  const f = runtime();
  const channel = new CommandChannel(f.core);
  const result = channel.run('SAVE_FILES');
  await tick();
  f.replies.push('OK\n');
  await result;
  assert.deepEqual(f.sent, ['SAVE_FILES']);
});

test('timeout quarantines late replies and queued commands until a new document', async () => {
  const f = runtime();
  const channel = new CommandChannel(f.core, { deadlineMs: 10, pollMs: 1 });
  await assert.rejects(channel.run('SAVE_FILES'), /reload/i);
  f.replies.push('OK\n');
  await assert.rejects(channel.run('SAVE_FILES'), /reload/i);
  assert.deepEqual(f.sent, ['SAVE_FILES']);
});

test('a reply queued after the deadline cannot succeed when the polling timer resumes late', async () => {
  const f = runtime();
  const channel = new CommandChannel(f.core, { deadlineMs: 10, pollMs: 30 });
  const result = channel.run('SAVE_FILES');
  setTimeout(() => f.replies.push('OK\n'), 15);
  await assert.rejects(result, /timed out/i);
});

test('option queries and saves share a single reply owner', async () => {
  const f = runtime();
  const channel = new CommandChannel(f.core, { deadlineMs: 1000, pollMs: 1 });
  const query = Reflect.get(channel, 'listOptions');
  assert.equal(typeof query, 'function', 'core options need the same owner as saves');
  const options = query.call(channel);
  const save = channel.run('SAVE_FILES');
  await tick();
  assert.deepEqual(f.sent, ['GET_CORE_OPTION']);
  f.replies.push('region\tAuto\tRegion\nram_fill\tfill $ff\tRAM Fill (Restart)\n');
  assert.deepEqual(await options, [
    { key: 'region', value: 'Auto', description: 'Region' },
    { key: 'ram_fill', value: 'fill $ff', description: 'RAM Fill (Restart)' },
  ]);
  await tick();
  assert.deepEqual(f.sent, ['GET_CORE_OPTION', 'SAVE_FILES']);
  f.replies.push('OK');
  await save;
});

test('option detail validates allowed values and rejects wrong-key replies before another save', async () => {
  const f = runtime();
  const channel = new CommandChannel(f.core, { deadlineMs: 1000, pollMs: 1 });
  const option = Reflect.get(channel, 'option');
  assert.equal(typeof option, 'function');
  const pending = option.call(channel, 'region');
  await tick();
  f.replies.push('other\tAuto\tRegion\tAuto|PAL\n');
  await assert.rejects(pending, /option|reply/i);
  await assert.rejects(channel.run('SAVE_FILES'), /quarantined/i);
  assert.deepEqual(f.sent, ['GET_CORE_OPTION region']);
});

test('core option input injection is rejected without sending or poisoning saves', async () => {
  const f = runtime();
  const channel = new CommandChannel(f.core);
  const set = Reflect.get(channel, 'setOption');
  assert.equal(typeof set, 'function');
  await assert.rejects(async () => set.call(channel, 'region\nSAVE_FILES', 'Auto'));
  await assert.rejects(async () => set.call(channel, 'region', 'Auto\r\nSAVE_FILES'));
  const save = channel.run('SAVE_FILES');
  await tick();
  f.replies.push('OK');
  await save;
  assert.deepEqual(f.sent, ['SAVE_FILES']);
});

test('explicit core-options unsupported response preserves a healthy save channel', async () => {
  const f = runtime();
  const channel = new CommandChannel(f.core, { deadlineMs: 1000, pollMs: 1 });
  const query = Reflect.get(channel, 'listOptions');
  assert.equal(typeof query, 'function');
  const pending = query.call(channel);
  await tick();
  f.replies.push('GET_CORE_OPTION ERROR this core has no options\n');
  await assert.rejects(pending, /no options|unsupported/i);
  const save = channel.run('SAVE_FILES');
  await tick();
  f.replies.push('OK');
  await save;
});
