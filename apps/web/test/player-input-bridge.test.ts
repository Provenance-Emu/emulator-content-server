import assert from 'node:assert/strict';
import test from 'node:test';
import { installInputAdapter } from '../src/player/input-bridge.js';
import { createInputEngine } from '../src/player/input-engine.js';
import { defaultMapping } from '../src/player/input-model.js';

/** Controlled DOM/task sources; the installed adapter and input engine are real. */
function browserFixture() {
  let now = 0;
  const window = new EventTarget(),
    canvas = new EventTarget(),
    document = Object.assign(new EventTarget(), { hidden: false, activeElement: canvas }),
    navigator = { getGamepads: () => [] as Gamepad[] },
    intervals = new Map<number, () => void>(),
    tasks = new Map<number, () => void>(),
    previous = new Map<string, PropertyDescriptor | undefined>();
  let next = 0;
  for (const [key, value] of Object.entries({
    navigator,
    document,
    performance: { now: () => now },
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    dispatchEvent: window.dispatchEvent.bind(window),
    setInterval: (callback: () => void) => {
      intervals.set(++next, callback);
      return next;
    },
    clearInterval: (id: number) => intervals.delete(id),
    setTimeout: (callback: () => void) => {
      tasks.set(++next, callback);
      return next;
    },
    clearTimeout: (id: number) => tasks.delete(id),
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const adapter = installInputAdapter(
    canvas as HTMLCanvasElement,
    defaultMapping(),
    createInputEngine,
  );
  adapter.start();
  let sequence = 0;
  return {
    adapter,
    time(value: number) {
      now = value;
    },
    packet(x: number | null, active = true) {
      adapter.packet({
        sequence: ++sequence,
        active,
        sources: x === null ? [] : [{ id: 'finger', port: 0, buttons: 0, axes: [x, 0, 0, 0] }],
      });
    },
    axis() {
      return navigator.getGamepads()[0]?.axes[0];
    },
    timer() {
      for (const callback of [...intervals.values()]) callback();
    },
    hide() {
      document.hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    pendingTasks() {
      return tasks.size;
    },
    nextTurn() {
      const queued = [...tasks.values()];
      tasks.clear();
      for (const callback of queued) callback();
    },
    close() {
      adapter.dispose();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('native polls inside a long guest turn do not expire queued live host input', () => {
  const f = browserFixture();
  try {
    f.packet(null);
    f.packet(0.8);
    assert.equal(f.axis(), 0.8);
    f.time(900);
    assert.equal(f.axis(), 0.8, 'a synchronous guest turn cannot deliver host heartbeats');
    f.timer();
    f.packet(0.8); // A queued host MessagePort task runs before deferred expiry.
    f.nextTurn();
    assert.equal(f.axis(), 0.8, 'fresh host input survives the deferred watchdog');
  } finally {
    f.close();
  }
});

test('watchdog deferral is bounded to one pending task and disposal cancels it', () => {
  const f = browserFixture();
  try {
    f.packet(null);
    f.packet(0.8);
    f.time(900);
    f.timer();
    f.timer();
    assert.equal(f.pendingTasks(), 1);
    f.adapter.dispose();
    assert.equal(f.pendingTasks(), 0);
    f.nextTurn();
    f.timer();
    assert.equal(f.pendingTasks(), 0);
  } finally {
    f.close();
  }
});

test('the scheduled watchdog still releases missing heartbeats and rejects held resurrection', () => {
  const f = browserFixture();
  try {
    f.packet(null);
    f.packet(0.8);
    f.time(751);
    f.timer();
    f.nextTurn();
    assert.equal(f.axis(), 0);
    f.adapter.packet({ sequence: 1, active: true, sources: [] });
    f.packet(0.8);
    assert.equal(f.axis(), 0, 'stale neutral and fresh held input cannot rearm an expired session');
    f.packet(0);
    f.packet(0.8);
    assert.equal(f.axis(), 0.8, 'neutral recovery still requires a fresh neutral packet');
  } finally {
    f.close();
  }
});

test('inactive, invalid and capture releases stay immediate during watchdog grace', () => {
  const f = browserFixture();
  try {
    f.packet(null);
    f.packet(0.8);
    f.time(900);
    f.timer();
    f.packet(null, false);
    assert.equal(f.axis(), 0);
    f.nextTurn();
    f.packet(0.8);
    assert.equal(f.axis(), 0, 'explicit inactive still requires an empty packet');
    f.packet(null);
    f.packet(0.8);
    assert.throws(() =>
      f.adapter.packet({
        sequence: 100,
        active: true,
        sources: [{ id: 'bad', port: 4, buttons: 0, axes: [0, 0, 0, 0] }],
      }),
    );
    assert.equal(f.axis(), 0);
    f.packet(null);
    f.packet(0.8);
    f.adapter.capture({ kind: 'keyboard', port: 0 });
    assert.equal(f.axis(), 0);
    f.adapter.capture(null);
    f.packet(0.8);
    assert.equal(f.axis(), 0.8);
    f.hide();
    assert.equal(f.axis(), 0, 'document visibility loss releases input synchronously');
  } finally {
    f.close();
  }
});
