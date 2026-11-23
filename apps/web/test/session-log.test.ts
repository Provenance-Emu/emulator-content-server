import assert from 'node:assert/strict';
import test from 'node:test';
import { addLine, emptyLog, logText } from '../src/player/session-log.js';

test('the reason an emulator stopped survives the chatter that follows it', () => {
  let log = emptyLog();
  log = addLine(log, '[ERROR] [Core]: Unhandled SH4 exception at 8c010000');
  for (let index = 0; index < 500; index += 1) log = addLine(log, `[INFO] menu line ${index}`);
  const text = logText(log);
  assert.match(text, /Unhandled SH4 exception at 8c010000/);
  assert.match(text, /menu line 499/);
  assert.doesNotMatch(text, /menu line 100\b/);
});

test('kept messages are bounded however many problems arrive', () => {
  let log = emptyLog();
  for (let index = 0; index < 1000; index += 1)
    log = addLine(log, `error ${index} ${'x'.repeat(600)}`);
  assert.equal(log.problems.length, 40);
  assert.equal(log.recent.length, 200);
  assert.ok(log.problems.every((line) => line.length <= 300));
  assert.match(log.problems[0] ?? '', /^error 0 /);
});

test('a quiet session has nothing to show', () => {
  assert.equal(logText(emptyLog()), '');
  assert.equal(logText(addLine(emptyLog(), 'ready')), 'ready');
});
