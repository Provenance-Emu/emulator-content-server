# Additional browser core builds

All source and compiled artifacts stay outside the repository. These builds use
the existing opaque iframe, MEMFS, `wasmBinary`, ES module factory and `callMain`
interface. Neither profile implements synchronized saves. Test programs are
original generated instructions, with no commercial game or console firmware.

## Pinned inputs

| Input | Official source | Revision |
| --- | --- | --- |
| RetroArch | https://github.com/libretro/RetroArch | `4d4bfc0fbaacca30d433e5c11b0b2b5242141b66` |
| Virtual Jaguar | https://github.com/libretro/virtualjaguar-libretro | `ffea7893a59dd9b9e6f9b85c51627810338b0778` |
| paraLLEl DC | https://github.com/libretro/parallel-dc | `1a678828f17f5f682a808a1fdc2103c913b0231a` |
| Emscripten SDK | https://github.com/emscripten-core/emsdk | tag `3.1.46`, `93360d3670018769b424e4e8f1d3d9b26d32c977` |

The compiler reports `3.1.46`, commit
`19607820c447a13fd8d0b7680c56148427d6e1b8`. Activate that SDK before invoking
either recipe. On the tested macOS machine, use Node 22 after activation because
the SDK prepends its older Node runtime. Each recipe records the actual build
flags. Existing source checkouts, output and temporary build directories must
be outside this repository. Never use a production data directory for tests.

## BIOS-free Virtual Jaguar

```
node scripts/browser-core/build-virtualjaguar.mjs FRONTEND_CHECKOUT CORE_CHECKOUT NEW_PLUGIN_DIRECTORY
```

The recipe builds a clean frontend snapshot and tracked core inputs, applies
`virtualjaguar-bios-free.mjs`, and emits the profile and corresponding source
archive. The sanitizer replaces the four embedded boot arrays with zero storage,
forces direct boot, removes BIOS selections, rejects CD/no-content and boot
payloads requiring GPU-only encrypted initialization. Its transformation script
contains no removed firmware bytes. Do not distribute an unmodified upstream
source archive containing those arrays as the BIOS-free corresponding source.

For an already extracted sanitized release archive, the separate
`rebuild-jaguar-source.mjs EXTRACTED_SOURCE_ROOT NEW_EXTERNAL_OUTPUT` helper uses
the included source directly, with the original frontend Git version supplied
explicitly; it needs no BIOS-bearing Git history. Its commands match the tested
checkout recipe; the standalone helper itself received syntax/lint validation,
without repeating the full build.

The native loader supports `j64`, `jag`, `rom`, `abs`, `cof`, `bin`, `prg`.
Standard ten-block (`0xf6`) commercial cartridge layouts are explicitly exempt
from the GPU-only boot heuristic in `src/core/file.c:JaguarCartNeedsBIOS`.
Formats with a valid 68000 entry use direct HLE boot; some GPU-only introductions
and Jaguar CD require omitted firmware and are unsupported. No commercial title
compatibility or audio accuracy was established by the smoke test.

`generate-smoke-program.mjs` produces an original ABS and a one-MiB universal
cartridge. Both set the Jaguar background green and increment guest RAM. The
opt-in headed browser test checks actual compositor output, an advancing guest
counter and opaque iframe isolation:

```
cd apps/web
ECS_ACCEPTANCE_JAGUAR_PLUGIN=/absolute/profile pnpm exec playwright test test/browser/player-additional-cores.spec.ts --grep Jaguar
```

RetroArch's `retroarch.c` grants GPL-3.0-or-later; Virtual Jaguar's root LICENSE
is GPLv3. Retain both licenses and all dependency notices in the complete source
tree (including libretro-common and libchdr). The sanitized build excludes the
proprietary boot arrays and does not load a BIOS file.

## paraLLEl DC: experimental, operator-local

```
node scripts/browser-core/build-parallel-dc.mjs FRONTEND_CHECKOUT CORE_CHECKOUT NEW_PLUGIN_DIRECTORY
```

Use a separate frontend checkout for this hardware-rendered core: it requires
`HAVE_OPENGLES3=1`, which selects WebGL2 / FULL_ES3. The original WebGL1 frontend
linked successfully but failed its depth/stencil framebuffer before loading the
test ELF. The recipe retains the interpreter, normal emulation and synchronous
CHD hunk decoder. The patch disables only thread-backed CHD read-ahead, linked
Naomi cabinets and replacement textures. WebAssembly cannot change native host
FP rounding/subnormal modes; the SH4 interpreter therefore has a numerical
accuracy limitation. This is not a speed or commercial compatibility claim.

The profile supports single files: `chd`, `cdi`, `elf`, `zip`, up to
512 MiB. CUE/GDI/M3U companion layouts, split parent sets and GD-ROM arcade sets
needing external CHDs are unsupported. The native ROMset loader can identify
unknown ZIP basenames by internal ROM names/CRCs, so fixed `game.zip` works for
self-contained identifiable sets; ambiguous merged clones are not guaranteed.

Dreamcast and Naomi/Naomi2 have upstream HLE boot paths. Atomiswave requires a
user-provided `/ecs/system/dc/awbios.zip`, containing `bios0.ic23` (131072 bytes;
expected CRC32 `719b2b0b`). The loader searches CRC first, then member name. A
bare `awbios.bin` is not that archive contract. No firmware is bundled; a compatible Atomiswave boot still needs separate acceptance.
The public playback catalog must withhold Atomiswave until that managed system
file is present, and must withhold the whole profile until a real boot passes.

The startup trap was traced with symbolized WASM to `glesrend::Init()` / shader compilation. The proc-address GL version string described a desktop backend, so the core selected GLSL 130 and the WebGL2 browser rejected it. The Emscripten patch explicitly selects GLES3 shader syntax for this WebGL2-only profile. No sandbox exception or firmware workaround is involved.

On 2026-10-28, the final optimized build passed the opaque-player tests for original Dreamcast ELF, Naomi ZIP and Naomi2 ZIP programs: advancing SH4 RAM counters, green compositor frames, and no page errors. Loader SHA-256 `5d37b75f75f6b9e0d97c30afb185e413518b72b983605139441099bc692f1c80`; WASM `7783aa6eae68155b98ce68a69235be8e2abcce0cc293273706683d7a4448d5c4`. This establishes original CPU/framebuffer boot, not commercial-game, sound, input or save compatibility. Atomiswave is still awaiting a real boot test.

Raw Naomi BIN/DAT mapping requires fixed-address mmap, unavailable in this SDK; the accepted tests use one original flat cartridge in ZIP, selecting upstream ArchivedCartridge. Raw BIN/DAT is excluded from this profile. Some operator Atomiswave folders contain Dreamcast-converted, multi-file GDI layouts; those need the companion-media adapter and cannot be treated as self-contained arcade ZIPs.

`generate-sh4-smoke.mjs` creates original little-endian SH4 ELF and flat
Naomi/Naomi2 programs that fill a framebuffer green and count in RAM. To run:

```
cd apps/web
ECS_ACCEPTANCE_PARALLEL_DC_PLUGIN=/absolute/profile pnpm exec playwright test test/browser/player-additional-cores.spec.ts --grep dreamcast
```

Distribution is currently **operator-local only**. The core README/root LICENSE
say GPLv2, while many inherited source headers grant GPL-2.0-or-later. The full
fork's upgrade grant has not been established, so compatibility with the static
GPLv3 RetroArch frontend is unresolved. Do not publish this combined binary as a
curated package until that grant is confirmed. Preserve all source and dependency
notices for a future review.
