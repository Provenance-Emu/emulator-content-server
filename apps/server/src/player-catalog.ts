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
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-prosystem-2026.10.31.1/prosystem.ecsplayer',
    sha256: 'd27dd1248abcda1598418b633f3e71f68fb11dcfb29757e7fb2eec48d0755d55',
  },
  {
    id: 'org.libretro.stella2014',
    name: 'Stella 2014 (Atari 2600)',
    systems: ['com.provenance.2600'],
    description:
      'Atari 2600 software core. Original cartridge rendering verified; synchronized saves and specialized controllers are unverified.',
    available: true,
    reason: null,
    downloadBytes: 4547701,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-stella2014-2026.10.31.1/stella2014.ecsplayer',
    sha256: 'ef724d23b070d5035dcaeab774ca1c5a15a8c37bebd54d39e2bddfad7b530f13',
  },
  {
    id: 'org.libretro.freeintv',
    name: 'FreeIntv (Intellivision)',
    systems: ['com.provenance.intellivision'],
    description:
      'Intellivision software core. Upload exec.bin and grom.bin using BIOS / support files. Browser startup verified; games and synchronized saves are unverified.',
    available: true,
    reason: null,
    downloadBytes: 4126365,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-freeintv-2026.10.31.1/freeintv.ecsplayer',
    sha256: 'e2a92eca25dfaa58e417219fa26cfbd08d26077430b5962ff7aeb64f3b40fedb',
  },
  {
    id: 'org.libretro.atari800',
    name: 'Atari800 (Atari 5200)',
    systems: ['com.provenance.5200'],
    description:
      'Atari 5200 software core with open-source Altirra OS fallback and correct 5200 startup defaults. Original A52 and raw BIN cartridge rendering verified; synchronized saves are unverified.',
    available: true,
    reason: null,
    downloadBytes: 4082548,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-atari800-2026.10.31.2/atari800.ecsplayer',
    sha256: '740025c312e6d5f602f2efc74b9b681f14cd445b4057ce4b0bda0aa15b417676',
  },
  {
    id: 'org.libretro.pokemini',
    name: 'PokeMini (Pokémon Mini)',
    systems: ['com.provenance.pokemonmini'],
    description:
      'Pokémon Mini software core with open-source FreeBIOS. Browser startup verified; commercial games, peripherals and synchronized saves are unverified.',
    available: true,
    reason: null,
    downloadBytes: 3753243,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-pokemini-2026.10.31.1/pokemini.ecsplayer',
    sha256: '74a012e237becb5078eea5edd91887b220463e1227b0b36bb35a30381fc57765',
  },
  {
    id: 'org.libretro.potator',
    name: 'Potator (Supervision)',
    systems: ['com.provenance.supervision'],
    description:
      'Watara Supervision software core. Original cartridge rendering verified; commercial games and synchronized saves are unverified.',
    available: true,
    reason: null,
    downloadBytes: 3586352,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-potator-2026.10.31.1/potator.ecsplayer',
    sha256: '03d3ca2fbc4d6ddf49bb021856e48fd0e093191df0f4aa30659ff09a2673a80b',
  },
  {
    id: 'org.libretro.sameduck',
    name: 'SameDuck (Mega Duck)',
    systems: ['com.provenance.megaduck'],
    description:
      'Mega Duck software core. Browser startup verified; commercial games and synchronized saves are unverified.',
    available: true,
    reason: null,
    downloadBytes: 3614005,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-sameduck-2026.10.31.1/sameduck.ecsplayer',
    sha256: '454a5a918a3652d8b4e106f0c62ffbf84d9a838ff1617570fc6056ae1ee12f48',
  },
  {
    id: 'org.libretro.mednafen-pcfx',
    name: 'Beetle PC-FX (CHD)',
    systems: ['com.provenance.pcfx'],
    description:
      'PC-FX software core with CHD support, up to 512 MiB. Upload pcfx.rom using BIOS / support files. Browser startup verified; disc boot and synchronized saves are unverified.',
    available: true,
    reason: null,
    downloadBytes: 4142979,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-mednafen-pcfx-2026.10.31.1/mednafen-pcfx.ecsplayer',
    sha256: '8900e3f1b32bfa0f1f7532a3b1dbe480447325eb57fb378d6a08e7d088846496',
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
