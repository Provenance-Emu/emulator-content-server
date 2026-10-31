import { createInputEngine } from './input-engine.js';
import { actions, type DeviceSummary, defaultMapping } from './input-model.js';
import { type ControllerLayout, defaultLayout, validateLayout } from './layout.js';
import type { BrowserCore } from './runtime.js';
export type InputPatch = Record<string, unknown>;
export function applyInputPatch(patch: InputPatch, checkConflicts = true) {
  const map = defaultMapping(),
    layout = defaultLayout('compact'),
    models: (Omit<DeviceSummary, 'index'> | null)[] = [null, null, null, null];
  if (
    !patch ||
    typeof patch !== 'object' ||
    Array.isArray(patch) ||
    JSON.stringify(patch).length > 131072 ||
    Object.keys(patch).length > 256
  )
    throw Error('Input preferences exceed limit');
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'keyboardMode' || key === 'mouseMode') {
      if (value !== 'pad' && value !== 'native') throw Error('Invalid input mode');
      map[key] = value;
      continue;
    }
    if (key === 'layout.portrait' || key === 'layout.landscape') {
      layout.representations[key === 'layout.portrait' ? 'portrait' : 'landscape'] =
        structuredClone(value) as ControllerLayout['representations']['portrait'];
      continue;
    }
    const match = /^(key|mouse|pad|axis|deadzone|device)\.([0-3])(?:\.([a-z0-9]+))?$/.exec(key);
    if (!match) throw Error('Unsupported input preference');
    const [, field, portText, name] = match,
      port = Number(portText),
      p = map.ports[port];
    if (!p) throw Error('Invalid port');
    if (field === 'deadzone' && name === undefined) {
      p.deadzone = value as number;
      continue;
    }
    if (field === 'device' && name === undefined) {
      if (value !== null) {
        const d = value as DeviceSummary;
        if (
          !d ||
          typeof d.id !== 'string' ||
          d.id.length > 180 ||
          !['', 'standard'].includes(d.mapping) ||
          !Number.isInteger(d.buttons) ||
          d.buttons < 0 ||
          d.buttons > 64 ||
          !Number.isInteger(d.axes) ||
          d.axes < 0 ||
          d.axes > 16 ||
          'index' in d
        )
          throw Error('Invalid device model');
      }
      models[port] = structuredClone(value) as (typeof models)[number];
      continue;
    }
    if (field === 'axis' && name !== undefined && /^[0-3]$/.test(name)) {
      p.axes[Number(name)] = structuredClone(value) as (typeof p.axes)[number];
      continue;
    }
    if (!name || !actions.includes(name as (typeof actions)[number])) throw Error('Invalid action');
    const action = name as (typeof actions)[number];
    const target =
      field === 'key' ? p.keys : field === 'mouse' ? p.mouse : field === 'pad' ? p.pads : null;
    if (!target) throw Error('Invalid binding');
    if (value === null) delete target[action];
    else Object.assign(target, { [action]: structuredClone(value) });
  }
  return {
    map: createInputEngine().validateConfig(map, checkConflicts),
    layout: validateLayout(layout),
    models,
  };
}
export function createInputPreferences(
  origin: string,
  core: BrowserCore,
  game?: string,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
) {
  const base = `ecs.input.v1:${encodeURIComponent(new URL(origin).origin)}:${encodeURIComponent(core.id)}:${core.loader.sha256}:${core.wasm.sha256}`;
  const key = (scope: 'core' | 'game') => {
    if (scope === 'game' && !game) throw Error('No game selected');
    return scope === 'core' ? base : `${base}:${encodeURIComponent(game ?? '')}`;
  };
  const port = () => storage ?? localStorage;
  function read(scope: 'core' | 'game'): InputPatch {
    const text = port().getItem(key(scope));
    if (text === null) return {};
    if (text.length > 131072) throw Error('Input preferences exceed limit');
    const patch = JSON.parse(text) as InputPatch;
    applyInputPatch(patch, false);
    return patch;
  }
  return {
    hasGame: !!game,
    load() {
      const patch: InputPatch = {};
      let warning: string | null = null;
      for (const scope of ['core', ...(game ? ['game'] : [])] as ('core' | 'game')[])
        try {
          const candidate = { ...patch, ...read(scope) };
          applyInputPatch(candidate);
          Object.assign(patch, candidate);
        } catch {
          warning = 'Some local input preferences could not be read; defaults remain available.';
        }
      return { ...applyInputPatch(patch), patch, warning };
    },
    remember(scope: 'core' | 'game', changes: InputPatch) {
      const patch = { ...read(scope), ...changes };
      applyInputPatch(scope === 'game' ? { ...read('core'), ...patch } : patch);
      port().setItem(key(scope), JSON.stringify(patch));
    },
    clear(scope: 'core' | 'game') {
      port().removeItem(key(scope));
    },
  };
}
export type InputPreferences = ReturnType<typeof createInputPreferences>;
