# Flycast SH4 → WebAssembly JIT experiment

This operator-local recipe uses the real SHIL-to-WASM emitter from
[nasomers/flycast-wasm](https://github.com/nasomers/flycast-wasm) at
`16e9c7b4b7065a4bd42e7490e8aab3e9283d5415`, applied to
[flyinghead/flycast](https://github.com/flyinghead/flycast) at
`2c48c0188a2afc158b02b6d1865d898756a03071`. It links the existing ECS
RetroArch frontend at `4d4bfc0fbaacca30d433e5c11b0b2b5242141b66` using
Emscripten 3.1.46. Use independent external checkouts for all three sources;
no ROM, firmware, or generated binary belongs in this repository. The ECS patch
excludes upstream arcade NVMEM presets and the game-specific print template.
The replacement BIOS/printer fonts are generated from the free fonts identified
in upstream `fonts/biosfont.cpp` and `fonts/printerfont.cpp`; retain their
attribution and license notices with any eventual distribution.

Activate the SDK and run:

```sh
node scripts/browser-core/build-flycast-wasm.mjs \
  /external/RetroArch /external/flycast /external/flycast-wasm \
  /external/flycast-wasm-player
```

The recipe reads committed inputs into a new private temporary staging directory.
It never applies patches, cleans builds, or copies untracked/ignored files from
the caller checkouts. It fetches `asio`, `libchdr`, and `tinygettext` at their
Git tree gitlinks, recursively snapshots their own submodules, and verifies
tracked cleanliness and recursive commit pins before and after the build.
The pinned zlib CMake script renames its tracked `zconf.h` while configuring;
after compilation the recipe restores that header only when the renamed copy
exactly matches its committed content.
Unused platform submodules remain unmaterialized; all gitlinks are listed in
the receipt. The staging path is retained in the receipt for inspection.

The manifest exposes Dreamcast only. Naomi, Naomi2, and Atomiswave still need
managed firmware staging and separate original-program boot acceptance.

The output is an ESM default factory, MEMFS, no pthreads, WebGL2, and growing
WASM function table. The core defaults to HLE BIOS and framebuffer emulation,
with threaded rendering disabled. Audio uses RetroArch’s normal libretro callback;
the external port’s AudioWorklet sink is compiled out. The warmup calls execute
a real SH4 NOP rather than illegal opcode zero. `DYNAMIC_EXECUTION=0` forbids general JavaScript code
generation; the emitter uses WebAssembly compilation within the existing
player CSP. The ECS patch adds `_ecs_jit_executed_blocks()`, a double counter
incremented only after a successful indirect call into a runtime-compiled
WASM function. `_ecs_jit_executor_mode()` identifies the production dispatcher
(mode 6); it is diagnostic metadata, not the proof of execution. Compare the
execution count before/after running the original generated SH4 smoke program,
and check RAM counter/framebuffer data using `_fly_ram_ptr()`,
`_fly_vram_ptr()`, and `_fly_frame_count()`.

Do not publish the combined binary until the complete license grant audit is
resolved. Flycast files such as `core/emulator.cpp` expressly grant GPL v2 or
later. The port's README describes GPLv2 and its license file alone does not
clarify whether new code has the upgrade grant needed for combination with the
GPL v3-or-later RetroArch frontend. Record the source pins and patch digests in
the adjacent build receipt. The upstream port is experimental; successful
original-program execution does not establish game, WinCE/MMU, Naomi firmware,
or Atomiswave compatibility. No synchronized save completion is declared.
