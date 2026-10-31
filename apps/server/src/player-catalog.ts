import type { PluginManifest } from '@ecs/plugins';
import type { PlayerCatalogEntry } from '@ecs/protocol';
import { upstreamPlayerCatalog } from './player-catalog-upstream.js';
export interface TrustedPlayer extends PlayerCatalogEntry {
  url: string | null;
  sha256: string | null;
  upstream?: {
    manifest: PluginManifest;
    resources: { url: string; file: string; sha256: string; sizeBytes: number }[];
  };
}
export const playerCatalog: readonly TrustedPlayer[] = [
  {
    id: 'org.libretro.fceumm',
    name: 'FCEUmm (NES)',
    systems: ['com.provenance.nes'],
    description: 'NES games with battery saves and states. Verified isolated browser runtime.',
    available: true,
    reason: null,
    downloadBytes: 4480582,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/v0.1.4-cores.1/fceumm.ecsplayer',
    sha256: '7baae6ca0e8addebd01d2cb91d29a69c29534c7b1ac65804b3e044af32052700',
  },
  {
    id: 'org.libretro.virtualjaguar',
    name: 'Virtual Jaguar 3.10.0',
    systems: ['com.provenance.jaguar', 'com.provenance.jaguarcd'],
    description:
      'Virtual Jaguar 3.10.0 with cartridge and Jaguar CD HLE (profile 1.2.0). Tested CDI/CHD and CUE/BIN playback, up to 512 MiB total per disc; real BIOS, audio-only discs and save synchronization are unavailable.',
    available: true,
    reason: null,
    downloadBytes: 4604920,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/v0.1.6-jaguar-media.1/virtualjaguar.ecsplayer',
    sha256: 'b3c8dbd57a7691a2e7335e99f9c2afe120be5a2d229a6f3c0b1994e654e016de',
  },
  {
    id: 'org.libretro.pcsx-rearmed',
    name: 'PCSX ReARMed (PlayStation)',
    systems: ['com.provenance.psx'],
    description:
      'Software PlayStation core with BIOS-free HLE boot. Original program rendering verified; synchronized saves and multi-file layouts are unavailable.',
    available: true,
    reason: null,
    downloadBytes: 4446467,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/v0.1.6-cores.1/pcsx-rearmed.ecsplayer',
    sha256: '1a1f37934f601d49ed00d6f69c998860c5283c3ddfde8774ef6dfd4badb9b3ad',
  },
  {
    id: 'org.libretro.prosystem',
    name: 'ProSystem (Atari 7800)',
    systems: ['com.provenance.7800'],
    description:
      'Software Atari 7800 core. Original cartridge rendering verified; synchronized saves and Safari compatibility are unverified.',
    available: true,
    reason: null,
    downloadBytes: 3618571,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/v0.1.6-prosystem.1/prosystem.ecsplayer',
    sha256: '56c2e274e92b529111fff16f64ce3bd9f09532351f89a68969e7453bf73359d3',
  },
  {
    id: 'org.libretro.atari800',
    name: 'Atari800 (Atari 5200)',
    systems: ['com.provenance.5200'],
    description: 'Atari 5200 games with user-supplied firmware.',
    available: false,
    reason: 'A compatible browser build and Atari 5200 firmware staging are not available yet.',
    downloadBytes: null,
    url: null,
    sha256: null,
  },
  {
    id: 'org.flycast.wasm-jit',
    name: 'Flycast (experimental WASM JIT)',
    systems: ['com.provenance.dreamcast'],
    description:
      'Dreamcast with a real SH4-to-WASM JIT and WebGL2. Original-program execution verified; game, firmware and save compatibility remain experimental.',
    available: false,
    reason: 'Use a local source build; the combined binary redistribution grant is unresolved.',
    downloadBytes: null,
    url: null,
    sha256: null,
  },
  {
    id: 'org.dolphin.wasm',
    name: 'Dolphin (experimental WASM JIT)',
    systems: ['com.provenance.gamecube', 'com.provenance.wii'],
    description:
      'GameCube and Wii with a real PPC-to-WASM JIT, disk-backed files up to 9 GiB, software video and GameCube-controller input. Wii Remote input and synchronized saves are unavailable.',
    available: false,
    reason:
      'Use the verified operator-local package; public distribution awaits a corresponding-source rebuild.',
    downloadBytes: null,
    url: null,
    sha256: null,
  },
  {
    id: 'org.libretro.parallel-dc',
    name: 'Dreamcast & Sega arcade (parallel-dc)',
    systems: [
      'com.provenance.dreamcast',
      'com.provenance.naomi',
      'com.provenance.naomi2',
      'com.provenance.atomiswave',
    ],
    description: 'Dreamcast and Sega arcade systems.',
    available: false,
    reason:
      'The local interpreter boots Dreamcast and Naomi; catalog packaging and Atomiswave media support are still being prepared.',
    downloadBytes: null,
    url: null,
    sha256: null,
  },
  ...upstreamPlayerCatalog,
];
