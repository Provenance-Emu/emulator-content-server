import type { PluginManifest } from '@ecs/plugins';
import type { PlayerCatalogEntry } from '@ecs/protocol';
import { customPlayerProvenance } from './player-catalog-provenance.js';
import { upstreamPlayerCatalog } from './player-catalog-upstream.js';
export interface TrustedPlayer extends PlayerCatalogEntry {
  url: string | null;
  sha256: string | null;
  provenance?: {
    sourceInfo: string;
    infoSha256?: string;
    license: string;
    firmware?: { path: string; optional: boolean }[];
    /** Published receipt linkage, not an independent source rebuild or license audit. */
    sourceMapping?: 'release-receipt' | 'unverified';
    artifacts?: {
      kind: 'source' | 'notices' | 'build';
      url: string;
      sha256: string;
      sizeBytes: number;
    }[];
  };
  upstream?: {
    manifest: PluginManifest;
    resources: { url: string; file: string; sha256: string; sizeBytes: number }[];
  };
}
const catalogEntries: readonly TrustedPlayer[] = [
  {
    id: 'org.libretro.fceumm',
    name: 'FCEUmm (NES)',
    systems: ['com.provenance.nes'],
    description: 'NES games with battery saves and states. Verified isolated browser runtime.',
    available: true,
    reason: null,
    downloadBytes: 4484298,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/fceumm.ecsplayer',
    sha256: 'eaa1ae964a36226a9484d1501b02c083a3b720a8dcfa272506d7e88d0ad5fc48',
  },
  {
    id: 'org.libretro.virtualjaguar',
    name: 'Virtual Jaguar 3.10.0',
    systems: ['com.provenance.jaguar', 'com.provenance.jaguarcd'],
    description:
      'Virtual Jaguar 3.10.0 with cartridge and Jaguar CD HLE (profile 1.2.0). Tested CDI/CHD and CUE/BIN playback, up to 512 MiB total per disc; real BIOS, audio-only discs and save synchronization are unavailable.',
    available: true,
    reason: null,
    downloadBytes: 4608650,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/virtualjaguar.ecsplayer',
    sha256: '84b7028c2c08a63a86a3b1feb07a199d4ec76966105a9b22769fbbdbd0503cd8',
  },
  {
    id: 'org.libretro.prosystem',
    name: 'ProSystem (Atari 7800)',
    systems: ['com.provenance.7800'],
    description:
      'Software Atari 7800 core. Original cartridge rendering verified; synchronized saves and Safari compatibility are unverified.',
    available: true,
    reason: null,
    downloadBytes: 3622293,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/prosystem.ecsplayer',
    sha256: '61b298b7f19ca290c2e13bdee2a96c42f02a0b725e4f5b508e0593dc787d1428',
  },
  {
    id: 'org.libretro.stella2014',
    name: 'Stella 2014 (Atari 2600)',
    systems: ['com.provenance.2600'],
    description:
      'Atari 2600 software core. Original cartridge rendering verified; synchronized saves and specialized controllers are unverified.',
    available: true,
    reason: null,
    downloadBytes: 4551425,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/stella2014.ecsplayer',
    sha256: '731a455c2bf1465c988dd410c3eabe0c6ae7f4e8039e6eb94e04c00e884f3da4',
  },
  {
    id: 'org.libretro.freeintv',
    name: 'FreeIntv (Intellivision)',
    systems: ['com.provenance.intellivision'],
    description:
      'Intellivision software core. Upload exec.bin and grom.bin using BIOS / support files. Browser startup verified; games and synchronized saves are unverified.',
    available: true,
    reason: null,
    downloadBytes: 4130085,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/freeintv.ecsplayer',
    sha256: 'f6e4101d8c682dc8875c2d16b2c010e0bc13251139b6952a024c7968be6c6b31',
  },
  {
    id: 'org.libretro.atari800',
    name: 'Atari800 (Atari 5200)',
    systems: ['com.provenance.5200'],
    description:
      'Atari 5200 software core with open-source Altirra OS fallback and correct 5200 startup defaults. Original A52 and raw BIN cartridge rendering verified; synchronized saves are unverified.',
    available: true,
    reason: null,
    downloadBytes: 4086268,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/atari800.ecsplayer',
    sha256: '6fc9403579297201344dac557228c3801d27f9c1b8ccee4184ea21370d3b604b',
  },
  {
    id: 'org.libretro.pokemini',
    name: 'PokeMini (Pokémon Mini)',
    systems: ['com.provenance.pokemonmini'],
    description:
      'Pokémon Mini software core with open-source FreeBIOS. Cartridge rendering, controls and Pokémon Party Mini boot verified; peripherals and synchronized saves are unverified.',
    available: true,
    reason: null,
    downloadBytes: 3756963,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/pokemini.ecsplayer',
    sha256: 'b9b77011f67649608d4c7f17052e29f879c745374b94b92691403d1c07b77fa4',
  },
  {
    id: 'org.libretro.potator',
    name: 'Potator (Supervision)',
    systems: ['com.provenance.supervision'],
    description:
      'Watara Supervision software core. Original cartridge rendering verified; commercial games and synchronized saves are unverified.',
    available: true,
    reason: null,
    downloadBytes: 3590070,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/potator.ecsplayer',
    sha256: 'd25b2d0fdd6c6fc1893727f643ed98a0073bbffcb4cf7fe142aad455b28ebbd4',
  },
  {
    id: 'org.libretro.sameduck',
    name: 'SameDuck (Mega Duck)',
    systems: ['com.provenance.megaduck'],
    description:
      'Mega Duck software core. Original cartridge rendering and controls verified; commercial games and synchronized saves are unverified.',
    available: true,
    reason: null,
    downloadBytes: 3617725,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/sameduck.ecsplayer',
    sha256: 'a3f42a84f9eae50f35042880c66afd049be62daa03d791df62046d35fbf24b69',
  },
  {
    id: 'org.libretro.mednafen-pcfx',
    name: 'Beetle PC-FX (CHD)',
    systems: ['com.provenance.pcfx'],
    description:
      'PC-FX software core with CHD support, up to 512 MiB. Upload pcfx.rom using BIOS / support files. CHD homebrew boot and controls verified; commercial discs and synchronized saves are unverified.',
    available: true,
    reason: null,
    downloadBytes: 4171357,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/mednafen-pcfx.ecsplayer',
    sha256: '845d8b632862d9a56e061b4a8eeafeea1f40858e894fd2f8838b65921b43c230',
  },
  {
    id: 'org.libretro.mupen64plus-next',
    name: 'Mupen64Plus-Next (experimental browser port)',
    systems: ['com.provenance.n64'],
    description:
      'Experimental Nintendo 64 interpreter with WebGL2 and real WASM fibers. Real-game boot and menu input verified; performance, broader compatibility and synchronized saves remain unverified.',
    available: false,
    reason:
      'Use the operator-local source build; renderer redistribution permission remains unresolved.',
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

export const playerCatalog: readonly TrustedPlayer[] = catalogEntries.map((entry) => {
  const provenance = customPlayerProvenance[entry.id];
  return provenance ? { ...entry, provenance } : entry;
});
