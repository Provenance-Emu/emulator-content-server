# Custom build verification, 2026-11-06

All eight remaining custom builds reproduced the published loader, WASM and
complete `.ecsplayer` package bytes from fresh, hash-verified source extractions.
The [verification receipt](./custom-build-verification-2026-11-06.json) retains
the original publisher receipts, source pins, resource comparisons and exact
SDK archive inputs.

| Core | Complete package SHA-256 | Compiler inputs |
| --- | --- | --- |
| atari800 | `740025c312e6d5f602f2efc74b9b681f14cd445b4057ce4b0bda0aa15b417676` | 1168 |
| freeintv | `e2a92eca25dfaa58e417219fa26cfbd08d26077430b5962ff7aeb64f3b40fedb` | 1026 |
| mednafen-pcfx | `8900e3f1b32bfa0f1f7532a3b1dbe480447325eb57fb378d6a08e7d088846496` | 1837 |
| pokemini | `74a012e237becb5078eea5edd91887b220463e1227b0b36bb35a30381fc57765` | 1060 |
| potator | `03d3ca2fbc4d6ddf49bb021856e48fd0e093191df0f4aa30659ff09a2673a80b` | 1011 |
| prosystem | `d27dd1248abcda1598418b633f3e71f68fb11dcfb29757e7fb2eec48d0755d55` | 1063 |
| sameduck | `454a5a918a3652d8b4e106f0c62ffbf84d9a838ff1617570fc6056ae1ee12f48` | 1022 |
| stella2014 | `ef724d23b070d5035dcaeab774ca1c5a15a8c37bebd54d39e2bddfad7b530f13` | 1867 |

## Reconstruction method

The existing ProSystem and software-core rebuild helpers ran against fresh source
trees with Emscripten 3.1.46 and `SOURCE_DATE_EPOCH=1793404800`, preserving the
published October 31 build date. Two builds ran concurrently, each with two make
jobs. The normal `packagePlayer` entry point reconstructed each complete package.
A subsequent debug relink reproduced the resource bytes again and retained the
actual linker operands, including the core archive and twelve SDK archives.

Emscripten revision `19607820c447a13fd8d0b7680c56148427d6e1b8` and LLVM revision
`75501f53624de92aafce2f1da698b249a7293dc7` identify the measured toolchain. Compiler
wrapping added `-MD -MF` dependency output and captured each invocation as JSONL
with `args`, `cwd`, `exitCode` and `dependencyFile`. Extra dependency output and
verbose logging preserved the compared runtime bytes.

The read-only collector consumes those records. The output path must be new.

```sh
node scripts/browser-core/collect-build-notices.mjs \
  /absolute/capture /absolute/source /absolute/emsdk /absolute/new-notices.json
```

Dependency records and regular inputs are bounded and contained within the
specified capture/source/SDK roots. The collector does not execute source code.
Fixtures test escaped paths, phony dependency targets, failed/outside-root inputs
and exact byte/line spans.

## Notice evidence

The [compiler-input inventory](./custom-build-notices-2026-11-06.json) deduplicates
2,502 source/header byte records and 18 ancestor notice-file records across the
eight builds. Every source-tree input was checked against its exact source archive
member. There were zero failed compiler calls or unresolved dependency paths.

Of 758 unique SDK inputs, 757 matched exact Git blob contents at the pinned
Emscripten or LLVM revision. The generated `emscripten/version.h` was reconstructed
byte-for-byte from its numeric version and pinned generator code. The installed
version string is `3.1.46`; the source tree uses `3.1.46-git`. The generator strips
that suffix before writing the same numeric macros.

Three additional notice references are retained with exact hashes and sizes.

- zlib 1.2.13 has its inline notice in `zlib.h` at upstream commit
  `04f42ceca40f73e2978b50e93806c2a18c1281fc`. The cached port archive matched the
  SHA-512 in the pinned SDK port recipe.
- dlmalloc carries allocator notices in the pinned SDK `system/lib/dlmalloc.c`.
- Clang builtin headers reference the LLVM license at the measured LLVM revision.

The catalog retains these three references alongside the previous six SDK notices
for all ten custom entries. The eight newly verified entries also link the receipt
and compiler-input inventory at an immutable repository commit. Provenance metadata
changes descriptor/cache identities. Operators can retain older catalog files and
their independent expected IDs for older cached versions.

## Remaining scope

Comment detection scans the first 64 KiB of actual compiler inputs and retains
hashes plus half-open byte offsets and inclusive line ranges. Ancestor filenames
are notice candidates. Symbolic-link notice entries are skipped. Compiler inputs
can include code discarded by the linker. The linked SDK archive list does not
identify selected archive members or resolve component-specific applicability.
Final notice completeness, late-file comments and legacy inline-input inventories
remain open.

Exact binary-to-source mappings for 50 official upstream pairs remain open in #29.
Content/gameplay qualification retains its separate scope. Downloaded packages,
source archives, compiler traces and build output stay outside Git at
`/var/tmp/ecs-custom-verification-2026-11-06`.

The [component notice follow-up](./component-notice-audit-2026-11-06.md) extends
this evidence with full-file scans, legacy compiler closure, selected SDK members
and component-specific terms. The [upstream inventory](./upstream-binary-mapping-2026-11-06.md)
resolves embedded revision references across all 50 pinned upstream pairs.
