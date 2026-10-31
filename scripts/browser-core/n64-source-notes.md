# Operator-local N64 fiber port

This recipe builds the pinned Mupen64Plus-Next and RetroArch sources using
Emscripten 3.1.46. It does not establish N64 availability or authorize binary
publication. GLideN64's root license specifies GPL version 2; a grant permitting
the entire renderer to join the GPL version 3 RetroArch binary remains unresolved.
The source stage retains all original license files and Git provenance. Keep
its player output operator-local until that distribution question is resolved.

Activate the pinned SDK, then run:

```sh
node --test scripts/browser-core/n64-fiber.test.mjs
node scripts/browser-core/build-n64-source.mjs \
  /external/frontend-n64 /external/mupen64plus-next \
  /external/new-n64-source-stage /external/new-n64-profile
```

The two build workers use full Asyncify, WebGL2, MEMFS, the cached CPU
interpreter and HLE RSP. Renderer threads are disabled at compilation. The
source-only changes replace the unsupported signal coroutine with real
Emscripten fibers, use a signature-correct coroutine entry callback, free
completed fibers, select GLES3 by the target, and namespace the core's vendored
graphics and audio symbols. No missing WASM import or coroutine is fabricated.

LLVM compiles the core and frontend objects at their normal optimization level.
Final Binaryen optimization is disabled for this bounded proof build. Its
optimized Asyncify local-coalescing pass took over thirteen minutes on the
first attempt. The full indirect-call instrumentation remains enabled.
The release setting `ASSERTIONS=0` is passed explicitly: at O0, omitting it
would enable Emscripten's development assertions. The pinned SDK's
`tools/acorn-optimizer.js` then prints the loader with `minifyWhitespace`,
removing comments without changing identifiers or code. The build rejects
imports, workers and worklets using the production loader capability scan.

The lifecycle regression executes the actual fiber backend as WebAssembly under
Node. It checks independent suspended stack state, nested fiber switching,
return to the caller, active context identity and heap recovery after repeated
creation/deletion. It skips when the external SDK or core headers are absent;
set `ECS_N64_EMSDK` and `ECS_N64_CORE` to select another external pinned checkout.

The completed source stage includes `ECS-BUILD.json` with source/compiler pins,
flags, source-diff and recipe hashes, artifact hashes and the local-only status.
It also records the raw loader hash, the SDK AST printer hash and its passes.
Rebuild and verify those hashes with:

```sh
node scripts/browser-core/rebuild-n64-source.mjs \
  /external/n64-source-stage /external/new-rebuilt-n64-profile
```

Generate the original BIOS-free qualification cartridge outside the repository:

```sh
node scripts/browser-core/n64-source-original-program.mjs /external/original.z64
```

Its original MIPS code runs in the existing PIF boot-HLE IPL3 window. It writes
green and blue RGBA5551 gradients to RDRAM, configures VI scanout, and polls the
actual SI/PIF controller-read path. With no pressed button, the screen is green;
holding any N64 button switches to blue, and releasing it restores green.
The unchanged core's default face mapping sends Libretro B to N64 A and
Libretro Y to N64 B. Libretro A alone is unmapped with the default
`mupen64plus-alt-map=False`; it becomes C-Down when the alternate mapping or
R2 C-button mode is active. Use keyboard `z` (Libretro B), or a D-pad direction,
for default-profile input acceptance. The program checks both returned button
bytes, including the C-buttons and L/R shoulder buttons. Its SI/PIF packet is
`01 04 01 00 00 00 00 FE`: one transmitted command byte, four response bytes
at offsets 3–6, and the end marker at offset 7. This matches the pinned core's
`setup_pif_channel` (`device/pif/pif.c`) and `JCMD_CONTROLLER_READ`
(`device/controllers/game_controller.c`) implementations.
Acceptance must verify those compositor pixels through the normal opaque player
iframe with `sandbox="allow-scripts"`. Use headless Chromium and mute audio;
hold the input key through the screenshot, then release it. Close the page and
test server afterwards. A profile parse, successful WASM link or lifecycle test
alone does not qualify guest execution.
