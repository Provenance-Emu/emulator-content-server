import type { PluginManifest } from '@ecs/plugins';
import type { TrustedPlayer } from './player-catalog.js';
import { pairs20261115 } from './player-catalog-2026-11-15.js';

// Embedded input revisions retain partial evidence while complete build mappings remain unverified.
const upstreamBuildEvidence = {
  kind: 'build',
  url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/2bcdf7d84f7083991fe9c9c390d0a2e3ace361fc/docs/operations/upstream-binary-mapping-2026-11-06.json',
  sha256: '02c454c6b2ffa803248002a2a815c588fd1f3b15b42120f8e03b3cbce5f6756d',
  sizeBytes: 212794,
} as const;

const upstreamBuildResolution = {
  kind: 'build',
  url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/d98397772118a76f01de1d4e24acb3d30fae34bd/docs/operations/upstream-build-resolution-2026-11-06.json',
  sha256: 'fc05e0eb04a8a2ae029215a1d60e0d4164805dec624020f6aee998f110e583d6',
  sizeBytes: 66663,
} as const;

const upstreamReconstructionEvidence = {
  kind: 'build',
  url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/58445c9ab344c9339c4db8e155d50e9e9b10352a/docs/operations/upstream-reconstructions-2026-11-06.json',
  sha256: '5322feffa54401d01741ea2f5dfdaaea3eaabfd98c66003dfd1bbb60e4ceefd7',
  sizeBytes: 14625083,
} as const;

const vecxRebuildEvidence = {
  kind: 'build',
  url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/d98397772118a76f01de1d4e24acb3d30fae34bd/docs/operations/vecx-upstream-rebuild-2026-11-06.json',
  sha256: '24e6b482c9ddbda7acaf29225b490c3d3004955738716fbe77f992810817830c',
  sizeBytes: 286538,
} as const;

const APP_ID = 'com.provenance.emulator-content-server';
const BASE_URL = 'https://web.libretro.com';
const CONTENT_LIMIT = 512 * 1024 * 1024;

import {
  upstreamCorePins as CORE_PINS,
  type UpstreamCorePin as CorePin,
} from './player-catalog-upstream-data.js';

function manifest(pin: CorePin, current: boolean): PluginManifest {
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
        ...(current && pin.id === 'org.libretro.vecx'
          ? { defaultCoreOptions: { vecx_use_hw: 'Software' } }
          : {}),
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

// The web host serves mutable resources. The installer verifies both files against
// the same audited snapshot before it accepts a pair.
function entry(pin: CorePin, current: boolean): TrustedPlayer {
  const blocked = pin.blockedReason ?? stagingLimitations[pin.id];
  const reason =
    current && ['org.libretro.prboom', 'org.libretro.vecx'].includes(pin.id) ? undefined : blocked;
  const plugin = manifest(pin, current);
  const web = plugin.player?.web;
  if (!web) throw new Error('Upstream catalog entry must include a web player profile');
  const { loader, wasm } = web;
  return {
    id: pin.id,
    name: pin.name,
    systems: pin.systems,
    description: `Experimental core; startup verified in the production opaque sandbox. Game compatibility and save behavior are unverified.${pin.notes ? ` ${pin.notes}` : ''}`,
    available: !reason,
    reason: reason ?? null,
    downloadBytes: pin.loaderBytes + pin.wasmBytes,
    url: null,
    sha256: null,
    provenance: {
      sourceInfo: pin.sourceInfo,
      infoSha256: pin.infoSha256,
      license: pin.license,
      firmware: pin.firmware,
      sourceMapping: 'unverified',
      artifacts: current
        ? []
        : [
            upstreamBuildEvidence,
            upstreamBuildResolution,
            upstreamReconstructionEvidence,
            ...(pin.id === 'org.libretro.vecx' ? [vecxRebuildEvidence] : []),
          ],
    },
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
}
export const historicalUpstreamPlayerCatalog = CORE_PINS.map((pin) => entry(pin, false));
export const upstreamPlayerCatalog = CORE_PINS.map((pin) => {
  const pair = pairs20261115[pin.module as keyof typeof pairs20261115];
  if (!pair) throw new Error(`Missing pinned upstream core: ${pin.module}`);
  const [loader, wasm] = pair;
  return entry(
    {
      ...pin,
      buildVersion: 'web.libretro.com 2026-11-15',
      loaderBytes: loader[0],
      loaderSha256: loader[1],
      wasmBytes: wasm[0],
      wasmSha256: wasm[1],
      ...(pin.id === 'org.libretro.vecx'
        ? {
            notes:
              'The software renderer is selected by default. Original cartridge rendering was verified.',
          }
        : {}),
      ...(pin.id === 'org.libretro.prboom'
        ? {
            extensions: ['wad', 'iwad'],
            notes:
              'Play a standalone Doom IWAD. Put prboom.wad in the game library so the player can load the engine data.',
            firmware: [{ path: 'prboom.wad', optional: false }],
          }
        : {}),
    },
    true,
  );
});
