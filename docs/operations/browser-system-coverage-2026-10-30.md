# Browser system coverage and next core builds — 2026-10-30

This audit distinguishes installable packages, experimentally verified factory startup, and ports requiring a new integration. Catalog availability means a package can be installed, not that the operator has installed it or that every game works. The existing catalog has 35 pinned upstream pairs plus FCEUmm, Virtual Jaguar and PCSX ReARMed; four upstream game-engine entries are withheld for missing companion-data staging. The new unavailable entries make requested gaps visible without supplying an unverified download.

| Requested system | Existing browser path | Verification / remaining limit |
| --- | --- | --- |
| Atari 2600 | TIA | Official ESM factory startup verified; games and saves unverified. |
| Atari 5200 | Atari800 (unavailable) | Official `a5200` and `atari800` JS/WASM URLs returned 404. Needs a source build, firmware staging and original-program acceptance. `5600` is treated as the requested 5200, not a new system identifier. |
| Atari 7800 | ProSystem | New pinned source build passed opaque-player execution with generated instructions, an advancing RAM counter and a green compositor frame. No commercial-game or Safari claim. Official legacy artifacts cannot be installed unchanged. |
| GB / GBC | Gearboy, Gambatte, TGB Dual | Official ESM startup verified; game/save compatibility remains unverified. |
| GBA | mGBA, VBA Next | Official ESM startup verified. |
| NES | FCEUmm, Nestopia, QuickNES | FCEUmm has browser/save acceptance; other entries have factory startup only. No firmware-dependent FDS claim. |
| SNES | Snes9x, 2002, 2005, 2010 | Official ESM startup verified. |
| Game Gear | GearSystem, Genesis Plus GX | Official ESM startup verified. |
| Virtual Boy | Beetle VB | Official ESM startup verified. Beetle PCE Fast, Lynx, NeoPop and WonderSwan are also present. |
| Jaguar / Jaguar CD | Virtual Jaguar 3.10.0 / profile 1.2.0 | Published BIOS-free HLE package; generated ABS/cartridge/CDI/CHD/CUE programs accepted. Up to 512 MiB total disc group. No real-BIOS, audio-only CD or synchronized-save claim. |
| Dreamcast / Naomi / Naomi 2 | paraLLEl DC, operator-local | Generated ELF and self-contained ZIP programs passed framebuffer/SH4-counter acceptance. Interpreter, no commercial-game/sound/input claim. Publication is blocked by the unresolved GPLv2-only versus GPLv3 combined-build grant recorded in `ADDITIONAL-CORES.md`. |
| Atomiswave | paraLLEl DC, operator-local | Needs the user's `dc/awbios.zip` contract and real boot acceptance; never bundled. Companion GDI layouts need additional staging. |
| Flycast | Experimental external port, unavailable | Real SH4-to-WASM JIT source exists; different frontend ABI and Safari acceptance remain work. |
| GameCube / Wii | Experimental external Dolphin port, unavailable | Different C ABI and worker/shared-memory/WebGPU host; no ECS or Safari acceptance. Wii Remote input is absent in that port. |

## Safari and real JIT

Safari's JavaScriptCore compiles WebAssembly to native code using its BBQ/OMG JIT tiers (alongside an interpreter tier). That is real machine-code generation performed by the browser. A compiled emulator's native ARM/x86 dynarec cannot simply write executable bytes into WASM linear memory and jump there. A browser-compatible emulator dynarec instead emits new WASM modules, instantiates them through the browser API, and dispatches their exports through a shared function table. The browser compiles those modules to native instructions. This does not require enabling native iOS app JIT.

Sources: [WebKit's execution tiers](https://webkit.org/blog/17899/introducing-the-jetstream-3-benchmark-suite/), [WebKit's original WASM JIT design](https://webkit.org/blog/7691/webassembly/).

The [nasomers Flycast port](https://github.com/nasomers/flycast-wasm) includes a substantial `rec_wasm.cpp` emitter and published v1.0 JS/WASM assets (312,644 and 10,398,725 bytes at the time of this audit). Its code uses both synchronous `WebAssembly.Module`/`Instance` creation and asynchronous `WebAssembly.instantiate`, with imports of the same Emscripten memory and function table across generated modules. It is concrete prior work, not proof of Safari speed or Naomi/Atomiswave compatibility. Its own roadmap identifies WinCE/MMU and rendering gaps; no upstream speed claim was independently reproduced here.

The [build recipe](https://github.com/nasomers/flycast-wasm/blob/main/build-prod.sh) links an EmulatorJS RetroArch fork, exports `EJS_Runtime` and EJS-specific commands, enables WebGL2/Asyncify/table growth, and needs additional stubs/JS libraries. ECS expects an ESM default factory with its own command ABI, `FS`, `callMain`, bounded staged resources, and its opaque iframe. Integration requires a reproducible build against the selected frontend or a separately specified runtime adapter, then generated SH4 programs in Chromium and Safari, before game/firmware testing. Keep dynamic WASM compilation within the existing player CSP; do not grant general script evaluation or weaken the opaque sandbox to make a core boot. Safari feature support, dynamic module imports, exception behavior and compile bursts must be measured on the target OS/device.

The [Dolphin WASM fork](https://github.com/dougchansan/wasm-dolphin) has a PowerPC-to-WASM path and [pinned corresponding-source lock](https://github.com/dougchansan/wasm-dolphin/blob/main/provenance/dolphin-source.lock.json). It targets desktop Chromium, owns its worker/file/audio/input host and requires SharedArrayBuffer plus WebGPU presentation. This is a separate integration project: the present non-threaded ECS runtime does not provide that host. Preserve the current authentication, cross-origin isolation and sandbox guarantees while designing it. Neither this fork nor Flycast is presented as an installable ECS core.

## The user's Mednafen CHD fork

The inspected native source is the `Sources/mednafen/mednafen-src` submodule in Provenance's Mednafen package, revision `a28173736f623f74d1e9951b30ca5581bbe91e81`. Its actual upstream is [Provenance-Emu/mednafen-git, Provenance-master](https://github.com/Provenance-Emu/mednafen-git/tree/Provenance-master). The separately named `Core-Mednafen` repository currently exposes only `.gitignore`; it is not a usable source input for this build.

The CHD work lives in `src/cdrom/CDAccess_CHD.{cpp,h}`, `CDAccess.cpp` and `mednafen.cpp`. It already calls libchdr through normal filesystem paths, so MEMFS-backed `chd_open` is a viable route. The native package vendors libchdr with zlib, Zstandard, LZMA and dr_flac decoding. Rebuild those libraries for WASM; native SwiftPM archives cannot be linked into it. The native configuration hardcodes 64-bit `long`, `size_t`, pointers and Apple facilities, so reusing that generated `config.h` for wasm32 is incorrect.

Concrete build sequence:

1. Snapshot the pinned Mednafen submodule and vendored libchdr/dependency sources into an external build directory. Exclude native Swift/ObjC bridges, achievements client, embedded netplay server, Apple frameworks and existing native objects.
2. Cross-configure libchdr with the Emscripten CMake toolchain, `BUILD_SHARED_LIBS=OFF`, `WITH_SYSTEM_ZLIB=OFF`, `WITH_SYSTEM_ZSTD=OFF`, and build `chdr-static`. Its CMake tree already includes the vendored compression dependencies. Verify all dependencies exist in the source snapshot.
3. Generate a wasm32 Mednafen configuration and explicit source list for **one** system first (PCE CD is a smaller starting point than Saturn). The fork's autotools `src/Makefile.am` does not list `CDAccess_CHD.cpp`; add that file and libchdr link inputs in the external port build. Preserve Mednafen's integer/aliasing/exception compile semantics.
4. Add a C/C++ libretro bridge: initialization, content loading, video/audio, input, frame execution, serialization, memory access and environment callbacks. No `retro_init`/`retro_run` implementation was found in this native fork; its existing bridge is Swift/Objective-C++ for Provenance, so linking this tree into the existing RetroArch recipe alone is insufficient. A system-specific Beetle bridge is a possible starting point but needs adaptation to this Mednafen revision; do not replace the fork silently with Beetle.
5. Link a non-threaded ESM frontend with the ECS factory/command exports. Start with generated cartridge instructions to validate the ABI, then generated CHD sectors to verify codec, TOC, subchannel, seek and CD audio behavior. Stage only user-supplied firmware through the managed system-file contract. Package after opaque-frame Chromium/Safari acceptance, recording exact source and toolchain pins and full notices.

This audit did not modify the sibling core repository or claim a complete Mednafen WASM build. The missing libretro adapter/configuration are real porting work, so a shell command labeled as a working build would be misleading.

## New ProSystem package

`node scripts/browser-core/build-prosystem.mjs FRONTEND_CHECKOUT CORE_CHECKOUT NEW_EXTERNAL_PROFILE` builds core `8a88014287c7a01cd568067e5a557d0a2b2a051f` against RetroArch `4d4bfc0fbaacca30d433e5c11b0b2b5242141b66`, Emscripten 3.1.46, using immutable external snapshots and no threads. Optional console firmware is not included. The profile accepts single `.a78`/`.bin` cartridges up to 1 MiB and advertises no synchronized saves. Source headers explicitly grant GPL-2.0-or-later; retain them with RetroArch's GPL-3.0-or-later notices and every dependency notice.

The focused generated-program test passed in Chromium (7.9 seconds including setup): unchanged opaque `sandbox="allow-scripts"`, real MEMFS cartridge loading, an advancing guest counter and rendered center pixel `[16,130,0]`, with zero page errors. Its palette differs from the other generated cores, so this test uses a core-specific green threshold; red/blue checks remain. The test captures the compositor with a canvas bounding-box clip because a live canvas's geometry did not settle for Playwright's element screenshot stability check. The program supplies a valid background-only MARIA display list, with no ROM/BIOS fixture. Playwright's WebKit executable was unavailable; Safari acceptance remains pending.

```
cd apps/web
ECS_ACCEPTANCE_PROSYSTEM_PLUGIN=/absolute/profile ECS_ACCEPTANCE_HEADLESS=1 \
  ECS_ACCEPTANCE_SOFTWARE_WEBGL=1 pnpm exec playwright test \
  test/browser/player-additional-cores.spec.ts --grep 'Atari 7800'
```

Corresponding-source archives include the exact frontend/core sources, build receipt, dependency notices, and `rebuild-prosystem-source.mjs`. That helper verifies output hashes when rebuilding the extracted archive without Git. The fresh source build and runtime acceptance were run here; a second byte-for-byte archive rebuild was not repeated.
