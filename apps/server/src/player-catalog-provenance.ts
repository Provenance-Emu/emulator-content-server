import type { TrustedPlayer } from './player-catalog.js';

/** Immutable verification receipts for reproduced custom runtimes. See the dated source audits. */
const coreProvenance: Readonly<Record<string, NonNullable<TrustedPlayer['provenance']>>> = {
  'org.libretro.fceumm': {
    sourceInfo:
      'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/e64001242b4dcc9057d9056be873c6d93ab03999/docs/operations/core-source-audit-2026-11-05.json',
    infoSha256: 'e0a681fcedb072299e615b04dd9cc56b6d0a0a5654eb28df8378667b15f1de05',
    license:
      'RetroArch GPL-3.0-or-later with the tracked SAVE_FILES patch | FCEUmm GPL-2.0-or-later; retained source and SDK notices',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/v0.1.4-cores.1/fceumm-source.tar.gz',
        sha256: '690b662a4d3466d7f8a626f752425c81629bb324d14cac10f67f48dba08f3fff',
        sizeBytes: 86189038,
      },
      {
        kind: 'build',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/e64001242b4dcc9057d9056be873c6d93ab03999/docs/operations/core-source-audit-2026-11-05.json',
        sha256: 'e0a681fcedb072299e615b04dd9cc56b6d0a0a5654eb28df8378667b15f1de05',
        sizeBytes: 94911,
      },
    ],
  },
  'org.libretro.virtualjaguar': {
    sourceInfo:
      'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/e64001242b4dcc9057d9056be873c6d93ab03999/docs/operations/core-source-audit-2026-11-05.json',
    infoSha256: 'e0a681fcedb072299e615b04dd9cc56b6d0a0a5654eb28df8378667b15f1de05',
    license:
      'RetroArch GPL-3.0-or-later | Virtual Jaguar GPL-3.0; sanitized source and retained dependency notices',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/v0.1.6-jaguar-cd.1/virtualjaguar-source.tar.gz',
        sha256: '592cae4305c016eac93c0561ef1ba1913be9d5ab315df8fc52e7f187b79a7b0d',
        sizeBytes: 90859298,
      },
      {
        kind: 'build',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/e64001242b4dcc9057d9056be873c6d93ab03999/docs/operations/core-source-audit-2026-11-05.json',
        sha256: 'e0a681fcedb072299e615b04dd9cc56b6d0a0a5654eb28df8378667b15f1de05',
        sizeBytes: 94911,
      },
    ],
  },
  'org.libretro.prosystem': {
    sourceInfo:
      'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-verification-2026-11-06.json',
    infoSha256: 'e205aa630edad59b731a32cf396fe04cb2fb92ec82a0ac8b33de12c494998312',
    license:
      'RetroArch GPL-3.0-or-later | ProSystem GPL-2.0-or-later; preserve all upstream dependency notices',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-prosystem-2026.10.31.1/prosystem.source.tar.gz',
        sha256: 'a615cf27233adf34285fd81fb778c348308e665f4c69338bc19e44b3574f0145',
        sizeBytes: 84687336,
      },
      {
        kind: 'notices',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-prosystem-2026.10.31.1/NOTICES.txt',
        sha256: '4c41bc8a055b55f946b483445567e7d3f5c8f4c9a057c9c7555bb1a78178cf42',
        sizeBytes: 1605,
      },
      {
        kind: 'build',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-verification-2026-11-06.json',
        sha256: 'e205aa630edad59b731a32cf396fe04cb2fb92ec82a0ac8b33de12c494998312',
        sizeBytes: 46739,
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
      'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-verification-2026-11-06.json',
    infoSha256: 'e205aa630edad59b731a32cf396fe04cb2fb92ec82a0ac8b33de12c494998312',
    license:
      'RetroArch GPL-3.0-or-later | Stella 2014 (Atari 2600): GPL-2.0-or-later; preserve all upstream dependency notices',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-stella2014-2026.10.31.1/stella2014.source.tar.gz',
        sha256: '264d6fd075130db989a16a0d18cda8a6c737711cb6ec3d26be1edd374d5e9963',
        sizeBytes: 85325890,
      },
      {
        kind: 'notices',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-stella2014-2026.10.31.1/NOTICES.txt',
        sha256: '93a025aa08a4a14f460b694cf0a03b6ee7151506998ebb62faebdaf7ad9da2f9',
        sizeBytes: 1917,
      },
      {
        kind: 'build',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-verification-2026-11-06.json',
        sha256: 'e205aa630edad59b731a32cf396fe04cb2fb92ec82a0ac8b33de12c494998312',
        sizeBytes: 46739,
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
      'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-verification-2026-11-06.json',
    infoSha256: 'e205aa630edad59b731a32cf396fe04cb2fb92ec82a0ac8b33de12c494998312',
    license:
      'RetroArch GPL-3.0-or-later | FreeIntv (Intellivision): GPL-2.0-or-later; preserve all upstream dependency notices',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-freeintv-2026.10.31.1/freeintv.source.tar.gz',
        sha256: 'f17e78502f78c10912c000ed39408e052d0359377c1f4685ed49fea6cfa3a30d',
        sizeBytes: 110359373,
      },
      {
        kind: 'notices',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-freeintv-2026.10.31.1/NOTICES.txt',
        sha256: '9c81b13123628a5e63dfb4cd4859d677837285fd0a1974832868f746c8761d15',
        sizeBytes: 1924,
      },
      {
        kind: 'build',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-verification-2026-11-06.json',
        sha256: 'e205aa630edad59b731a32cf396fe04cb2fb92ec82a0ac8b33de12c494998312',
        sizeBytes: 46739,
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
      'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-verification-2026-11-06.json',
    infoSha256: 'e205aa630edad59b731a32cf396fe04cb2fb92ec82a0ac8b33de12c494998312',
    license:
      'RetroArch GPL-3.0-or-later | Atari800 (Atari 5200): GPL-2.0-or-later; preserve all upstream dependency notices',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-atari800-2026.10.31.2/atari800.source.tar.gz',
        sha256: 'eddd87be440f3a3ed1c971a86fd1ef5f6ee21e582b67d7678972ded60e0bc436',
        sizeBytes: 86503686,
      },
      {
        kind: 'notices',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-atari800-2026.10.31.2/NOTICES.txt',
        sha256: '5e71750b8329a3005dbaa8ff7f48c5edb7f15e0459e1f93978ae06cdd4f87c0c',
        sizeBytes: 2093,
      },
      {
        kind: 'build',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-verification-2026-11-06.json',
        sha256: 'e205aa630edad59b731a32cf396fe04cb2fb92ec82a0ac8b33de12c494998312',
        sizeBytes: 46739,
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
      'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-verification-2026-11-06.json',
    infoSha256: 'e205aa630edad59b731a32cf396fe04cb2fb92ec82a0ac8b33de12c494998312',
    license:
      'RetroArch GPL-3.0-or-later | PokeMini (Pokémon Mini): GPL-3.0-or-later; includes original open-source FreeBIOS and its generating source',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-pokemini-2026.10.31.1/pokemini.source.tar.gz',
        sha256: '7bdb562ac7c5cee8e4ece42e6653401e91bba5eed1741c6706e4c92ce8b2efee',
        sizeBytes: 84766667,
      },
      {
        kind: 'notices',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-pokemini-2026.10.31.1/NOTICES.txt',
        sha256: '770635309cf14315dad53b309bada9f5842845c0a7ae443149e1e48a1a240bef',
        sizeBytes: 2048,
      },
      {
        kind: 'build',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-verification-2026-11-06.json',
        sha256: 'e205aa630edad59b731a32cf396fe04cb2fb92ec82a0ac8b33de12c494998312',
        sizeBytes: 46739,
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
      'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-verification-2026-11-06.json',
    infoSha256: 'e205aa630edad59b731a32cf396fe04cb2fb92ec82a0ac8b33de12c494998312',
    license:
      'RetroArch GPL-3.0-or-later | Potator (Supervision): Unlicense; preserve all upstream dependency notices',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-potator-2026.10.31.1/potator.source.tar.gz',
        sha256: 'efbcdfdbec0a7035115ceef33a37a4c03c90f16b7e867dd63cd832b83c79d88b',
        sizeBytes: 84570095,
      },
      {
        kind: 'notices',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-potator-2026.10.31.1/NOTICES.txt',
        sha256: '4737e99adefa422512631cdf851283b7f1b78eb55c9ee23426fcf9c1809b71cf',
        sizeBytes: 1954,
      },
      {
        kind: 'build',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-verification-2026-11-06.json',
        sha256: 'e205aa630edad59b731a32cf396fe04cb2fb92ec82a0ac8b33de12c494998312',
        sizeBytes: 46739,
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
      'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-verification-2026-11-06.json',
    infoSha256: 'e205aa630edad59b731a32cf396fe04cb2fb92ec82a0ac8b33de12c494998312',
    license:
      'RetroArch GPL-3.0-or-later | SameDuck (Mega Duck): MIT; preserve all upstream dependency notices',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-sameduck-2026.10.31.1/sameduck.source.tar.gz',
        sha256: '778db81165c216fc023696d194b23dc6b569772bc71a6d7a44d358802619b014',
        sizeBytes: 85613300,
      },
      {
        kind: 'notices',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-sameduck-2026.10.31.1/NOTICES.txt',
        sha256: 'a78ad4f055cc5ad91fc92111832b1cf196b1dc7fa753379ce8e88e1188de26be',
        sizeBytes: 1961,
      },
      {
        kind: 'build',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-verification-2026-11-06.json',
        sha256: 'e205aa630edad59b731a32cf396fe04cb2fb92ec82a0ac8b33de12c494998312',
        sizeBytes: 46739,
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
      'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-verification-2026-11-06.json',
    infoSha256: 'e205aa630edad59b731a32cf396fe04cb2fb92ec82a0ac8b33de12c494998312',
    license:
      'RetroArch GPL-3.0-or-later | Beetle PC-FX (CHD): GPL-2.0-or-later; libchdr BSD-3-Clause and all dependency notices retained',
    sourceMapping: 'release-receipt',
    artifacts: [
      {
        kind: 'source',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-mednafen-pcfx-2026.10.31.1/mednafen-pcfx.source.tar.gz',
        sha256: '6851fb1c8ad64076917c48f7a972ed9c87c6087925ddb69396cfccf7dc0da20f',
        sizeBytes: 85511927,
      },
      {
        kind: 'notices',
        url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-mednafen-pcfx-2026.10.31.1/NOTICES.txt',
        sha256: '0cce439edadc2364381df0a9e847b6c860791a231be1a8dacc211e65cbbeafeb',
        sizeBytes: 1993,
      },
      {
        kind: 'build',
        url: 'https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/7fa5f66a46906055c9f22dcb1bd78aa542f847cd/docs/operations/custom-build-verification-2026-11-06.json',
        sha256: 'e205aa630edad59b731a32cf396fe04cb2fb92ec82a0ac8b33de12c494998312',
        sizeBytes: 46739,
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

export const customPlayerProvenance: Readonly<
  Record<string, NonNullable<TrustedPlayer['provenance']>>
> = Object.fromEntries(
  Object.entries(coreProvenance).map(([id, provenance]) => [
    id,
    {
      ...provenance,
      artifacts: [...(provenance.artifacts ?? []), ...sdkNotices],
    },
  ]),
);
