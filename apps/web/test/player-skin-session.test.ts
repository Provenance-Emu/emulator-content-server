import assert from 'node:assert/strict';
import test from 'node:test';
import { indexedDB } from 'fake-indexeddb';
import { createInputPreferences } from '../src/player/input-preferences.js';
import { InputSession } from '../src/player/input-session.js';
import type { PlayerRuntime } from '../src/player/runtime.js';
import { readSkinArchive } from '../src/player/skins/archive.js';
import { SkinLibrary } from '../src/player/skins/library.js';
import { SkinSession } from '../src/player/skins/session.js';
import { fixture } from './player-fixture.js';
import { skinZip } from './skin-fixture.js';

test('skin session applies atomically, stores exact-hash overrides and recovers from removal', async (t) => {
  const data = new Map<string, string>(),
    f = fixture(),
    input = new InputSession(
      { sendInput() {} } as unknown as PlayerRuntime,
      createInputPreferences('http://ecs.test', f.core, 'item:1', {
        getItem: (k) => data.get(k) ?? null,
        setItem: (k, v) => {
          data.set(k, v);
        },
        removeItem: (k) => {
          data.delete(k);
        },
      }),
    );
  input.ready = true;
  const lib = new SkinLibrary('session-' + Math.random(), indexedDB);
  let released = 0;
  const s = new SkinSession(input, lib, 'scope', 'game', 'nes', {
    render: async () => ({
      url: 'blob:test',
      width: 360,
      height: 520,
      release() {
        released++;
      },
    }),
  });
  t.after(() => {
    s.dispose();
    lib.close();
  });
  await s.initialize();
  const pkg = await readSkinArchive(await skinZip());
  await s.preview(pkg, {});
  assert.equal(input.layout.id, 'builtin-compact');
  await s.apply();
  assert.match(input.layout.id, /^skin-/);
  input.beginEdit();
  input.changeControl('item-0', { opacity: 0.5 });
  input.applyEdit();
  await input.remember('game');
  assert.equal((await lib.getPreference('scope:game'))?.basis, pkg.id);
  assert.equal(
    (await lib.getPreference('scope:game'))?.overrides.portrait?.controls[0]?.opacity,
    0.5,
  );
  assert.ok(![...data.values()].some((t) => t.includes('asset-')));
  await lib.remove(pkg.id);
  await s.checkLibrary();
  assert.equal(input.layout.id, 'builtin-compact');
  assert.ok(released > 0);
  s.dispose();
  lib.close();
});
test('an older preview failure cannot overwrite a newer successful preview', async (t) => {
  const f = fixture(),
    input = new InputSession(
      { sendInput() {} } as unknown as PlayerRuntime,
      createInputPreferences('http://ecs.test', f.core, undefined, {
        getItem: () => null,
        setItem() {},
        removeItem() {},
      }),
    );
  input.ready = true;
  const lib = new SkinLibrary('stale-' + Math.random(), indexedDB);
  let rejectOld: (e: Error) => void = () => {};
  let call = 0;
  const s = new SkinSession(input, lib, 'scope', undefined, 'nes', {
    render: async () => {
      call++;
      if (call === 1) return new Promise((_r, reject) => (rejectOld = reject));
      return { url: 'blob:new', width: 360, height: 520, release() {} };
    },
  });
  t.after(() => s.dispose());
  const pkg = await readSkinArchive(await skinZip());
  const old = s.preview(pkg, {});
  await new Promise((r) => setTimeout(r, 0));
  await s.preview({ ...pkg, name: 'Newer' }, {});
  rejectOld(Error('Old preview failed'));
  await old;
  assert.equal(s.previewPackage?.name, 'Newer');
  assert.equal(s.error, null);
});
test('remember captures the chosen skin even if a newer layout becomes active during storage', async (t) => {
  const f = fixture(),
    input = new InputSession(
      { sendInput() {} } as unknown as PlayerRuntime,
      createInputPreferences('http://ecs.test', f.core, undefined, {
        getItem: () => null,
        setItem() {},
        removeItem() {},
      }),
    );
  input.ready = true;
  const lib = new SkinLibrary('remember-race-' + Math.random(), indexedDB),
    s = new SkinSession(input, lib, 'scope', undefined, 'nes', {
      render: async () => ({ url: 'blob:test', width: 360, height: 520, release() {} }),
    });
  t.after(() => s.dispose());
  await s.initialize();
  const pkg = await readSkinArchive(await skinZip());
  await s.preview(pkg, {});
  await s.apply();
  const put = lib.put.bind(lib);
  let proceed: () => void = () => {};
  const gate = new Promise<void>((r) => (proceed = r));
  lib.put = async (p) => {
    await gate;
    await put(p);
  };
  const pending = s.remember('core', true);
  await s.useBuiltin('standard');
  proceed();
  await pending;
  assert.equal((await lib.getPreference('scope'))?.basis, pkg.id);
  assert.equal(input.layout.id, 'builtin-standard');
});
test('remembering a portrait edit does not pin an inherited landscape representation', async (t) => {
  const f = fixture(),
    input = new InputSession(
      { sendInput() {} } as unknown as PlayerRuntime,
      createInputPreferences('http://ecs.test', f.core, 'game', {
        getItem: () => null,
        setItem() {},
        removeItem() {},
      }),
    );
  input.ready = true;
  const lib = new SkinLibrary('skin-scopes-' + Math.random(), indexedDB),
    s = new SkinSession(input, lib, 'scope', 'game', 'nes', {
      render: async () => ({ url: 'blob:test', width: 360, height: 520, release() {} }),
    });
  t.after(() => s.dispose());
  await s.initialize();
  const info = (await import('./skin-fixture.js')).skinInfo(),
    portrait = info.representations.iphone.edgeToEdge.portrait;
  const pkg = await readSkinArchive(
    await skinZip({
      ...info,
      representations: {
        iphone: {
          edgeToEdge: { portrait, landscape: portrait },
          standard: { landscape: portrait },
        },
      },
    }),
  );
  await s.preview(pkg, { landscape: 'iphone/edgeToEdge/landscape' });
  await s.apply();
  await s.remember('core', true);
  input.beginEdit();
  input.changeControl('item-0', { opacity: 0.5 });
  input.applyEdit();
  await input.remember('game');
  assert.equal((await lib.getPreference('scope:game'))?.choices.landscape, undefined);
});

function persistenceSession(t: { after(fn: () => void): void }) {
  const f = fixture(),
    input = new InputSession(
      { sendInput() {} } as unknown as PlayerRuntime,
      createInputPreferences('http://ecs.test', f.core, 'game', {
        getItem: () => null,
        setItem() {},
        removeItem() {},
      }),
    );
  input.ready = true;
  const lib = new SkinLibrary('async-skins-' + Math.random(), indexedDB),
    s = new SkinSession(input, lib, 'scope', 'game', 'nes');
  t.after(() => s.dispose());
  return { input, lib, s };
}
function gatePreference(lib: SkinLibrary) {
  const put = lib.putPreference.bind(lib);
  let resume: () => void = () => {},
    entered: () => void = () => {};
  const gate = new Promise<void>((r) => (resume = r)),
    ready = new Promise<void>((r) => (entered = r));
  lib.putPreference = async (...args) => {
    entered();
    await gate;
    return put(...args);
  };
  return { ready, resume };
}
test('edits made during persistence remain dirty for the next remember', async (t) => {
  const { input, lib, s } = persistenceSession(t);
  await s.initialize();
  input.beginEdit();
  input.changeControl('a', { opacity: 0.5 });
  input.applyEdit();
  const gate = gatePreference(lib),
    pending = input.remember('core');
  await gate.ready;
  input.beginEdit();
  input.changeControl('a', { opacity: 0.75 });
  input.applyEdit();
  gate.resume();
  await pending;
  await input.remember('core');
  assert.equal(
    (await lib.getPreference('scope'))?.overrides.portrait?.controls.find((c) => c.id === 'a')
      ?.opacity,
    0.75,
  );
});
test('clear requested during remember runs after that write and does not resurrect preferences', async (t) => {
  const { input, lib, s } = persistenceSession(t);
  await s.initialize();
  input.beginEdit();
  input.changeControl('a', { opacity: 0.5 });
  input.applyEdit();
  const gate = gatePreference(lib),
    pending = s.remember('core');
  await gate.ready;
  const clearing = s.clear('core');
  gate.resume();
  await Promise.all([pending, clearing]);
  assert.equal(await lib.getPreference('scope'), undefined);
});
