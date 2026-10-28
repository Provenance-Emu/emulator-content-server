import type { PlayerCatalogEntry } from '@ecs/protocol';
export interface TrustedPlayer extends PlayerCatalogEntry {
  url: string | null;
  sha256: string | null;
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
    name: 'Virtual Jaguar',
    systems: ['com.provenance.jaguar'],
    description:
      'BIOS-free Atari Jaguar cartridges and ABS. Jaguar CD and GPU-only boot intros are not supported; save synchronization is unavailable.',
    available: true,
    reason: null,
    downloadBytes: 4609556,
    url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/v0.1.4-cores.1/virtualjaguar.ecsplayer',
    sha256: '62512cdbddba368ea8f59f2929a03d93e8cb0eda6471a09a6b20751bf1b3e119',
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
    reason: 'Browser runtime, large media and required BIOS support are being validated.',
    downloadBytes: null,
    url: null,
    sha256: null,
  },
];
