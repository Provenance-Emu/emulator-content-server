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
      'Virtual Jaguar 3.10.0 with cartridge and Jaguar CD HLE (profile 1.1.0). Self-contained CDI/CHD up to 512 MiB; real BIOS, audio-only discs, CUE track staging and save synchronization are unavailable.',
    available: true,
    reason: null,
    downloadBytes: 4604914,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/v0.1.6-jaguar-cd.1/virtualjaguar.ecsplayer',
    sha256: '8b274aef3918bc8bc35719e417308d43134177057e2cbf5481ab36bfa001791e',
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
