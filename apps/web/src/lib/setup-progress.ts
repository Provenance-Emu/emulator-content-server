import { writable } from 'svelte/store';
export const setupSteps = ['account', 'library', 'games', 'emulators', 'plugins', 'ready'] as const;
export type SetupStep = (typeof setupSteps)[number];
export type SetupMode = 'host' | 'join';
export interface SetupProgress {
  step: SetupStep;
  mode: SetupMode;
  libraryId: string;
  done: boolean;
  paused: boolean;
}
type ProgressStorage = Pick<Storage, 'getItem' | 'setItem'>;
export function setupProgressKey(origin: string) {
  return `ecs.setup.v1:${encodeURIComponent(new URL(origin).origin)}`;
}
export function readSetupProgress(origin: string, storage?: ProgressStorage): SetupProgress | null {
  try {
    const raw = (storage ?? localStorage).getItem(setupProgressKey(origin));
    if (!raw) return null;
    const value = JSON.parse(raw) as SetupProgress;
    if (
      !setupSteps.includes(value.step) ||
      !['host', 'join'].includes(value.mode) ||
      typeof value.libraryId !== 'string' ||
      value.libraryId.length > 256 ||
      typeof value.done !== 'boolean' ||
      typeof value.paused !== 'boolean'
    )
      return null;
    return {
      step: value.step,
      mode: value.mode,
      libraryId: value.libraryId,
      done: value.done,
      paused: value.paused,
    };
  } catch {
    return null;
  }
}
export function createSetupProgress(origin: string, mode: SetupMode, storage?: ProgressStorage) {
  let current: SetupProgress = readSetupProgress(origin, storage) ?? {
    step: 'account',
    mode,
    libraryId: '',
    done: false,
    paused: false,
  };
  current = {
    ...current,
    ...(current.mode === mode ? {} : { mode, step: 'account', done: false }),
    paused: false,
  };
  const store = writable(current);
  function update(patch: Partial<SetupProgress>) {
    current = { ...current, ...patch };
    try {
      (storage ?? localStorage).setItem(setupProgressKey(origin), JSON.stringify(current));
    } catch {
      /* Setup remains usable with storage disabled. */
    }
    store.set(current);
  }
  update({});
  return { subscribe: store.subscribe, update };
}
