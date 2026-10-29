# Virtual Jaguar 3.10.0 CD HLE acceptance

The new player profile `org.libretro.virtualjaguar` version `1.1.0` restores
upstream CD HLE alongside cartridge/ABS support. The earlier ECS package already
used the `3.10.0` source family, but its distribution wrapper explicitly rejected
CD content and removed the CD extensions. This change corrects that wrapper.

The source pins are Virtual Jaguar `ffea7893a59dd9b9e6f9b85c51627810338b0778`,
RetroArch `4d4bfc0fbaacca30d433e5c11b0b2b5242141b66`, and Emscripten `3.1.46`
(`19607820c447a13fd8d0b7680c56148427d6e1b8`). Build with the
[Jaguar recipe](../../scripts/browser-core/README.md#virtual-jaguar-3100-cartridge-and-cd-hle).
The helper copies immutable committed inputs with reflinks where available,
preserves incomplete compiled work on failure, and does not modify operator
checkouts. All four embedded boot-ROM arrays were replaced with zero initializers
before compilation and verified to remain zero in the source archive. Both
initial loading and disc insertion force upstream CD HLE; external firmware
staging and firmware-only boot modes are disabled.

The official [upstream v3.10.0 release](https://github.com/libretro/virtualjaguar-libretro/releases/tag/v3.10.0)
offers an Emscripten bitcode core. Its ordinary source includes embedded firmware;
the delivered profile instead builds the sanitized source described above.

## Functional checks

Three opt-in real-core browser cases passed in 45.4 seconds using Chromium with
ANGLE/SwiftShader. Each used generated original content, an isolated temporary
server, an opaque iframe sandbox, and no firmware files. Each asserted advancing
emulated 68000 counters and an actual green compositor frame, with no page errors.

| Original program | Result | Runtime |
| --- | --- | --- |
| ABS RAM program | Passed | 13.3 s |
| Standard-layout cartridge | Passed | 14.8 s |
| Two-session CDI data disc | Passed | 13.1 s |

The default headless GPU path failed before core initialization with the same
WebGL-context error on both the previously published and new profiles. The test's
explicit software-WebGL option resolved this environment issue. Production
security and runtime behavior were unchanged. Ten focused build/snapshot/fixture
script regressions also passed.

## Pinned delivery

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `virtualjaguar.ecsplayer` | 4,604,914 | `8b274aef3918bc8bc35719e417308d43134177057e2cbf5481ab36bfa001791e` |
| `virtualjaguar-source.tar.gz` | 90,859,298 | `592cae4305c016eac93c0561ef1ba1913be9d5ab315df8fc52e7f187b79a7b0d` |
| Loader | 273,128 | `18e98d8ad251363d509782023e34b2b7bffa3a4048856ebe922a2957c9c2531b` |
| WASM | 4,330,867 | `fff4746e146f15ea968edeb8ece6c1b8558ab5fe8819ec50814359ac52e7cc27` |

The profile supports Jaguar and Jaguar CD, exposing self-contained CDI and CHD
files up to the browser contract's 512 MiB cap. CHD support was compiled but not
exercised by this browser case; compatible session metadata remains required as
described by [upstream CHD operations](https://github.com/libretro/virtualjaguar-libretro/blob/master/docs/jagcd-chd.md).
CUE/BIN parsing exists in the core, while browser track-bundle staging remains
unavailable and CUE is not advertised. Audio-only discs, GPU-only cartridge boot,
real BIOS boot, synchronized saves, and commercial-title compatibility are outside
this acceptance.

The package and source archive are published in
[v0.1.6-jaguar-cd.1](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/v0.1.6-jaguar-cd.1).
The publicly downloaded package was hash-verified before catalog pinning and
local installation. The installed profile is version 1.1.0 with both Jaguar
systems advertised; existing enabled/default player settings were preserved.
