import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreferenceStore } from '../src/player/preferences.js';
import { fixture } from './player-fixture.js';

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
    data,
  };
}
test('game overrides take precedence without mutating core or crossing build/source/origin', () => {
  const s = storage(),
    core = fixture().core;
  const one = createPreferenceStore('http://ecs.test', core, 'item:one', s);
  one.remember('core', { options: { region: 'Auto', palette: 'rgb' }, shader: 'scanlines' });
  one.remember('game', { options: { region: 'PAL' } });
  assert.deepEqual(one.load().preferences, {
    options: { region: 'PAL', palette: 'rgb' },
    shader: 'scanlines',
  });
  assert.deepEqual(
    createPreferenceStore('http://ecs.test', core, 'source:two', s).load().preferences,
    { options: { region: 'Auto', palette: 'rgb' }, shader: 'scanlines' },
  );
  assert.deepEqual(
    createPreferenceStore('http://other.test', core, 'item:one', s).load().preferences,
    { options: {}, shader: 'off' },
  );
  assert.equal(
    createPreferenceStore(
      'http://ecs.test',
      { ...core, wasm: { ...core.wasm, sha256: 'c'.repeat(64) } },
      'item:one',
      s,
    ).load().preferences.shader,
    'off',
  );
  one.clear('game');
  assert.equal(one.load().preferences.options.region, 'Auto');
});
test('corrupt, oversized, injected and unavailable local storage cannot prevent playback', () => {
  const s = storage(),
    store = createPreferenceStore('http://ecs.test', fixture().core, undefined, s);
  store.remember('core', { options: { region: 'Auto' } });
  const key = [...s.data.keys()][0]!;
  for (const data of [
    '{',
    ' '.repeat(131073),
    '{"options":{"region":"a\\nSAVE_FILES"}}',
    '{"options":{},"shader":"../../evil"}',
  ]) {
    s.data.set(key, data);
    assert.deepEqual(store.load().preferences, { options: {}, shader: 'off' });
    assert.ok(store.load().warning);
  }
  const denied = createPreferenceStore('http://ecs.test', fixture().core, undefined, {
    getItem() {
      throw Error('denied');
    },
    setItem() {
      throw Error('denied');
    },
    removeItem() {
      throw Error('denied');
    },
  });
  assert.equal(denied.load().preferences.shader, 'off');
  assert.ok(denied.load().warning);
  assert.throws(() => denied.remember('core', { options: {} }), /denied/);
  assert.throws(() => store.remember('game', { options: {} }), /game/i);
});
