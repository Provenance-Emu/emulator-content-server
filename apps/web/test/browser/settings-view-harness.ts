import { mount } from 'svelte';
import type { CommandChannel } from '../../src/player/commands.js';
import { createPreferenceStore } from '../../src/player/preferences.js';
import type { BrowserCore, PlayerRuntime } from '../../src/player/runtime.js';
import SettingsControls from '../../src/player/SettingsControls.svelte';
import type { ShaderResult } from '../../src/player/shaders.js';

/** External core/device boundary for focused tests of the real settings component. */
export function mountSettings(core: BrowserCore) {
  const store = createPreferenceStore(location.origin, core, 'item:test');
  store.remember('core', { options: { region: 'PAL' } });
  store.remember('game', { options: { palette: 'rgb' } });
  const initial = store.load().preferences;
  let failFocus = false,
    failed = false;
  let shaderResult: ShaderResult = { selection: 'off', status: 'off' };
  const values = { region: 'PAL', palette: 'rgb' };
  const option = (key: keyof typeof values) => ({
    key,
    value: values[key],
    description: key,
    values: key === 'region' ? ['Auto', 'PAL'] : ['default', 'rgb'],
  });
  const commands = {
    listOptions: async () => [option('region'), option('palette')],
    option: async (key: keyof typeof values) => option(key),
    setOption: async (key: keyof typeof values, value: string) => {
      values[key] = value;
      return option(key);
    },
  } as unknown as CommandChannel;
  const runtime = {
    focus: async () => {
      if (failFocus) throw Error('Game focus unavailable');
    },
    settingsInfo: async () => ({
      commands: true,
      shaders: true,
      shaderResult: failed ? { selection: 'off', status: 'failed' } : shaderResult,
    }),
    setShader: async (id: 'off' | 'scanlines' | 'lcd') => {
      shaderResult = { selection: id, status: id === 'off' ? 'off' : 'requested' };
      return shaderResult;
    },
  } as PlayerRuntime;
  const target = document.createElement('div');
  document.body.append(target);
  mount(SettingsControls, { target, props: { runtime, commands, store, initial } });
  return {
    failFocus() {
      failFocus = true;
    },
    failShader() {
      failed = true;
    },
    updateCore() {
      store.remember('core', { options: { region: 'Auto' } });
    },
    preferences() {
      return store.load().preferences;
    },
  };
}
