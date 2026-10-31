import type { MappingConfig, TouchPacket } from './input-model.js';
/** Self-contained: this factory is also packaged as a first-party guest module. */
export function createInputEngine() {
  const names = [
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
  ];
  const keyPattern =
    /^(Key[A-Z]|Digit[0-9]|Numpad([0-9]|Enter|Add|Subtract|Multiply|Divide|Decimal)|Arrow(Up|Down|Left|Right)|Enter|Space|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal)$/;
  const sources = new Map<string, { port: number; buttons: number; axes: number[] }>(),
    pending = new Map<string, { port: number; buttons: number }>();
  let active = false,
    armed = false,
    lastHeartbeat = -Infinity,
    sequence = 0,
    polled = false;
  const axesValid = (a: unknown): a is number[] =>
    Array.isArray(a) &&
    a.length === 4 &&
    a.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1);
  function release() {
    sources.clear();
    pending.clear();
  }
  function source(id: string, port: number, buttons: number, axes: number[]) {
    if (!active || !armed) return;
    if (
      typeof id !== 'string' ||
      id.length > 80 ||
      !Number.isInteger(port) ||
      port < 0 ||
      port > 3 ||
      !Number.isInteger(buttons) ||
      buttons < 0 ||
      buttons > 65535 ||
      !axesValid(axes)
    )
      throw Error('Invalid input source');
    if (
      !sources.has(id) &&
      !pending.has(id) &&
      new Set([...sources.keys(), ...pending.keys()]).size >= 128
    ) {
      active = false;
      armed = false;
      release();
      throw Error('Input source limit exceeded');
    }
    const previous = sources.get(id);
    const pressed = buttons & ~(previous?.buttons ?? 0);
    if (pressed) pending.set(id, { port, buttons: (pending.get(id)?.buttons ?? 0) | pressed });
    if (buttons || axes.some((n) => n !== 0)) sources.set(id, { port, buttons, axes: [...axes] });
    else sources.delete(id);
  }
  function clear(id: string, immediate = false) {
    sources.delete(id);
    if (immediate) pending.delete(id);
  }
  function packet(value: TouchPacket, now: number) {
    try {
      if (
        !value ||
        !Number.isSafeInteger(value.sequence) ||
        value.sequence < 1 ||
        typeof value.active !== 'boolean' ||
        !Array.isArray(value.sources) ||
        value.sources.length > 16
      )
        throw Error('Invalid input packet');
      const seen = new Set();
      for (const s of value.sources) {
        if (
          !s ||
          typeof s.id !== 'string' ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(s.id) ||
          seen.has(s.id) ||
          !Number.isInteger(s.port) ||
          s.port < 0 ||
          s.port > 3 ||
          !Number.isInteger(s.buttons) ||
          s.buttons < 0 ||
          s.buttons > 65535 ||
          !axesValid(s.axes)
        )
          throw Error('Invalid touch state');
        seen.add(s.id);
      }
      if (
        value.cancelled !== undefined &&
        (!Array.isArray(value.cancelled) ||
          value.cancelled.length > 16 ||
          value.cancelled.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)))
      )
        throw Error('Invalid release');
      if (value.sequence <= sequence) return;
      sequence = value.sequence;
      lastHeartbeat = now;
      if (!value.active) {
        active = false;
        armed = false;
        release();
        return;
      }
      active = true;
      if (!armed) {
        if (value.sources.length === 0) armed = true;
        else return;
      }
      for (const id of value.cancelled ?? []) clear(`touch:${id}`, true);
      const ids = new Set(value.sources.map((s) => `touch:${s.id}`));
      for (const id of sources.keys()) if (id.startsWith('touch:') && !ids.has(id)) clear(id);
      for (const s of value.sources) source(`touch:${s.id}`, s.port, s.buttons, s.axes);
    } catch (error) {
      active = false;
      armed = false;
      release();
      throw error;
    }
  }
  function tick(now: number) {
    if (now - lastHeartbeat > 750) {
      active = false;
      armed = false;
      release();
    }
  }
  function sample(port: number, consume = true) {
    if (consume) polled = true;
    let buttons = 0;
    const axes = [0, 0, 0, 0];
    for (const s of [...sources.values(), ...pending.values()])
      if (s.port === port) buttons |= s.buttons;
    for (let i = 0; i < 4; i++) {
      let magnitude = 0,
        sum = 0;
      for (const s of sources.values())
        if (s.port === port) {
          const v = s.axes[i] ?? 0;
          if (Math.abs(v) > magnitude) {
            magnitude = Math.abs(v);
            sum = v;
          } else if (Math.abs(v) === magnitude) sum += v;
        }
      axes[i] = Math.sign(sum) * magnitude;
    }
    if ((buttons & 48) === 48) buttons &= ~48;
    if ((buttons & 192) === 192) buttons &= ~192;
    return { buttons, axes };
  }
  function validateConfig(value: unknown, checkConflicts = true): MappingConfig {
    if (!value || typeof value !== 'object' || JSON.stringify(value).length > 32768)
      throw Error('Invalid mapping');
    const c = value as MappingConfig;
    if (
      c.version !== 1 ||
      !['pad', 'native'].includes(c.keyboardMode) ||
      !['pad', 'native'].includes(c.mouseMode) ||
      !Array.isArray(c.ports) ||
      c.ports.length !== 4
    )
      throw Error('Invalid mapping');
    const keyBindings = new Set<string>();
    for (const p of c.ports) {
      if (
        !p ||
        !Number.isFinite(p.deadzone) ||
        p.deadzone < 0 ||
        p.deadzone > 0.8 ||
        !Array.isArray(p.axes) ||
        p.axes.length !== 4
      )
        throw Error('Invalid stick mapping');
      for (const axis of p.axes)
        if (
          !axis ||
          !Number.isInteger(axis.index) ||
          axis.index < 0 ||
          axis.index > 15 ||
          typeof axis.inverted !== 'boolean'
        )
          throw Error('Invalid axis');
      for (const field of ['keys', 'mouse', 'pads'] as const) {
        const obj = p[field];
        if (!obj || typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).length > 16)
          throw Error('Invalid bindings');
        const used = field === 'keys' ? keyBindings : new Set<string>();
        for (const [a, b] of Object.entries(obj)) {
          const identity =
            field === 'pads' && b && typeof b === 'object'
              ? JSON.stringify([
                  (b as { kind: string }).kind,
                  (b as { index: number }).index,
                  (b as { direction?: number }).direction ?? 0,
                ])
              : String(b);
          if (checkConflicts && used.has(identity)) throw Error('Conflicting input bindings');
          used.add(identity);
          if (!names.includes(a)) throw Error('Invalid action');
          if (field === 'keys' && (typeof b !== 'string' || !keyPattern.test(b)))
            throw Error('Reserved or invalid key');
          if (field === 'mouse' && (!Number.isInteger(b) || Number(b) < 0 || Number(b) > 6))
            throw Error('Invalid mouse button');
          if (field === 'pads') {
            const pad = b as { kind: string; index: number; direction?: number };
            if (
              !pad ||
              !['button', 'axis'].includes(pad.kind) ||
              !Number.isInteger(pad.index) ||
              pad.index < 0 ||
              pad.index > (pad.kind === 'button' ? 63 : 15) ||
              (pad.kind === 'axis' && pad.direction !== -1 && pad.direction !== 1)
            )
              throw Error('Invalid pad binding');
          }
        }
      }
    }
    return structuredClone(c);
  }
  return {
    packet,
    source,
    clear,
    release,
    tick,
    sample,
    peek: (port: number) => sample(port, false),
    afterFrame() {
      if (polled) {
        pending.clear();
        polled = false;
      }
    },
    validateConfig,
    validKey: (key: string) => keyPattern.test(key),
    get active() {
      return active && armed;
    },
  };
}
