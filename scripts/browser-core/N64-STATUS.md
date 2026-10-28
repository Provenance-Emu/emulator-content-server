# N64 Emscripten attempt: unavailable

The bounded 2026-10-28 source attempt did not produce a playable profile. Do not
advertise N64 availability or package these partial objects as an emulator.

Official source: https://github.com/libretro/mupen64plus-libretro-nx

Pin: `15bada85906593376e8fd697f1b0b3af3a20f512`

Toolchain: Emscripten SDK 3.1.46, compiler
`19607820c447a13fd8d0b7680c56148427d6e1b8`.

The official Emscripten target disables the dynarec. The attempted build selected
GLideN64 GLES3, HLE RSP, no parallel RSP/RDP and no threaded audio:

```
emmake make -j2 platform=emscripten CC=emcc CXX=em++ AR=emar \
  GLES3=1 FORCE_GLES3=1 HAVE_PARALLEL_RSP=0 HAVE_PARALLEL_RDP=0 HAVE_THR_AL=0 LLE=0
```

The frontend intended for a later validated build is RetroArch
`4d4bfc0fbaacca30d433e5c11b0b2b5242141b66`, with `HAVE_OPENGLES3=1`,
`HAVE_THREADS=0`, MEMFS and the same ES module/callMain interface. No frontend
link or ROM execution was attempted because the source barriers below are
already conclusive. No ROM/BIOS was downloaded or included.

## Confirmed barriers

1. SDK compiler crash with `-fcommon`. The build fails while compiling
   `mupen64plus-core/src/api/debugger.c`, in LLVM AsmPrinter global emission.
   An independent one-line input reproduces it:

   ```c
   unsigned int op; unsigned int read_op(void) { return op; }
   ```

   `emcc -O3 -fPIC -fcommon -c common.c` crashes; replacing `-fcommon` with
   `-fno-common` succeeds. Removing PIC does not fix it. A later recipe must
   override `-fcommon` for Emscripten and check any resulting duplicate globals.

2. Unsupported coroutine implementation. `libretro-common/libco/libco.c` selects
   `sjlj.c` on WASM. That implementation uses `sigaltstack`, `SIGUSR1` and
   `sigaction` to create a coroutine. SDK 3.1.46
   `system/lib/libc/emscripten_libc_stubs.c:219` returns `-1`/`ENOSYS` from
   `sigaltstack`; therefore `co_create` returns NULL. The core's
   `libretro/libretro.c:727` creates `game_thread` during initialization and later
   switches to it. Current upstream higan libco also has no Emscripten backend.
   A proper `emscripten_fiber` adapter and Asyncify-enabled frontend are required;
   neither fake coroutine success nor native-signal stubs are acceptable.

3. Renderer follow-up after those barriers: GLideN64's
   `Graphics/OpenGLContext/opengl_GLInfo.cpp` decides `isGLESX` from `GL_VERSION`.
   The existing opaque browser path can expose backend version wording, as the
   Dreamcast acceptance already established. The eventual WebGL2 build must
   select GLES3 shaders by its Emscripten target and verify real rendering.

The selected source and partially compiled objects are retained externally at
`~/.cache/ecs-web-player-build-20261028/mupen64plus-next`; compiler log is
`n64-build.log` beside that directory. The independent compiler probe is under
`/tmp/ecs-n64-compiler-probe`. This is a handoff for a coroutine port, not a
manifest-only compatibility claim.

## Licensing

Mupen64Plus core headers grant GPL-2.0-or-later. GLideN64's root license says
GPLv2; its whole upgrade grant has not been established. Any future static GPLv3
RetroArch combination needs that grant confirmed before public distribution.
Keep all original license files and third-party notices. No N64 binary is being
published from this attempt.

## Legacy official ParaLLEl web pair: ABI-blocked

A second bounded attempt on 2026-10-28 used the actual official 2019 web pair,
not the current source build above. Fresh downloads matched the cached loader:

| Resource | Bytes | SHA-256 |
| --- | ---: | --- |
| `https://web.libretro.com/parallel_n64_libretro.js` | 307585 | `fab15b23ab3946694d7ab7b72c6522c7565996534840a435866c1f7c156446cc` |
| `https://web.libretro.com/parallel_n64_libretro.wasm` | 2974008 | `c88916cb9bcae5c45da12d0180133e66b5335f7a4c56fa777fe8c7d82ffa1c32` |

The server returned Last-Modified timestamps of 2019-08-06 21:46:46 GMT for the
loader and 21:46:47 GMT for the WASM. No exact corresponding source commit has
been established; these are artifact pins, not a source/provenance claim.

`wrap-legacy-parallel-n64.mjs` is an **operator-local diagnostic recipe**, not an
available emulator package. It preserves the entire pinned upstream loader
verbatim inside a lexical `Module`/`FS` promise factory. Its only resource adapter
maps the loader's eager, unused `.wast` and `.temp.asm.js` fallback location
queries to the same declared WASM URL. Other resources still pass through the
normal strict resolver; no extra resource, worker, import, origin permission,
BIOS, native coroutine shim, or emulator stub is introduced. The manifest uses
`org.libretro.parallel-n64`, the existing `retroarch-emscripten-esm` ABI, MEMFS,
no synchronized saves, and only single `z64`, `n64`, or `v64` cartridges.

The authorized operator-local 240p Suite homebrew file was hydrated and uploaded
into an isolated temporary test catalog. In Chromium 145 headless, the existing
`allow-scripts` opaque iframe reached WASM instantiation, which failed with:

```
LinkError: WebAssembly.instantiate(): Import #4 "env" "_gl_glsl_backend":
global import must be a number, valid Wasm reference, or WebAssembly.Global object
```

Inspection confirms that the WASM imports `env._gl_glsl_backend` as a **global**,
while the paired official loader defines `_gl_glsl_backend` as a function that
prints `missing function: gl_glsl_backend` and aborts. The loader also contains
missing shader-driver function stubs. This failure precedes guest execution;
there is no nonblank emulation frame or input-response acceptance. A successful
factory/profile parse would not satisfy that acceptance either. Do not supply
a fabricated address, zero global, or replacement renderer stub to bypass it.
The two source-build coroutine barriers and this independent legacy-pair ABI
barrier remain unresolved; N64 stays unavailable.

To reproduce the diagnostic profile outside the repository:

```
node scripts/browser-core/wrap-legacy-parallel-n64.mjs \
  /external/parallel_n64_libretro.js \
  /external/parallel_n64_libretro.wasm \
  /external/new-n64-diagnostic-profile
cd apps/web
ECS_ACCEPTANCE_HEADLESS=1 \
ECS_ACCEPTANCE_N64_PLUGIN=/external/new-n64-diagnostic-profile \
ECS_ACCEPTANCE_N64_CONTENT=/external/operator-homebrew.z64 \
  pnpm test:browser player-n64-legacy.spec.ts
```

The opt-in browser test skips unless both paths are supplied. It rejects an
unhydrated cloud placeholder before reading it, requires actual compositor
pixel variation and a controller-induced frame change if initialization ever
succeeds, and currently fails on the confirmed import incompatibility. It never
downloads console content and contains no tracked ROM fixture. Retain source and
license review as a separate prerequisite before any future distribution.
