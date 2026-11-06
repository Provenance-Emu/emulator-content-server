# Core corresponding-source audit, 2026-11-05

The [byte and notice inventory](./core-source-audit-2026-11-05.json) records ten
published custom packages, their downloaded source archives and the 50 official
upstream profiles still awaiting an exact source/build mapping.

## Legacy runtime reconstruction

FCEUmm and Virtual Jaguar now have independently reproduced loader and WASM bytes
matching their existing published packages. Whole-package download hashes and
resource hashes were checked before comparison. The runtime reconstruction covers
the two resource files; the published wrapper manifests remain pinned separately.

| Profile | Source archive | Loader SHA-256 | WASM SHA-256 |
| --- | --- | --- | --- |
| FCEUmm | [v0.1.4 source](https://github.com/Provenance-Emu/emulator-content-server/releases/download/v0.1.4-cores.1/fceumm-source.tar.gz) | `4198e886f14d2c82a41c6405523f6dc748177bf1a4cadb97e93ce49a77cfcef8` | `c54d033d3f7856074e48bf824bc92b9b2e6f9cf3d529d4d646685ed626d62205` |
| Virtual Jaguar | [CD HLE source](https://github.com/Provenance-Emu/emulator-content-server/releases/download/v0.1.6-jaguar-cd.1/virtualjaguar-source.tar.gz) | `18e98d8ad251363d509782023e34b2b7bffa3a4048856ebe922a2957c9c2531b` | `fff4746e146f15ea968edeb8ece6c1b8558ab5fe8819ec50814359ac52e7cc27` |

The previous Jaguar audit missed the current media release's cross-release source
link. Its loader/WASM pair matches the preceding CD package exactly. The source
archive's four boot-ROM files contain zero initializers; their individual hashes
are recorded in the inventory. Source pins, sanitizer identity and HLE build
configuration are retained in its `ECS-BUILD.json` and recipe files.

The first reconstruction exposed missing reproducibility inputs in the existing
helpers. FCEUmm's published archive uses `retroarch/`, its included SRAM patch and
a README/build script, while the helper expected `frontend/` and `ECS-BUILD.json`.
Its corrected legacy mode uses the exact published package as the output hash
anchor. The receipt-based layout remains supported.

Both binaries embed the October 28 build date. The helpers now preserve it through
`SOURCE_DATE_EPOCH=1793145600`. Jaguar's sanitized build used an empty frontend Git
version. Passing a nonempty value also changes conditional code, so the helper
preserves `GIT_VERSION=`. FCEUmm retains its measured `4d4bfc0` frontend version.
The date/version-bearing objects are recompiled because make does not track
changes to those environment inputs. The exact-match run used the same extracted
source trees after incremental input corrections. Both helpers compare all output
hashes before publishing a new output directory.

All work used the existing Emscripten 3.1.46 toolchain, compiler revision
`19607820c447a13fd8d0b7680c56148427d6e1b8`. Source trees, packages and build output
stayed outside the repository. The catalog's published package URLs/hashes and
installed versions retain their existing values.

After verifying the source archive hash from the JSON inventory, extract it into
a fresh external directory with a containment-checking archive tool. Select the
pinned SDK, then use the matching helper from this repository.

```sh
node scripts/browser-core/rebuild-fceumm-source.mjs \
  /absolute/fceumm-source /absolute/new-fceumm-output \
  --package /absolute/fceumm.ecsplayer
node scripts/browser-core/rebuild-jaguar-source.mjs \
  /absolute/jaguar-source /absolute/new-jaguar-output
```

## Eight receipt-linked source archives

All eight source-archive downloads matched their retained release SHA-256 and size.
Each embedded `ECS-BUILD.json` manifest matched both the downloaded package and the
published `catalog.json`. Frontend/core commits, SDK/compiler pins and recorded
patches also matched. The inventory retains the corresponding source/build record
hashes and notice-file locations. Their independent rebuild status remains
publisher-reported.

The archive inspection inventoried regular files whose names begin with copying,
license, notice or copyright, bounded to 1 MiB per file and excluding AppleDouble
metadata. Named notices are retained inside each exact source archive. Inline
headers, precise linked-dependency applicability and license-completeness review
remain separate work. The SDK root, musl, compiler-rt, libc++, libc++abi and
libunwind notice files were also checked against the pinned official SDK sources.

## Official upstream mapping gap

The inventory records every affected upstream profile individually with its
existing pinned core-info hash and license metadata. Exact binary-to-source
mapping remains unverified for all 50 profiles. The inspected
[web player](https://web.libretro.com/),
[nightly index](https://buildbot.libretro.com/nightly/emscripten/) and
[build instructions](https://github.com/libretro/RetroArch/blob/master/pkg/emscripten/README.md)
provide artifact locations and frontend-linking guidance. A corresponding receipt
for ECS's pinned pairs remains outstanding. Full nightly-archive contents also
remain an inspection gap.

Closing that gap requires a source/build record tying each exact loader/WASM hash
to core/frontend revisions, SDK/compiler, flags, patches and applicable source and
notice artifacts. A repository's current head and a core-info revision describe
different evidence from that record. Existing upstream runtime compatibility and
content acceptance remain in the dated exception/PCSX receipts. Direct upstream
download plus verified local retention continues to supply the curated pairs.
