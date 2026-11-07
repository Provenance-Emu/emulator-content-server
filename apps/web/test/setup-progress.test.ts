import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';
import {
  createSetupProgress,
  readSetupProgress,
  setupProgressKey,
} from '../src/lib/setup-progress.js';

test('setup resumes per server without storing credentials or folder paths', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const guide = createSetupProgress('http://example.test', 'host', storage);
  guide.update({ step: 'emulators', libraryId: 'library', paused: true });
  assert.equal(readSetupProgress('http://second.test', storage), null);
  assert.equal(readSetupProgress('http://example.test:8473', storage), null);
  assert.deepEqual(get(createSetupProgress('http://example.test', 'host', storage)), {
    step: 'emulators',
    mode: 'host',
    libraryId: 'library',
    done: false,
    paused: false,
  });
  storage.setItem(setupProgressKey('http://example.test'), '{"step":"execute-shell"}');
  assert.equal(readSetupProgress('http://example.test', storage), null);
});
test('setup remains usable when browser storage is unavailable', () => {
  const storage = {
    getItem() {
      throw Error('blocked');
    },
    setItem() {
      throw Error('blocked');
    },
  };
  const guide = createSetupProgress('http://example.test', 'join', storage);
  guide.update({ step: 'ready', done: true });
  assert.equal(get(guide).done, true);
});

test('changing between hosting and joining restarts account guidance and retains the library choice', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  createSetupProgress('http://example.test', 'host', storage).update({
    step: 'ready',
    done: true,
    libraryId: 'existing',
  });
  assert.deepEqual(get(createSetupProgress('http://example.test', 'join', storage)), {
    step: 'account',
    mode: 'join',
    libraryId: 'existing',
    done: false,
    paused: false,
  });
  storage.setItem(
    setupProgressKey('http://example.test'),
    JSON.stringify({
      ...get(createSetupProgress('http://example.test', 'join', storage)),
      token: 'generated-untrusted-extra',
    }),
  );
  const resumed = createSetupProgress('http://example.test', 'join', storage);
  resumed.update({ step: 'library' });
  assert.equal(values.get(setupProgressKey('http://example.test'))?.includes('token'), false);
});
