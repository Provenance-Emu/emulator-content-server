import assert from 'node:assert/strict';
import test from 'node:test';
import { createInputPreferences } from '../src/player/input-preferences.js';
import { fixture } from './player-fixture.js';

test('input preferences merge only edited keys, isolate builds, and reject connection-index persistence', () => {
  const data = new Map<string, string>(),
    storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v);
      },
      removeItem: (k: string) => {
        data.delete(k);
      },
    },
    core = fixture().core;
  const store = createInputPreferences('http://ecs.test', core, 'item:1', storage);
  store.remember('core', { 'key.0.a': 'KeyC' });
  store.remember('game', { 'key.0.b': 'KeyV' });
  store.remember('core', { 'key.0.a': 'KeyD' });
  assert.equal(store.load().map.ports[0]?.keys.a, 'KeyD');
  assert.equal(store.load().map.ports[0]?.keys.b, 'KeyV');
  assert.equal(
    createInputPreferences('http://ecs.test', core, 'item:2', storage).load().map.ports[0]?.keys.b,
    'KeyZ',
  );
  assert.equal(
    createInputPreferences(
      'http://ecs.test',
      { ...core, wasm: { ...core.wasm, sha256: 'e'.repeat(64) } },
      'item:1',
      storage,
    ).load().map.ports[0]?.keys.a,
    'KeyX',
  );
  assert.throws(() => store.remember('game', { 'assignment.0': 2 }));
  for (const k of data.keys()) data.set(k, '{');
  assert.ok(store.load().warning);
  assert.equal(store.load().map.ports[0]?.keys.a, 'KeyX');
});
test('a newly conflicting inherited binding falls back to the valid core scope, and blocked storage stays usable', () => {
  const data = new Map<string, string>(),
    storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v);
      },
      removeItem: (k: string) => {
        data.delete(k);
      },
    },
    core = fixture().core;
  const store = createInputPreferences('http://ecs.test', core, 'item:1', storage);
  store.remember('core', { 'key.0.a': 'KeyC' });
  store.remember('game', { 'key.0.b': 'KeyV' });
  store.remember('core', { 'key.0.a': 'KeyV' });
  const loaded = store.load();
  assert.ok(loaded.warning);
  assert.equal(loaded.map.ports[0]?.keys.a, 'KeyV');
  assert.equal(loaded.map.ports[0]?.keys.b, 'KeyZ');
  const unavailable = createInputPreferences('http://ecs.test', core, undefined, {
    getItem() {
      throw Error('Private mode');
    },
    setItem() {
      throw Error('Private mode');
    },
    removeItem() {
      throw Error('Private mode');
    },
  });
  assert.ok(unavailable.load().warning);
  assert.equal(unavailable.load().map.ports[0]?.keys.a, 'KeyX');
  assert.throws(() => unavailable.remember('core', { 'key.0.a': 'KeyC' }), /Private mode/);
});
test('game overrides may use a key freed by an inherited core mapping', () => {
  const data = new Map<string, string>(),
    storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v);
      },
      removeItem: (k: string) => {
        data.delete(k);
      },
    };
  const store = createInputPreferences('http://ecs.test', fixture().core, 'item:1', storage);
  store.remember('core', { 'key.0.b': null });
  store.remember('game', { 'key.0.a': 'KeyZ' });
  assert.equal(store.load().map.ports[0]?.keys.a, 'KeyZ');
  assert.equal(store.load().map.ports[0]?.keys.b, undefined);
  assert.equal(store.load().warning, null);
});
