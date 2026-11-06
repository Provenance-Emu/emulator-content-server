import { mount } from 'svelte';
import { type CommandChannel, CoreOptionRejected } from '../../src/player/commands.js';
import { createPreferenceStore } from '../../src/player/preferences.js';
import type { BrowserCore, PlayerRuntime } from '../../src/player/runtime.js';
import SettingsControls from '../../src/player/SettingsControls.svelte';
import type { ShaderResult } from '../../src/player/shaders.js';

/** External core/device boundary for focused tests of the real settings component. */
export function mountSettings(core: BrowserCore, optionCount = 2) {
  const store = createPreferenceStore(location.origin, core, 'item:test');
  store.remember('core', { options: { region: 'PAL' } });
  store.remember('game', { options: { palette: 'rgb' } });
  const initial = store.load().preferences;
  let failFocus = false,
    failed = false;
  let shaderResult: ShaderResult = { selection: 'off', status: 'off' };
  let rejected = false;
  const choiceReads: string[] = [];
  const busyChanges: boolean[] = [];
  const values: Record<string, string> = { region: 'PAL', palette: 'rgb' };
  for (let index = 2; index < optionCount; index++) values[`option${index}`] = 'default';
  const option = (key: keyof typeof values) => ({
    key,
    value: values[key],
    description: key,
    values: key === 'region' ? ['Auto', 'PAL'] : ['default', 'rgb'],
  });
  const commands = {
    listOptions: async () =>
      Object.keys(values).map((key) => {
        const { values: choices, ...summary } = option(key);
        return summary;
      }),
    option: async (key: keyof typeof values) => {
      choiceReads.push(key);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return option(key);
    },
    setOption: async (key: keyof typeof values, value: string) => {
      if (rejected) throw new CoreOptionRejected('This value was rejected by the core');
      values[key] = value;
      return option(key);
    },
  } as unknown as CommandChannel;
  const runtime = {
    focus: async () => {
      document.querySelector<HTMLCanvasElement>('canvas')?.focus();
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
  mount(SettingsControls, {
    target,
    props: { runtime, commands, store, initial, onbusy: (busy) => busyChanges.push(busy) },
  });
  return {
    choiceReads() {
      return choiceReads;
    },
    busyChanges() {
      return busyChanges;
    },
    rejectOption() {
      rejected = true;
    },
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
