import type { TrustedPlayer } from './player-catalog.js';

/** Immutable verification receipts for reproduced custom runtimes. See the dated source audits. */
const coreProvenance: Readonly<Record<string, NonNullable<TrustedPlayer['provenance']>>> = {
  'org.libretro.fceumm': {
    sourceInfo:
      'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
    infoSha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
    license:
      'RetroArch GPL-3.0-or-later with the tracked SAVE_FILES patch | FCEUmm GPL-2.0-or-later; retained source and SDK notices',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/fceumm.source.tar.gz',
        sha256: '6b026eaee0441bef61af8fec90291d8804736d2be3ced543f8426251ddd80f1c',
        sizeBytes: 85306788,
      },
      {
        kind: 'build',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
        sha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
        sizeBytes: 42987,
      },
      {
        kind: 'notices',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/2bcdf7d84f7083991fe9c9c390d0a2e3ace361fc/docs/operations/legacy-build-verification-2026-11-06.json',
        sha256: '8947a56d2eb9bb4713cc508be2534d2ce2c0f90e6608ef80413c5451b350ea43',
        sizeBytes: 4305,
      },
      {
        kind: 'notices',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/2bcdf7d84f7083991fe9c9c390d0a2e3ace361fc/docs/operations/legacy-build-notices-2026-11-06.json',
        sha256: 'f4df30bc8ee1c1d89730a3b7db31b30d61d44df3984a3c6c7ee81cb5bd6afec7',
        sizeBytes: 1389719,
      },
    ],
  },
  'org.libretro.virtualjaguar': {
    sourceInfo:
      'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
    infoSha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
    license:
      'RetroArch GPL-3.0-or-later | Virtual Jaguar GPL-3.0; sanitized source and retained dependency notices',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/virtualjaguar.source.tar.gz',
        sha256: '52cceee6c95a57648aeb6a0916051453b7111b16ed1f28947fb92448cff5ca87',
        sizeBytes: 89989463,
      },
      {
        kind: 'build',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
        sha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
        sizeBytes: 42987,
      },
      {
        kind: 'notices',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/2bcdf7d84f7083991fe9c9c390d0a2e3ace361fc/docs/operations/legacy-build-verification-2026-11-06.json',
        sha256: '8947a56d2eb9bb4713cc508be2534d2ce2c0f90e6608ef80413c5451b350ea43',
        sizeBytes: 4305,
      },
      {
        kind: 'notices',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/2bcdf7d84f7083991fe9c9c390d0a2e3ace361fc/docs/operations/legacy-build-notices-2026-11-06.json',
        sha256: 'f4df30bc8ee1c1d89730a3b7db31b30d61d44df3984a3c6c7ee81cb5bd6afec7',
        sizeBytes: 1389719,
      },
    ],
  },
  'org.libretro.prosystem': {
    sourceInfo:
      'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
    infoSha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
    license:
      'RetroArch GPL-3.0-or-later | ProSystem GPL-2.0-or-later; preserve all upstream dependency notices',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/prosystem.source.tar.gz',
        sha256: '4c72510ebe30fb05fbbc6067f5f6b6992edc68cd61fcc6ecdc0db82317eda379',
        sizeBytes: 83907189,
      },
      {
        kind: 'notices',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/recovered-notices.zip',
        sha256: 'a8d34948be209eea543b2d13aa684e8b5ab445210a0d2892d19ea81dbe4568e2',
        sizeBytes: 89940,
      },
      {
        kind: 'build',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
        sha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
        sizeBytes: 42987,
      },
      {
        kind: 'notices',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-notices-2026-11-06.json',
        sha256: '9146ba310cc618ed5f9240a4c66bd27e0c348b7d15203b7ae630493a620e7c75',
        sizeBytes: 1911455,
      },
    ],
  },
  'org.libretro.stella2014': {
    sourceInfo:
      'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
    infoSha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
    license:
      'RetroArch GPL-3.0-or-later | Stella 2014 (Atari 2600): GPL-2.0-or-later; preserve all upstream dependency notices',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/stella2014.source.tar.gz',
        sha256: '5179aaa790a2db333e22493f7d5cfe62219972aee3d502472da84cf323e8aa56',
        sizeBytes: 84535573,
      },
      {
        kind: 'notices',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/recovered-notices.zip',
        sha256: 'a8d34948be209eea543b2d13aa684e8b5ab445210a0d2892d19ea81dbe4568e2',
        sizeBytes: 89940,
      },
      {
        kind: 'build',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
        sha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
        sizeBytes: 42987,
      },
      {
        kind: 'notices',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-notices-2026-11-06.json',
        sha256: '9146ba310cc618ed5f9240a4c66bd27e0c348b7d15203b7ae630493a620e7c75',
        sizeBytes: 1911455,
      },
    ],
  },
  'org.libretro.freeintv': {
    sourceInfo:
      'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
    infoSha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
    license:
      'RetroArch GPL-3.0-or-later | FreeIntv (Intellivision): GPL-2.0-or-later; preserve all upstream dependency notices',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/freeintv.source.tar.gz',
        sha256: '28a140acdcfb85053194b74019e0534b751745284311627c5de99b2028e61145',
        sizeBytes: 109443106,
      },
      {
        kind: 'notices',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/recovered-notices.zip',
        sha256: 'a8d34948be209eea543b2d13aa684e8b5ab445210a0d2892d19ea81dbe4568e2',
        sizeBytes: 89940,
      },
      {
        kind: 'build',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
        sha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
        sizeBytes: 42987,
      },
      {
        kind: 'notices',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-notices-2026-11-06.json',
        sha256: '9146ba310cc618ed5f9240a4c66bd27e0c348b7d15203b7ae630493a620e7c75',
        sizeBytes: 1911455,
      },
    ],
  },
  'org.libretro.atari800': {
    sourceInfo:
      'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
    infoSha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
    license:
      'RetroArch GPL-3.0-or-later | Atari800 (Atari 5200): GPL-2.0-or-later. Incorporated Caprice32 noncommercial terms. See component notice audit',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/atari800.source.tar.gz',
        sha256: '33f252f1a2caabd764d9c3e0d969f5dd97a31d856985ca0e625afdd8e69e47ed',
        sizeBytes: 85721531,
      },
      {
        kind: 'notices',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/recovered-notices.zip',
        sha256: 'a8d34948be209eea543b2d13aa684e8b5ab445210a0d2892d19ea81dbe4568e2',
        sizeBytes: 89940,
      },
      {
        kind: 'build',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
        sha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
        sizeBytes: 42987,
      },
      {
        kind: 'notices',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-notices-2026-11-06.json',
        sha256: '9146ba310cc618ed5f9240a4c66bd27e0c348b7d15203b7ae630493a620e7c75',
        sizeBytes: 1911455,
      },
    ],
  },
  'org.libretro.pokemini': {
    sourceInfo:
      'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
    infoSha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
    license:
      'RetroArch GPL-3.0-or-later | PokeMini (Pokémon Mini): GPL-3.0-or-later; includes original open-source FreeBIOS and its generating source',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/pokemini.source.tar.gz',
        sha256: '01c033a132fd4afdfd5ac11e7aa5aad4a5e94c95a5e5dddc4409c86b350fbe56',
        sizeBytes: 83989152,
      },
      {
        kind: 'notices',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/recovered-notices.zip',
        sha256: 'a8d34948be209eea543b2d13aa684e8b5ab445210a0d2892d19ea81dbe4568e2',
        sizeBytes: 89940,
      },
      {
        kind: 'build',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
        sha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
        sizeBytes: 42987,
      },
      {
        kind: 'notices',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-notices-2026-11-06.json',
        sha256: '9146ba310cc618ed5f9240a4c66bd27e0c348b7d15203b7ae630493a620e7c75',
        sizeBytes: 1911455,
      },
    ],
  },
  'org.libretro.potator': {
    sourceInfo:
      'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
    infoSha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
    license:
      'RetroArch GPL-3.0-or-later | Potator (Supervision): Unlicense. Incorporated M65C02 noncommercial distribution terms. See component notice audit',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/potator.source.tar.gz',
        sha256: '916718b66f1d835438c10143e91e5c6a30dc0132f9116532f62607025ebf5483',
        sizeBytes: 83811812,
      },
      {
        kind: 'notices',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/recovered-notices.zip',
        sha256: 'a8d34948be209eea543b2d13aa684e8b5ab445210a0d2892d19ea81dbe4568e2',
        sizeBytes: 89940,
      },
      {
        kind: 'build',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
        sha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
        sizeBytes: 42987,
      },
      {
        kind: 'notices',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-notices-2026-11-06.json',
        sha256: '9146ba310cc618ed5f9240a4c66bd27e0c348b7d15203b7ae630493a620e7c75',
        sizeBytes: 1911455,
      },
    ],
  },
  'org.libretro.sameduck': {
    sourceInfo:
      'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
    infoSha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
    license:
      'RetroArch GPL-3.0-or-later | SameDuck (Mega Duck): MIT; preserve all upstream dependency notices',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/sameduck.source.tar.gz',
        sha256: 'a025750464caff8643e045c4a9f0e034fbd3708c9f3ab5ed1cf570241575d642',
        sizeBytes: 84838062,
      },
      {
        kind: 'notices',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/recovered-notices.zip',
        sha256: 'a8d34948be209eea543b2d13aa684e8b5ab445210a0d2892d19ea81dbe4568e2',
        sizeBytes: 89940,
      },
      {
        kind: 'build',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
        sha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
        sizeBytes: 42987,
      },
      {
        kind: 'notices',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-notices-2026-11-06.json',
        sha256: '9146ba310cc618ed5f9240a4c66bd27e0c348b7d15203b7ae630493a620e7c75',
        sizeBytes: 1911455,
      },
    ],
  },
  'org.libretro.mednafen-pcfx': {
    sourceInfo:
      'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
    infoSha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
    license:
      'RetroArch GPL-3.0-or-later | Beetle PC-FX (CHD): GPL-2.0-or-later; libchdr BSD-3-Clause and all dependency notices retained',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.06.1/mednafen-pcfx.source.tar.gz',
        sha256: '0f18662d13af74146944cf82f17260777012e48c4fdf539152e78ea55f686d58',
        sizeBytes: 84737183,
      },
      {
        kind: 'notices',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/recovered-notices.zip',
        sha256: 'a8d34948be209eea543b2d13aa684e8b5ab445210a0d2892d19ea81dbe4568e2',
        sizeBytes: 89940,
      },
      {
        kind: 'build',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-notices-2026.11.07.1/catalog.json',
        sha256: 'cfee4af8d5460412cb60097602e2f3962c7582ea6bce5e540dcb75d9b0d8cf5b',
        sizeBytes: 42987,
      },
      {
        kind: 'notices',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-notices-2026-11-06.json',
        sha256: '9146ba310cc618ed5f9240a4c66bd27e0c348b7d15203b7ae630493a620e7c75',
        sizeBytes: 1911455,
      },
    ],
  },
};

const sdkNotices = [
  {
    kind: 'notices',
    url: 'https://raw.githubusercontent.com/emscripten-core/emscripten/19607820c447a13fd8d0b7680c56148427d6e1b8/LICENSE',
    sha256: '620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86',
    sizeBytes: 5093,
  },
  {
    kind: 'notices',
    url: 'https://raw.githubusercontent.com/emscripten-core/emscripten/19607820c447a13fd8d0b7680c56148427d6e1b8/system/lib/libc/musl/COPYRIGHT',
    sha256: 'f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af',
    sizeBytes: 6204,
  },
  {
    kind: 'notices',
    url: 'https://raw.githubusercontent.com/emscripten-core/emscripten/19607820c447a13fd8d0b7680c56148427d6e1b8/system/lib/compiler-rt/LICENSE.TXT',
    sha256: '1a8f1058753f1ba890de984e48f0242a3a5c29a6a8f2ed9fd813f36985387e8d',
    sizeBytes: 16708,
  },
  {
    kind: 'notices',
    url: 'https://raw.githubusercontent.com/emscripten-core/emscripten/19607820c447a13fd8d0b7680c56148427d6e1b8/system/lib/libcxx/LICENSE.TXT',
    sha256: '539dd7aed86e8a4f12cbdd0e6c50c189c7d74847e4fecc64ce2c6ee3a01da38b',
    sizeBytes: 16703,
  },
  {
    kind: 'notices',
    url: 'https://raw.githubusercontent.com/emscripten-core/emscripten/19607820c447a13fd8d0b7680c56148427d6e1b8/system/lib/libcxxabi/LICENSE.TXT',
    sha256: 'e2b35be49f7284a45b7baca8fc7b3ab7440e7902392b2528a457816b5bb2a15c',
    sizeBytes: 16706,
  },
  {
    kind: 'notices',
    url: 'https://raw.githubusercontent.com/emscripten-core/emscripten/19607820c447a13fd8d0b7680c56148427d6e1b8/system/lib/libunwind/LICENSE.TXT',
    sha256: 'b5efebcaca80879234098e52d1725e6d9eb8fb96a19fce625d39184b705f7b6d',
    sizeBytes: 16706,
  },
  {
    kind: 'notices',
    url: 'https://raw.githubusercontent.com/madler/zlib/04f42ceca40f73e2978b50e93806c2a18c1281fc/zlib.h',
    sha256: 'a980a0d104198a53cc220c51ab5856e5be901bec8a2d02e0ee79a8754219dfed',
    sizeBytes: 97323,
  },
  {
    kind: 'notices',
    url: 'https://raw.githubusercontent.com/emscripten-core/emscripten/19607820c447a13fd8d0b7680c56148427d6e1b8/system/lib/dlmalloc.c',
    sha256: 'de077adcccfc9fe18d91a4dc4d7bcc501156a9d28e982635c95931c763be7c96',
    sizeBytes: 236444,
  },
  {
    kind: 'notices',
    url: 'https://raw.githubusercontent.com/llvm/llvm-project/75501f53624de92aafce2f1da698b249a7293dc7/llvm/LICENSE.TXT',
    sha256: '8d85c1057d742e597985c7d4e6320b015a9139385cff4cbae06ffc0ebe89afee',
    sizeBytes: 15141,
  },
] as const;

const componentNoticeArtifacts = [
  {
    kind: 'notices',
    url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/62e01676665236ced30ee78a2fabc21a04e65e62/docs/operations/sha1-ijg-resolution-2026-11-06.json',
    sha256: '95675eaf2c80f4083c3d34bb9d08a309c77029b6c80dd000277185da38323ed2',
    sizeBytes: 20439,
  },
  {
    kind: 'notices',
    url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/2bcdf7d84f7083991fe9c9c390d0a2e3ace361fc/docs/operations/component-notice-audit-2026-11-06.json',
    sha256: '96527b71f80f0f273cc54159e24cf841915930fad4748f89c9b66ea6598e3079',
    sizeBytes: 707705,
  },
  {
    kind: 'notices',
    url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/2bcdf7d84f7083991fe9c9c390d0a2e3ace361fc/docs/operations/sdk-link-notices-2026-11-06.json',
    sha256: 'a745a2de37170442ed10bf214d6649529275b15a7e5340f6b1a117253b06d66b',
    sizeBytes: 510743,
  },
] as const;

export const customPlayerProvenance: Readonly<
  Record<string, NonNullable<TrustedPlayer['provenance']>>
> = Object.fromEntries(
  Object.entries(coreProvenance).map(([id, provenance]) => [
    id,
    {
      ...provenance,
      artifacts: [...(provenance.artifacts ?? []), ...sdkNotices, ...componentNoticeArtifacts],
    },
  ]),
);
