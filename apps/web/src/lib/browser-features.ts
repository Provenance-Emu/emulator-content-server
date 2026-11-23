/**
 * What this browser can do, asked in one place.
 *
 * Every optional browser ability the interface or the player adapts to is listed in `FEATURES`
 * with the question that detects it. Code asks `browserFeatures().has('graphics.webgpu')`
 * instead of probing `navigator` itself, so a new ability is added here once and the "This
 * browser" list, the player's requirements and the tests all see it.
 *
 * Detection never looks at the browser's name or version: a preview build that gains an
 * ability is simply reported as having it.
 */

export type FeatureGroup =
  | 'Emulation'
  | 'Graphics'
  | 'Storage'
  | 'Controllers'
  | 'Sound'
  | 'Screen'
  | 'Layout';

export interface Feature {
  id: string;
  group: FeatureGroup;
  /** What the owner would call it. */
  label: string;
  /** What having it changes here. Empty when nothing uses it yet. */
  use: string;
  detect(scope: FeatureScope): boolean;
}

/** The parts of the page's globals detection reads. A test passes its own. */
export interface FeatureScope {
  navigator?: unknown;
  document?: unknown;
  crossOriginIsolated?: boolean;
  SharedArrayBuffer?: unknown;
  WebAssembly?: unknown;
  OffscreenCanvas?: unknown;
  AudioWorkletNode?: unknown;
  CSS?: unknown;
  HTMLCanvasElement?: unknown;
  VideoEncoder?: unknown;
}

const WASM_PROBES = {
  simd: [
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253,
    15, 253, 98, 11,
  ],
  relaxedSimd: [
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253,
    15, 65, 2, 253, 15, 253, 128, 2, 11,
  ],
  threads: [
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1, 9, 0,
    65, 0, 254, 16, 2, 0, 26, 11,
  ],
  bulkMemory: [
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 10, 14, 1, 12, 0, 65,
    0, 65, 0, 65, 0, 252, 10, 0, 0, 11,
  ],
  exceptions: [
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 6, 64, 25, 11, 11,
  ],
  memory64: [0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1],
  tailCalls: [
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 6, 1, 4, 0, 18, 0, 11,
  ],
  garbageCollection: [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 95, 1, 120, 0],
} as const;

type Loose = Record<string, unknown>;
const object = (value: unknown): Loose | null =>
  (typeof value === 'object' || typeof value === 'function') && value !== null
    ? (value as Loose)
    : null;
const nav = (scope: FeatureScope) => object(scope.navigator);
const callable = (value: unknown, name: string) => typeof object(value)?.[name] === 'function';

function wasm(scope: FeatureScope, probe: keyof typeof WASM_PROBES): boolean {
  const assembly = object(scope.WebAssembly);
  if (typeof assembly?.validate !== 'function') return false;
  try {
    return (assembly.validate as (bytes: Uint8Array) => boolean)(
      new Uint8Array(WASM_PROBES[probe]),
    );
  } catch {
    return false;
  }
}

function css(scope: FeatureScope, condition: string): boolean {
  const supports = object(scope.CSS)?.supports;
  if (typeof supports !== 'function') return false;
  try {
    return (supports as (condition: string) => boolean).call(scope.CSS, condition);
  } catch {
    return false;
  }
}

function context(scope: FeatureScope, kind: string): boolean {
  const create = object(scope.document)?.createElement;
  if (typeof create !== 'function') return false;
  try {
    const canvas = (create as (tag: string) => unknown).call(scope.document, 'canvas');
    const get = object(canvas)?.getContext;
    return typeof get === 'function' && !!(get as (kind: string) => unknown).call(canvas, kind);
  } catch {
    return false;
  }
}

const sharedMemory = (scope: FeatureScope) =>
  scope.crossOriginIsolated === true && typeof scope.SharedArrayBuffer === 'function';

export const FEATURES: readonly Feature[] = [
  {
    id: 'wasm.simd',
    group: 'Emulation',
    label: 'Fast math (SIMD)',
    use: 'Emulators built for it run faster.',
    detect: (s) => wasm(s, 'simd'),
  },
  {
    id: 'wasm.relaxedSimd',
    group: 'Emulation',
    label: 'Faster math (relaxed SIMD)',
    use: '',
    detect: (s) => wasm(s, 'relaxedSimd'),
  },
  {
    id: 'wasm.threads',
    group: 'Emulation',
    label: 'Several processor cores',
    use: 'Needed by GameCube and Wii, and by any emulator built with threads.',
    detect: (s) => sharedMemory(s) && wasm(s, 'threads'),
  },
  {
    id: 'wasm.bulkMemory',
    group: 'Emulation',
    label: 'Fast memory copies',
    use: '',
    detect: (s) => wasm(s, 'bulkMemory'),
  },
  {
    id: 'wasm.exceptions',
    group: 'Emulation',
    label: 'Native error handling',
    use: '',
    detect: (s) => wasm(s, 'exceptions'),
  },
  {
    id: 'wasm.memory64',
    group: 'Emulation',
    label: 'Games larger than 4 GB in memory',
    use: '',
    detect: (s) => wasm(s, 'memory64'),
  },
  {
    id: 'wasm.tailCalls',
    group: 'Emulation',
    label: 'Tail calls',
    use: '',
    detect: (s) => wasm(s, 'tailCalls'),
  },
  {
    id: 'wasm.garbageCollection',
    group: 'Emulation',
    label: 'Managed memory',
    use: '',
    detect: (s) => wasm(s, 'garbageCollection'),
  },
  {
    id: 'wasm.stackSwitching',
    group: 'Emulation',
    label: 'Pausing inside an emulator (JSPI)',
    use: '',
    detect: (s) => 'Suspending' in (object(s.WebAssembly) ?? {}),
  },
  {
    id: 'isolation.sharedMemory',
    group: 'Emulation',
    label: 'Shared memory',
    use: 'Needed by GameCube and Wii. Open the player from the server’s own address.',
    detect: sharedMemory,
  },

  {
    id: 'graphics.webgl2',
    group: 'Graphics',
    label: 'WebGL 2',
    use: 'What emulators draw with.',
    detect: (s) => context(s, 'webgl2'),
  },
  {
    id: 'graphics.webgpu',
    group: 'Graphics',
    label: 'WebGPU',
    use: '',
    detect: (s) => object(nav(s)?.gpu) !== null,
  },
  {
    id: 'graphics.offscreenCanvas',
    group: 'Graphics',
    label: 'Drawing off the main thread',
    use: '',
    detect: (s) => typeof s.OffscreenCanvas === 'function',
  },
  {
    id: 'graphics.videoEncoder',
    group: 'Graphics',
    label: 'Recording video',
    use: '',
    detect: (s) => typeof s.VideoEncoder === 'function',
  },

  {
    id: 'storage.files',
    group: 'Storage',
    label: 'Private file storage',
    use: 'Large discs are kept on this device instead of in memory.',
    detect: (s) => callable(nav(s)?.storage, 'getDirectory'),
  },
  {
    id: 'storage.persist',
    group: 'Storage',
    label: 'Storage that is not cleared',
    use: '',
    detect: (s) => callable(nav(s)?.storage, 'persist'),
  },
  {
    id: 'storage.locks',
    group: 'Storage',
    label: 'Sharing storage between tabs',
    use: 'Two tabs never write the same disc at once.',
    detect: (s) => object(nav(s)?.locks) !== null,
  },

  {
    id: 'input.gamepad',
    group: 'Controllers',
    label: 'Game controllers',
    use: 'Controllers work in the player.',
    detect: (s) => callable(nav(s), 'getGamepads'),
  },
  {
    id: 'input.rumble',
    group: 'Controllers',
    label: 'Controller rumble',
    use: '',
    detect: (s) => typeof (s as Loose).GamepadHapticActuator === 'function',
  },
  {
    id: 'input.hid',
    group: 'Controllers',
    label: 'Unusual controllers (WebHID)',
    use: '',
    detect: (s) => object(nav(s)?.hid) !== null,
  },
  {
    id: 'input.serial',
    group: 'Controllers',
    label: 'Serial adapters (Web Serial)',
    use: '',
    detect: (s) => object(nav(s)?.serial) !== null,
  },
  {
    id: 'input.midi',
    group: 'Controllers',
    label: 'MIDI instruments',
    use: '',
    detect: (s) => callable(nav(s), 'requestMIDIAccess'),
  },
  {
    id: 'input.keyboardLock',
    group: 'Controllers',
    label: 'Every key in full screen',
    use: 'Escape and shortcuts reach the game in full screen.',
    detect: (s) => callable(nav(s)?.keyboard, 'lock'),
  },
  {
    id: 'input.pointerLock',
    group: 'Controllers',
    label: 'Mouse capture',
    use: '',
    detect: (s) => callable(object(s.document)?.documentElement, 'requestPointerLock'),
  },

  {
    id: 'sound.worklet',
    group: 'Sound',
    label: 'Low-delay sound',
    use: '',
    detect: (s) => typeof s.AudioWorkletNode === 'function',
  },

  {
    id: 'screen.fullscreen',
    group: 'Screen',
    label: 'Full screen',
    use: 'The Full screen button is shown.',
    detect: (s) => callable(object(s.document)?.documentElement, 'requestFullscreen'),
  },
  {
    id: 'screen.wakeLock',
    group: 'Screen',
    label: 'Keeping the screen on',
    use: 'The screen stays on while a game is running.',
    detect: (s) => callable(nav(s)?.wakeLock, 'request'),
  },
  {
    id: 'screen.pictureInPicture',
    group: 'Screen',
    label: 'Floating window',
    use: '',
    detect: (s) => callable((s as Loose).documentPictureInPicture, 'requestWindow'),
  },

  {
    id: 'layout.containerQueries',
    group: 'Layout',
    label: 'Container queries',
    use: '',
    detect: (s) => css(s, 'container-type: inline-size'),
  },
  {
    id: 'layout.has',
    group: 'Layout',
    label: ':has() selector',
    use: '',
    detect: (s) => css(s, 'selector(:has(*))'),
  },
  {
    id: 'layout.viewTransitions',
    group: 'Layout',
    label: 'View transitions',
    use: '',
    detect: (s) => callable(s.document, 'startViewTransition'),
  },
  {
    id: 'layout.anchorPositioning',
    group: 'Layout',
    label: 'Anchored popovers',
    use: '',
    detect: (s) => css(s, 'anchor-name: --a'),
  },
  {
    id: 'layout.dynamicViewport',
    group: 'Layout',
    label: 'Dynamic viewport units',
    use: 'The game fills the window on phones.',
    detect: (s) => css(s, 'height: 100dvh'),
  },
];

export type FeatureId = (typeof FEATURES)[number]['id'];

export interface BrowserFeatures {
  has(id: FeatureId): boolean;
  /** Every feature with its answer, in the order they are listed. */
  list(): (Feature & { available: boolean })[];
  /** The ids from `needed` this browser lacks. */
  missing(needed: readonly FeatureId[]): Feature[];
}

/** Answers for one set of globals. Each question is asked at most once. */
export function detectFeatures(scope: FeatureScope): BrowserFeatures {
  const answers = new Map<string, boolean>();
  const byId = new Map(FEATURES.map((feature) => [feature.id, feature]));
  const has = (id: FeatureId) => {
    let answer = answers.get(id);
    if (answer === undefined) {
      const feature = byId.get(id);
      try {
        answer = feature ? feature.detect(scope) : false;
      } catch {
        answer = false;
      }
      answers.set(id, answer);
    }
    return answer;
  };
  return {
    has,
    list: () => FEATURES.map((feature) => ({ ...feature, available: has(feature.id) })),
    missing: (needed) => needed.filter((id) => !has(id)).flatMap((id) => byId.get(id) ?? []),
  };
}

let shared: BrowserFeatures | undefined;
/** This page's browser. */
export function browserFeatures(): BrowserFeatures {
  shared ??= detectFeatures(globalThis as FeatureScope);
  return shared;
}

/** What an emulator's runtime cannot do without. */
export function runtimeNeeds(runtime: string | undefined): FeatureId[] {
  return runtime === 'dolphin-wasm-esm'
    ? ['isolation.sharedMemory', 'wasm.threads', 'storage.files']
    : [];
}
