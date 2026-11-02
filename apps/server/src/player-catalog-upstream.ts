import type { PluginManifest } from '@ecs/plugins';
import type { TrustedPlayer } from './player-catalog.js';

const APP_ID = 'com.provenance.emulator-content-server';
const BASE_URL = 'https://web.libretro.com';
const CONTENT_LIMIT = 512 * 1024 * 1024;

import {
  upstreamCorePins as CORE_PINS,
  type UpstreamCorePin as CorePin,
} from './player-catalog-upstream-data.js';

function manifest(pin: CorePin): PluginManifest {
  return {
    id: pin.id,
    name: pin.name,
    kind: 'player',
    version: '1.0.0',
    engine: 'ecs.plugin/1',
    apps: [APP_ID],
    player: {
      systems: pin.systems,
      module: pin.module,
      web: {
        profileVersion: 1,
        runtime: 'retroarch-emscripten-esm',
        filesystem: 'memfs',
        threaded: false,
        saveCompletion: 'none',
        ...(pin.systemFilesDirectory ? { systemFilesDirectory: pin.systemFilesDirectory } : {}),
        contentExtensions: [...pin.extensions],
        maxContentBytes: CONTENT_LIMIT,
        buildVersion: pin.buildVersion,
        loader: { file: pin.module.replace(/\.wasm$/, '.js'), sha256: pin.loaderSha256 },
        wasm: { file: pin.module, sha256: pin.wasmSha256 },
        assets: [],
      },
    },
  };
}

const stagingLimitations: Readonly<Record<string, string>> = {
  'org.libretro.prboom':
    'Requires prboom.wad engine data; system-file staging for this core is pending.',
  'org.libretro.ecwolf':
    'Requires ecwolf.pk3 and companion game files; multi-file staging is pending.',
  'org.libretro.tyrquake': 'Requires the id1/pak0.pak game-data layout; folder staging is pending.',
  'org.libretro.vitaquake2': 'Game-data folder staging still needs end-to-end verification.',
};

/** Snapshot hashes are captured from official web.libretro.com artifacts on 2026-10-31.
 * That host serves mutable paths; size/hash checks intentionally fail closed after replacement.
 * Factory startup passed in an opaque-origin Chromium frame; no game/content behavior was verified.
 */
export const upstreamPlayerCatalog: readonly TrustedPlayer[] = CORE_PINS.map((pin) => {
  const plugin = manifest(pin);
  const web = plugin.player?.web;
  if (!web) throw new Error('Upstream catalog entry must include a web player profile');
  const { loader, wasm } = web;
  return {
    id: pin.id,
    name: pin.name,
    systems: pin.systems,
    description: `Experimental core; startup verified in the production opaque sandbox. Game compatibility and save behavior are unverified.${pin.notes ? ` ${pin.notes}` : ''}`,
    available: !(pin.blockedReason ?? stagingLimitations[pin.id]),
    reason: pin.blockedReason ?? stagingLimitations[pin.id] ?? null,
    downloadBytes: pin.loaderBytes + pin.wasmBytes,
    url: null,
    sha256: null,
    upstream: {
      manifest: plugin,
      resources: [
        {
          url: `${BASE_URL}/${loader.file}`,
          file: loader.file,
          sha256: loader.sha256,
          sizeBytes: pin.loaderBytes,
        },
        {
          url: `${BASE_URL}/${wasm.file}`,
          file: wasm.file,
          sha256: wasm.sha256,
          sizeBytes: pin.wasmBytes,
        },
      ],
    },
  };
});
