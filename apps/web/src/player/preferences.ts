import { coreOptionsConfig } from './options.js';
import type { BrowserCore } from './runtime.js';
import { type ShaderId, validShaderId } from './shaders.js';
export interface PreferenceOverrides {
  options: Record<string, string>;
  shader?: ShaderId;
}
export interface PlayerPreferences {
  options: Record<string, string>;
  shader: ShaderId;
}
type Scope = 'core' | 'game';
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
function validOverrides(value: unknown): PreferenceOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid preferences');
  const data = value as PreferenceOverrides;
  coreOptionsConfig(data.options);
  if (data.shader !== undefined && !validShaderId(data.shader))
    throw Error('Invalid shader preference');
  return {
    options: { ...data.options },
    ...(data.shader !== undefined ? { shader: data.shader } : {}),
  };
}
export function createPreferenceStore(
  origin: string,
  core: BrowserCore,
  game?: string,
  storage?: StoragePort,
) {
  const base = `ecs.player.v1:${encodeURIComponent(new URL(origin).origin)}:${encodeURIComponent(core.id)}:${core.loader.sha256}:${core.wasm.sha256}`;
  function port() {
    return storage ?? localStorage;
  }
  function key(scope: Scope) {
    if (scope === 'game' && !game) throw Error('No game selected');
    return scope === 'core' ? base : `${base}:${encodeURIComponent(game!)}`;
  }
  function read(scope: Scope) {
    const text = port().getItem(key(scope));
    if (text === null) return null;
    if (text.length > 131072) throw Error('Preferences exceed limit');
    return validOverrides(JSON.parse(text));
  }
  function write(scope: Scope, value: PreferenceOverrides) {
    const text = JSON.stringify(validOverrides(value));
    if (text.length > 131072) throw Error('Preferences exceed limit');
    port().setItem(key(scope), text);
  }
  return {
    hasGame: !!game,
    load(): { preferences: PlayerPreferences; scopes: Scope[]; warning: string | null } {
      const preferences: PlayerPreferences = { options: {}, shader: 'off' };
      const scopes: Scope[] = [];
      let warning: string | null = null;
      for (const scope of ['core', ...(game ? ['game'] : [])] as Scope[]) {
        try {
          const data = read(scope);
          if (!data) continue;
          Object.assign(preferences.options, data.options);
          if (data.shader !== undefined) preferences.shader = data.shader;
          scopes.push(scope);
        } catch {
          warning =
            'Some local preferences could not be read. Playback can continue with available settings.';
        }
      }
      return { preferences, scopes, warning };
    },
    remember: write,
    rememberChanges(scope: Scope, changes: PreferenceOverrides) {
      const prior = read(scope) ?? { options: {} };
      write(scope, { ...prior, ...changes, options: { ...prior.options, ...changes.options } });
    },
    forgetShader(id: ShaderId) {
      for (const scope of ['core', ...(game ? ['game'] : [])] as Scope[]) {
        const prior = read(scope);
        if (prior?.shader === id) {
          delete prior.shader;
          write(scope, prior);
        }
      }
    },
    clear(scope: Scope) {
      port().removeItem(key(scope));
    },
  };
}
export type PreferenceStore = ReturnType<typeof createPreferenceStore>;
