import assert from 'node:assert/strict';
import test from 'node:test';
import { createInputPreferences } from '../src/player/input-preferences.js';
import { InputSession } from '../src/player/input-session.js';
import type { PlayerRuntime } from '../src/player/runtime.js';
import { fixture } from './player-fixture.js';

test('editor cancel/undo preserve applied geometry and only explicit changes enter preference scope', async () => {
  const f = fixture(),
    data = new Map<string, string>(),
    store = createInputPreferences('http://ecs.test', f.core, 'item:1', {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        data.set(k, v);
      },
      removeItem: (k) => {
        data.delete(k);
      },
    });
  const runtime = {
    inputInfo: async () => ({
      supported: true,
      ready: true,
      devices: [],
      states: Array.from({ length: 4 }, () => ({ buttons: 0, axes: [0, 0, 0, 0] })),
      capture: null,
      deviceError: null,
    }),
    configureInput: async () => {},
    sendInput() {},
    captureInput: async () => {},
  } as unknown as PlayerRuntime;
  const s = new InputSession(runtime, store);
  await s.initialize();
  const x = s.layout.representations.portrait.controls[0]!.frame.x;
  s.beginEdit();
  s.checkpoint();
  s.changeControl('left', {
    frame: { ...s.editLayout.representations.portrait.controls[0]!.frame, x: x + 5 },
  });
  s.undo();
  assert.equal(s.editLayout.representations.portrait.controls[0]!.frame.x, x);
  s.changeControl('left', {
    frame: { ...s.editLayout.representations.portrait.controls[0]!.frame, x: x + 10 },
  });
  s.cancelEdit();
  assert.equal(s.layout.representations.portrait.controls[0]!.frame.x, x);
  await assert.rejects(s.bind('a', { kind: 'keyboard', key: 'KeyZ' }), /already bound/i);
  assert.equal(s.map.ports[0]?.keys.a, 'KeyX');
  await s.bind('a', { kind: 'keyboard', key: 'KeyC' });
  s.remember('game');
  assert.equal(store.load().map.ports[0]?.keys.a, 'KeyC');
  assert.equal(store.load().map.ports[0]?.keys.b, 'KeyZ');
});
test('unsupported adapter is removed before native fallback and assignment remembers a model without a connection index', async () => {
  const f = fixture(),
    data = new Map<string, string>(),
    store = createInputPreferences('http://ecs.test', f.core, undefined, {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        data.set(k, v);
      },
      removeItem: (k) => {
        data.delete(k);
      },
    });
  let disabled = false;
  const runtime = {
    inputInfo: async () => ({
      supported: false,
      ready: false,
      devices: [],
      states: [],
      capture: null,
      deviceError: null,
    }),
    disableInput: async () => {
      disabled = true;
    },
    configureInput: async () => {},
    sendInput() {},
  } as unknown as PlayerRuntime;
  const s = new InputSession(runtime, store);
  await s.initialize();
  assert.equal(disabled, true);
  s.ready = true;
  s.info.devices = [{ index: 3, id: 'Test pad', mapping: 'standard', buttons: 17, axes: 4 }];
  await s.assign(3);
  assert.deepEqual(s.models[0], { id: 'Test pad', mapping: 'standard', buttons: 17, axes: 4 });
  s.remember('core');
  assert.deepEqual(store.load().models[0], s.models[0]);
});
test('losing host gameplay ownership invalidates active gestures before input can rearm', async () => {
  const packets: unknown[] = [];
  const runtime = {
    sendInput: (value: unknown) => packets.push(value),
  } as unknown as PlayerRuntime;
  const s = new InputSession(
    runtime,
    createInputPreferences('http://ecs.test', fixture().core, undefined, {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    }),
  );
  s.ready = true;
  s.heartbeat(true);
  s.touch('pointer-1', 256);
  const before = s.gestureEpoch;
  s.heartbeat(false);
  assert.ok(s.gestureEpoch > before);
  s.heartbeat(true);
  assert.deepEqual((packets.at(-1) as { sources: unknown[] }).sources, []);
});
