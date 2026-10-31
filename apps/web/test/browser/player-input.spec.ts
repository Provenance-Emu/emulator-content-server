import { resolve } from 'node:path';
import { build } from 'vite';
import { expect, test } from './fixture';

test.use({ headless: true });
test.setTimeout(60000);
let harness = '';
test.beforeAll(async () => {
  const id = resolve('input-test-harness');
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'input-harness',
        resolveId(value) {
          if (value === id) return value;
        },
        load(value) {
          if (value === id)
            return `export {importBrowserRuntime} from ${JSON.stringify(resolve('src/player/runtime.ts'))};export {defaultMapping} from ${JSON.stringify(resolve('src/player/input-model.ts'))};export {installInputAdapter} from ${JSON.stringify(resolve('src/player/input-bridge.ts'))};export {createInputEngine} from ${JSON.stringify(resolve('src/player/input-engine.ts'))};`;
        },
      },
    ],
    build: { write: false, minify: false, target: 'es2022', lib: { entry: id, formats: ['es'] } },
  });
  const output = Array.isArray(result) ? result[0] : result;
  const chunk = output?.output.find((c) => c.type === 'chunk' && c.isEntry);
  if (chunk?.type !== 'chunk') throw Error('No input harness');
  harness = chunk.code;
});
test('realtime touch bypasses a busy RPC, preserves taps, and watchdog releases the native virtual pad', async ({
  page,
  fixture,
}) => {
  await page.route('**/ui/input-test.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: harness }),
  );
  await page.goto(`${fixture.origin}/play/`);
  const result = await page.evaluate(async () => {
    const api = await import('/ui/input-test.js'),
      logs: string[] = [];
    const loader = new TextEncoder().encode(
      `export default async o=>{const m={FS:{mkdirTree(){},writeFile(){},async readFile(){await new Promise(r=>setTimeout(r,350));return new Uint8Array([1])}},callMain(){const ctx=o.canvas.getContext('2d');let previous=false;function draw(){const pads=navigator.getGamepads();const a=!!pads[0]?.buttons[1]?.pressed;if(a!==previous){o.print('a='+a);previous=a;}ctx.fillRect(0,0,20,20);m.postMainLoop?.();requestAnimationFrame(draw)}draw()}};return m;}`,
    );
    const loaded = await api.importBrowserRuntime(loader, {
      profile: { saveCompletion: 'none' },
      inputEnabled: true,
    });
    const runtime = await loaded.factory({
      wasmBinary: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      canvas: document.querySelector('canvas'),
      noInitialRun: true,
      noExitRuntime: true,
      locateFile: (s: string) => s,
      print: (s: string) => logs.push(s),
      printErr: (s: string) => logs.push(s),
    });
    await runtime.callMain([]);
    await runtime.focus();
    await new Promise((r) => setTimeout(r, 100));
    const info = await runtime.inputInfo();
    const slow = runtime.FS.readFile('/ecs/slow');
    runtime.sendInput({ sequence: 1, active: true, sources: [] });
    runtime.sendInput({
      sequence: 2,
      active: true,
      sources: [{ id: 'finger', port: 0, buttons: 256, axes: [0, 0, 0, 0] }],
    });
    runtime.sendInput({ sequence: 3, active: true, sources: [] });
    await new Promise((r) => setTimeout(r, 180));
    const during = logs.slice();
    await slow;
    runtime.sendInput({
      sequence: 4,
      active: true,
      sources: [{ id: 'finger', port: 0, buttons: 256, axes: [0, 0, 0, 0] }],
    });
    await new Promise((r) => setTimeout(r, 900));
    const after = await runtime.inputInfo();
    loaded.release();
    return { info, during, after, logs };
  });
  expect(result.info.ready).toBe(true);
  expect(result.during).toContain('a=true');
  expect(result.after.states[0].buttons).toBe(0);
  expect(result.logs).toContain('a=false');
});

test('pad mode blocks old native bindings and suppresses held repeats after release', async ({
  page,
  fixture,
}) => {
  await page.route('**/ui/input-test.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: harness }),
  );
  await page.goto(`${fixture.origin}/play/`);
  const result = await page.evaluate(async () => {
    const api = await import('/ui/input-test.js'),
      canvas = document.querySelector('canvas')!;
    const map = api.defaultMapping();
    map.ports[0].keys.a = 'KeyC';
    const adapter = api.installInputAdapter(canvas, map, api.createInputEngine);
    adapter.start();
    navigator.getGamepads();
    adapter.afterFrame();
    navigator.getGamepads();
    adapter.packet({ sequence: 1, active: true, sources: [] });
    canvas.focus();
    const event = (code: string, repeat = false) => {
      const e = new KeyboardEvent('keydown', { code, repeat, bubbles: true, cancelable: true });
      canvas.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const old = event('KeyX'),
      mapped = event('KeyC');
    const pressed = adapter.info().states[0].buttons;
    adapter.packet({ sequence: 2, active: false, sources: [] });
    const editing = event('KeyX');
    adapter.packet({ sequence: 3, active: true, sources: [] });
    event('KeyC', true);
    const repeated = adapter.info().states[0].buttons;
    adapter.dispose();
    return { old, mapped, pressed, editing, repeated };
  });
  expect(result.old).toBe(true);
  expect(result.mapped).toBe(true);
  expect(result.pressed).toBe(256);
  expect(result.editing).toBe(true);
  expect(result.repeated).toBe(0);
});
test('controller assignment, neutral capture, axes, disconnect and mouse pulses stay isolated', async ({
  page,
  fixture,
}) => {
  await page.route('**/ui/input-test.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: harness }),
  );
  await page.goto(`${fixture.origin}/play/`);
  const result = await page.evaluate(async () => {
    const api = await import('/ui/input-test.js'),
      canvas = document.querySelector('canvas')!;
    const pad = {
      id: 'Raw controller',
      index: 3,
      connected: true,
      mapping: '',
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
      axes: [0, 0, 0, 0],
      timestamp: 0,
    };
    const previous = Object.getOwnPropertyDescriptor(navigator, 'getGamepads');
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => [null, null, null, pad],
    });
    const map = api.defaultMapping();
    map.mouseMode = 'pad';
    map.ports[0].mouse = { a: 0, b: 5 };
    map.ports[0].axes[0].inverted = true;
    const adapter = api.installInputAdapter(canvas, map, api.createInputEngine);
    adapter.start();
    navigator.getGamepads();
    adapter.afterFrame();
    navigator.getGamepads();
    pad.buttons[1].pressed = true;
    adapter.configure(map, [3, null, null, null], 0);
    adapter.packet({ sequence: 1, active: true, sources: [] });
    const held = adapter.info().states[0].buttons;
    pad.buttons[1].pressed = false;
    adapter.info();
    pad.buttons[1].pressed = true;
    pad.axes[0] = 0.575;
    const pressed = adapter.info().states[0];
    adapter.capture({ kind: 'controller', port: 0 });
    const capturedHeld = adapter.info().capture;
    pad.buttons[1].pressed = false;
    pad.axes[0] = 0;
    adapter.info();
    pad.buttons[2].pressed = true;
    const captured = adapter.info();
    adapter.capture(null);
    pad.buttons[2].pressed = false;
    pad.axes[0] = 0.7;
    map.ports[0].deadzone = 0.8;
    adapter.configure(map, [3, null, null, null], 0);
    adapter.capture({ kind: 'controller', port: 0 });
    const axisHeldCapture = adapter.info().capture;
    pad.axes[0] = 0;
    map.ports[0].deadzone = 0.15;
    adapter.configure(map, [3, null, null, null], 0);
    adapter.capture(null);
    pad.buttons[2].pressed = false;
    adapter.info();
    pad.buttons[1].pressed = true;
    adapter.info();
    pad.connected = false;
    const disconnected = adapter.info().states[0].buttons;
    canvas.focus();
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }),
    );
    const mouse = adapter.info().states[0].buttons;
    canvas.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
    navigator.getGamepads();
    adapter.afterFrame();
    canvas.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }),
    );
    const wheel = adapter.info().states[0].buttons;
    navigator.getGamepads();
    adapter.afterFrame();
    const released = adapter.info().states[0].buttons;
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }),
    );
    navigator.getGamepads();
    adapter.afterFrame();
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
    const outside = adapter.info().states[0].buttons;
    map.mouseMode = 'native';
    adapter.configure(map, [null, null, null, null]);
    adapter.packet({ sequence: 2, active: true, sources: [] });
    let nativeUps = 0;
    canvas.addEventListener('mouseup', () => nativeUps++);
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }),
    );
    adapter.packet({ sequence: 3, active: false, sources: [] });
    const duplicate = (() => {
      try {
        adapter.configure(map, [3, 3, null, null], 0);
        return false;
      } catch {
        return true;
      }
    })();
    adapter.dispose();
    if (previous) Object.defineProperty(navigator, 'getGamepads', previous);
    else delete (navigator as unknown as Record<string, unknown>).getGamepads;
    return {
      held,
      pressed,
      capturedHeld,
      axisHeldCapture,
      captured,
      disconnected,
      mouse,
      wheel,
      released,
      duplicate,
      outside,
      nativeUps,
    };
  });
  expect(result.held).toBe(0);
  expect(result.pressed.buttons).toBe(256);
  expect(result.pressed.axes[0]).toBeCloseTo(-0.5);
  expect(result.capturedHeld).toBe(null);
  expect(result.axisHeldCapture).toBe(null);
  expect(result.captured.capture).toEqual({
    kind: 'controller',
    pad: { kind: 'button', index: 2 },
  });
  expect(result.captured.states[0].buttons).toBe(0);
  expect(result.disconnected).toBe(0);
  expect(result.mouse).toBe(256);
  expect(result.wheel).toBe(1);
  expect(result.released).toBe(0);
  expect(result.duplicate).toBe(true);
  expect(result.outside).toBe(0);
  expect(result.nativeUps).toBe(1);
});
test('watchdog releases native keys and re-arms held controllers only after neutral; reconnection requires assignment', async ({
  page,
  fixture,
}) => {
  await page.route('**/ui/input-test.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: harness }),
  );
  await page.goto(`${fixture.origin}/play/`);
  const result = await page.evaluate(async () => {
    const api = await import('/ui/input-test.js'),
      canvas = document.querySelector('canvas')!;
    const pad = {
      id: 'Same model',
      index: 0,
      connected: true,
      mapping: 'standard',
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
      axes: [0, 0, 0, 0],
    };
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] });
    const map = api.defaultMapping();
    map.keyboardMode = 'native';
    const adapter = api.installInputAdapter(canvas, map, api.createInputEngine);
    adapter.start();
    navigator.getGamepads();
    adapter.afterFrame();
    navigator.getGamepads();
    adapter.configure(map, [0, null, null, null], 0);
    adapter.packet({ sequence: 1, active: true, sources: [] });
    canvas.focus();
    adapter.info();
    let ups = 0;
    canvas.addEventListener('keyup', () => ups++);
    canvas.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', key: 'c', bubbles: true }));
    pad.buttons[1].pressed = true;
    adapter.info();
    await new Promise((r) => setTimeout(r, 900));
    const upsAtExpiry = ups;
    adapter.packet({ sequence: 2, active: true, sources: [] });
    const resumed = adapter.info().states[0].buttons;
    pad.buttons[1].pressed = false;
    adapter.info();
    pad.buttons[1].pressed = true;
    const fresh = adapter.info().states[0].buttons;
    pad.connected = false;
    adapter.info();
    pad.connected = true;
    pad.buttons[1].pressed = false;
    adapter.info();
    pad.buttons[1].pressed = true;
    const reconnected = adapter.info().states[0].buttons;
    adapter.configure(map, [0, null, null, null]);
    pad.buttons[1].pressed = false;
    adapter.info();
    pad.buttons[1].pressed = true;
    const staleConfig = adapter.info();
    adapter.dispose();
    return { ups: upsAtExpiry, resumed, fresh, reconnected, staleConfig };
  });
  expect.soft(result.ups).toBe(1);
  expect.soft(result.resumed).toBe(0);
  expect(result.fresh).toBe(256);
  expect.soft(result.reconnected).toBe(0);
  expect(result.staleConfig.states[0].buttons).toBe(0);
  expect(result.staleConfig.assignments[0]).toBe(null);
});
