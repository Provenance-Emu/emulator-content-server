import { createInputEngine } from './input-engine.js';
import type {
  CapturedBinding,
  InputCapture,
  InputInfo,
  MappingConfig,
  TouchPacket,
} from './input-model.js';

/** No outer runtime references: shipped as a first-party Blob module into the opaque guest. */
export function installInputAdapter(
  canvas: HTMLCanvasElement,
  initial: MappingConfig,
  factory: typeof createInputEngine,
) {
  const engine = factory(),
    names = [
      'b',
      'y',
      'select',
      'start',
      'up',
      'down',
      'left',
      'right',
      'a',
      'x',
      'l',
      'r',
      'l2',
      'r2',
      'l3',
      'r3',
    ],
    standard = [0, 2, 8, 9, 12, 13, 14, 15, 1, 3, 4, 5, 6, 7, 10, 11];
  let map = engine.validateConfig(initial),
    assignments: (number | null)[] = [null, null, null, null],
    models: string[] = ['', '', '', ''],
    padArmed = [false, false, false, false];
  let installed = false,
    started = false,
    disposed = false,
    polls = 0,
    frames = 0,
    error: string | null = null,
    capture: InputCapture | null = null,
    captured: CapturedBinding | null = null,
    captureNeutral = false;
  const native = navigator.getGamepads?.bind(navigator),
    previous = Object.getOwnPropertyDescriptor(navigator, 'getGamepads');
  const keys = new Set<string>(),
    rawKeys = new Map<string, KeyboardEvent>(),
    pressedMouse = new Set<number>();
  let flushing = false;
  const capturedPointers = new Set<number>();
  const pads = Array.from({ length: 4 }, (_, index) => ({
    id: 'ECS Virtual RetroPad',
    index,
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  }));
  function physical() {
    try {
      const list = Array.from(native?.() ?? []);
      error = null;
      return list.slice(0, 16);
    } catch {
      error =
        'Controller access is unavailable or denied. Use a secure context and press a controller button.';
      return [];
    }
  }
  const identity = (p: Gamepad) =>
    [p.id.slice(0, 180), p.mapping, p.buttons.length, p.axes.length].join('|');
  function flushKeys() {
    flushing = true;
    for (const e of rawKeys.values())
      canvas.dispatchEvent(
        new KeyboardEvent('keyup', {
          key: e.key,
          code: e.code,
          keyCode: e.keyCode,
          which: e.which,
          bubbles: true,
        }),
      );
    rawKeys.clear();
    flushing = false;
  }
  function flushMouse() {
    flushing = true;
    for (const button of pressedMouse)
      canvas.dispatchEvent(new MouseEvent('mouseup', { button, buttons: 0, bubbles: true }));
    pressedMouse.clear();
    flushing = false;
  }
  function releasePointers() {
    for (const id of capturedPointers) {
      capturedPointers.delete(id);
      try {
        canvas.releasePointerCapture(id);
      } catch {}
    }
  }
  function pointerdown(e: PointerEvent) {
    if (e.pointerType !== 'mouse' || !isReady()) return;
    try {
      canvas.setPointerCapture(e.pointerId);
      capturedPointers.add(e.pointerId);
    } catch {
      e.preventDefault();
    }
  }
  function pointerup(e: PointerEvent) {
    capturedPointers.delete(e.pointerId);
  }
  function pointercancel(e: PointerEvent) {
    if (!capturedPointers.delete(e.pointerId)) return;
    for (const button of pressedMouse)
      for (let port = 0; port < 4; port++) engine.clear(`mouse:${button}:${port}`, true);
    flushMouse();
  }
  function release() {
    engine.release();
    padArmed.fill(false);
    keys.clear();
    flushMouse();
    releasePointers();
    flushKeys();
  }
  function poll() {
    checkHeartbeat();
    const devices = physical();
    for (let port = 0; port < 4; port++) {
      const index = assignments[port],
        p = index === null || index === undefined ? undefined : devices[index],
        config = map.ports[port];
      if (!p?.connected || !config || (models[port] && models[port] !== identity(p))) {
        engine.clear(`pad:${port}`, true);
        padArmed[port] = false;
        if (index !== null) {
          assignments[port] = null;
          models[port] = '';
        }
        continue;
      }
      const neutral =
        p.buttons.every((b) => !b.pressed && b.value < 0.5) &&
        p.axes.every((a) => Math.abs(a) < 0.2);
      if (capture?.kind === 'controller' && capture.port === port) {
        if (neutral) captureNeutral = true;
        if (captureNeutral && !captured) {
          const button = p.buttons.findIndex((b) => b.pressed || b.value > 0.6);
          const axis = p.axes.findIndex((a) => Math.abs(a) > 0.6);
          if (button >= 0 && button < 64)
            captured = { kind: 'controller', pad: { kind: 'button', index: button } };
          else if (axis >= 0 && axis < 16)
            captured = {
              kind: 'controller',
              pad: { kind: 'axis', index: axis, direction: (p.axes[axis] ?? 0) > 0 ? 1 : -1 },
            };
        }
        continue;
      }
      if (capture || !engine.active) {
        engine.clear(`pad:${port}`, true);
        padArmed[port] = false;
        continue;
      }
      if (!padArmed[port]) {
        if (neutral) padArmed[port] = true;
        else continue;
      }
      let buttons = 0;
      for (let i = 0; i < names.length; i++) {
        const binding = config.pads[names[i] as keyof typeof config.pads];
        if (
          binding &&
          (binding.kind === 'button'
            ? (p.buttons[binding.index]?.pressed ?? false)
            : (p.axes[binding.index] ?? 0) * binding.direction > 0.5)
        )
          buttons |= 1 << i;
      }
      const axes = config.axes.map((a) => {
        const v = Number(p.axes[a.index] ?? 0) * (a.inverted ? -1 : 1);
        return Math.abs(v) <= config.deadzone
          ? 0
          : Math.max(-1, Math.min(1, (Math.abs(v) - config.deadzone) / (1 - config.deadzone))) *
              Math.sign(v);
      });
      engine.source(`pad:${port}`, port, buttons, axes);
    }
  }
  function getter() {
    polls++;
    poll();
    for (let port = 0; port < 4; port++) {
      const state = engine.sample(port),
        p = pads[port];
      if (!p) continue;
      p.axes = state.axes;
      p.timestamp = performance.now();
      for (let i = 0; i < 16; i++) {
        const button = p.buttons[standard[i] ?? 0];
        if (button) {
          button.pressed = !!(state.buttons & (1 << i));
          button.touched = button.pressed;
          button.value = button.pressed ? 1 : 0;
        }
      }
    }
    return pads;
  }
  function event(type: string, pad: unknown) {
    const e = new Event(type);
    Object.defineProperty(e, 'gamepad', { value: pad });
    dispatchEvent(e);
  }
  const isReady = () => installed && started && polls > 1 && frames > 0;
  function keydown(e: KeyboardEvent) {
    if (flushing) return;
    if (e.repeat && !keys.has(e.code)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const held = keys.has(e.code);
    keys.add(e.code);
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (capture?.kind === 'keyboard') {
      if (e.code === 'Escape') {
        capture = null;
        return;
      }
      if (!held && !e.repeat && engine.validKey(e.code)) {
        captured = { kind: 'keyboard', key: e.code };
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (!isReady()) return;
    if (engine.validKey(e.code) && (map.keyboardMode === 'pad' || !engine.active || capture)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    if (!engine.active || capture || document.activeElement !== canvas) return;
    if (map.keyboardMode === 'native') {
      rawKeys.set(e.code, e);
      return;
    }
    let mapped = false;
    for (let port = 0; port < 4; port++) {
      let buttons = 0;
      for (const [action, code] of Object.entries(map.ports[port]?.keys ?? {}))
        if (code === e.code) {
          buttons |= 1 << names.indexOf(action);
          mapped = true;
        }
      if (buttons) engine.source(`key:${e.code}:${port}`, port, buttons, [0, 0, 0, 0]);
    }
    if (mapped) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  function keyup(e: KeyboardEvent) {
    if (flushing) return;
    keys.delete(e.code);
    rawKeys.delete(e.code);
    for (let p = 0; p < 4; p++) engine.clear(`key:${e.code}:${p}`);
    if (
      isReady() &&
      engine.validKey(e.code) &&
      (map.keyboardMode === 'pad' || !engine.active || capture)
    ) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  function mouseButton(e: MouseEvent, down: boolean) {
    if (flushing) return;
    const was = pressedMouse.has(e.button);
    if (down) pressedMouse.add(e.button);
    else pressedMouse.delete(e.button);
    if (capture?.kind === 'mouse') {
      if (down && !was && e.button <= 4) captured = { kind: 'mouse', mouse: e.button };
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!isReady()) return;
    if (map.mouseMode === 'pad' || !engine.active || capture) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    if (!engine.active || capture || map.mouseMode !== 'pad') return;
    let mapped = false;
    for (let port = 0; port < 4; port++) {
      let buttons = 0;
      for (const [action, button] of Object.entries(map.ports[port]?.mouse ?? {}))
        if (button === e.button) {
          buttons |= 1 << names.indexOf(action);
          mapped = true;
        }
      if (down && buttons) engine.source(`mouse:${e.button}:${port}`, port, buttons, [0, 0, 0, 0]);
      else if (!down) engine.clear(`mouse:${e.button}:${port}`);
    }
    if (mapped) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  const down = (e: MouseEvent) => mouseButton(e, true),
    up = (e: MouseEvent) => mouseButton(e, false);
  function wheel(e: WheelEvent) {
    const button = e.deltaY < 0 ? 5 : 6;
    if (capture?.kind === 'mouse') {
      captured = { kind: 'mouse', mouse: button };
      e.preventDefault();
      return;
    }
    if (!isReady()) return;
    if (map.mouseMode === 'pad' || !engine.active || capture) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    if (!engine.active || map.mouseMode !== 'pad' || capture) return;
    let mapped = false;
    for (let port = 0; port < 4; port++) {
      let buttons = 0;
      for (const [action, index] of Object.entries(map.ports[port]?.mouse ?? {}))
        if (index === button) {
          buttons |= 1 << names.indexOf(action);
          mapped = true;
        }
      if (buttons) engine.source(`wheel:${port}`, port, buttons, [0, 0, 0, 0]);
    }
    if (mapped) e.preventDefault();
  }
  function blur() {
    for (const id of [...keys]) for (let p = 0; p < 4; p++) engine.clear(`key:${id}:${p}`, true);
    for (const id of pressedMouse)
      for (let p = 0; p < 4; p++) engine.clear(`mouse:${id}:${p}`, true);
    keys.clear();
    flushMouse();
    releasePointers();
    flushKeys();
  }
  const hidden = () => {
    if (document.hidden) release();
  };
  const nativeDeviceEvent = (e: Event) => {
    if (!e.isTrusted) return;
    const index = (e as GamepadEvent).gamepad?.index;
    for (let port = 0; port < 4; port++)
      if (assignments[port] === index) {
        assignments[port] = null;
        models[port] = '';
        padArmed[port] = false;
        engine.clear(`pad:${port}`, true);
      }
    e.stopImmediatePropagation();
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    release();
    clearInterval(timer);
    if (installed) {
      if (started) for (const p of pads) event('gamepaddisconnected', { ...p, connected: false });
      if (previous) Object.defineProperty(navigator, 'getGamepads', previous);
      else delete (navigator as unknown as Record<string, unknown>).getGamepads;
      installed = false;
      for (const p of physical()) if (p?.connected) event('gamepadconnected', p);
    }
    removeEventListener('keydown', keydown, true);
    removeEventListener('keyup', keyup, true);
    removeEventListener('blur', blur);
    removeEventListener('gamepadconnected', nativeDeviceEvent, true);
    removeEventListener('gamepaddisconnected', nativeDeviceEvent, true);
    document.removeEventListener('visibilitychange', hidden);
    canvas.removeEventListener('mousedown', down, true);
    removeEventListener('mouseup', up, true);
    canvas.removeEventListener('pointerdown', pointerdown);
    canvas.removeEventListener('pointerup', pointerup);
    canvas.removeEventListener('pointercancel', pointercancel);
    canvas.removeEventListener('lostpointercapture', pointercancel);
    canvas.removeEventListener('wheel', wheel, true);
  }
  try {
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: getter });
    installed = true;
  } catch {
    error = 'Virtual controller adapter is unavailable in this browser.';
  }
  if (installed) {
    addEventListener('keydown', keydown, true);
    addEventListener('keyup', keyup, true);
    addEventListener('blur', blur);
    addEventListener('gamepadconnected', nativeDeviceEvent, true);
    addEventListener('gamepaddisconnected', nativeDeviceEvent, true);
    document.addEventListener('visibilitychange', hidden);
    canvas.addEventListener('mousedown', down, true);
    addEventListener('mouseup', up, true);
    canvas.addEventListener('pointerdown', pointerdown);
    canvas.addEventListener('pointerup', pointerup);
    canvas.addEventListener('pointercancel', pointercancel);
    canvas.addEventListener('lostpointercapture', pointercancel);
    canvas.addEventListener('wheel', wheel, { capture: true, passive: false });
  }
  function checkHeartbeat() {
    const wasActive = engine.active;
    engine.tick(performance.now());
    if (wasActive && !engine.active) release();
  }
  const timer = setInterval(checkHeartbeat, 100);
  return {
    start() {
      if (installed && !started) {
        started = true;
        for (const p of pads) event('gamepadconnected', p);
      }
    },
    configure(value: MappingConfig, nextAssignments: (number | null)[], assignmentPort = -1) {
      const next = engine.validateConfig(value);
      if (!Number.isInteger(assignmentPort) || assignmentPort < -1 || assignmentPort > 3)
        throw Error('Invalid assignment port');
      if (
        !Array.isArray(nextAssignments) ||
        nextAssignments.length !== 4 ||
        nextAssignments.some((n) => n !== null && (!Number.isInteger(n) || n < 0 || n > 15)) ||
        new Set(nextAssignments.filter((n) => n !== null)).size !==
          nextAssignments.filter((n) => n !== null).length
      )
        throw Error('Assign each controller to one port');
      release();
      map = next;
      assignments = nextAssignments.map((index, port) =>
        assignmentPort === port || assignments[port] === index ? index : null,
      );
      const devices = physical();
      models = assignments.map((i) => (i === null ? '' : devices[i] ? identity(devices[i]!) : ''));
    },
    packet(value: TouchPacket) {
      if (value?.active === false) release();
      engine.packet(value, performance.now());
    },
    capture(value: InputCapture | null) {
      if (
        value !== null &&
        (!value ||
          !['keyboard', 'mouse', 'controller'].includes(value.kind) ||
          !Number.isInteger(value.port) ||
          value.port < 0 ||
          value.port > 3)
      )
        throw Error('Invalid binding capture');
      release();
      capture = value;
      captured = null;
      captureNeutral = false;
    },
    info(): InputInfo {
      poll();
      return {
        supported: installed,
        ready: isReady(),
        assignments: [...assignments],
        devices: physical().flatMap((p, index) =>
          p?.connected
            ? [
                {
                  index,
                  id: p.id.slice(0, 180),
                  mapping: p.mapping === 'standard' ? 'standard' : '',
                  buttons: Math.min(64, p.buttons.length),
                  axes: Math.min(16, p.axes.length),
                },
              ]
            : [],
        ),
        states: Array.from({ length: 4 }, (_, p) => engine.peek(p)),
        deviceError: error,
        capture: captured,
      };
    },
    afterFrame() {
      frames++;
      engine.afterFrame();
      for (let p = 0; p < 4; p++) engine.clear(`wheel:${p}`);
    },
    dispose,
  };
}
export function inputBridgeSource(): string {
  return `export const createEngine=${createInputEngine.toString()};export default ${installInputAdapter.toString()};`;
}
