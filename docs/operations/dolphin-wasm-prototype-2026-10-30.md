# Dolphin WASM JIT integration prototype — 2026-10-30

Historical CPU-only receipt. The [October 31 browser integration](dolphin-browser-acceptance-2026-10-31.md) now provides real video and a separate-origin ECS player for the operator-local package. Restrictions below describe the October 30 prototype.

The real Dolphin WASM binary executes an original GameCube DOL using its PPC-to-WASM JIT. The prepared ECS C ABI host and reproducible diagnostic make that result repeatable. They are **not an installed player**: the current binary requires shared memory, which the existing opaque player iframe cannot obtain. No authenticated-origin sandbox exception, header change, firmware, game image, package publication or performance claim is part of this prototype.

## Pins and actual execution

| Input | Pin |
| --- | --- |
| Browser fork | [dougchansan/wasm-dolphin](https://github.com/dougchansan/wasm-dolphin/tree/7e38409ace3dda709c178312ff63fd92a3653cc7), `7e38409ace3dda709c178312ff63fd92a3653cc7` |
| Upstream Dolphin | `e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1` |
| ESM loader | 266,970 bytes; SHA-256 `7c78f3fc2207daab059af3b15c230c23d11205584cf1dfe89c65f66996e18b99` |
| WASM | 15,175,335 bytes; SHA-256 `d7395b3a94080f5b7d08a0522f59096007419d117b7b0eb868246429adee6f5c` |
| Toolchain declared by fork | Emscripten 5.0.7; compiler `263db4cffa6f9fc2ec514a70abac81362ea41849`; Windows x64 lock |

The probe copies only the verified loader/WASM into a new external directory. It makes one explicit, checked loader transformation: eager pthread pool size **16 → 2**, retaining the identical WASM and all emulation/JIT code. This bounds the diagnostic's eager workers; it does not make a non-threaded build or qualify two workers for general gameplay. Runtime memory remains fixed at 1,610,612,736 bytes (24,576 WASM pages), shared, with no growth.

Execution results on Node 22.22.2:

- Real dynamically generated WASM: `RunWasmJitSmoke(100) = 142`; PPC-style generated add-immediate `100 + 23 = 123`; generated integer block against Dolphin state returns `1`.
- Original, generated 288-byte DOL boots with the Software Renderer and cached interpreter/JIT. Entry `$80003100`; loop at `$8000310c`; guest counter at `$80004000`.
- The core reports `Running`, compiles two JIT blocks, and advances its JIT execution counter. A separate search for the generated instructions in emulated memory finds an advancing big-endian guest counter: **156,912,517 → 172,216,449** at the same heap location.
- This is CPU/JIT acceptance. The DOL does not program the VI or GPU; **video, sound, gamepad gameplay and commercial-disc compatibility are not verified**. The small tests separately verify that placeholder metadata frames cannot be mistaken for a rendered game.

The machine-readable receipt is [dolphin-wasm-prototype-2026-10-30.json](dolphin-wasm-prototype-2026-10-30.json). Full external probe receipts include the generated DOL hash, exact transformation and sampled execution counters. None contain game images or credentials.

## Reproduce the bounded probe

```
git clone https://github.com/dougchansan/wasm-dolphin.git EXTERNAL_FORK
git -C EXTERNAL_FORK checkout 7e38409ace3dda709c178312ff63fd92a3653cc7
node scripts/browser-core/dolphin-probe.mjs EXTERNAL_FORK NEW_EXTERNAL_OUTPUT
node --test scripts/browser-core/dolphin-abi.test.mjs
```

Node and the prebuilt fork assets suffice; no dependency installation, emulator source build or Rust build is needed. Both paths must be outside this repository; output must be new. Each real-core child process has a 30-second timeout and exits its worker process after the diagnostic. Reproduction preserves operator source and existing output. The generated DOL contains only original instructions and never enters the repository.

## Minimal host seam

`dolphin-abi.mjs` provides a browser-compatible C ABI adapter and DOL generator. Its factory entry point requires `crossOriginIsolated === true` and `SharedArrayBuffer` **before** creating a module; the existing opaque player therefore fails closed. It accepts a supplied factory and verified bytes, never fetches an arbitrary URL, and does not participate in session authentication.

| Responsibility | Real exported JS/C API | Prototype behavior |
| --- | --- | --- |
| Configure and initialize | `SetVideoBackend`, `SetCpuCore`, `SetCpuThread`, `SetPpcWasmJitEnabled`, `CoreInit` | Configure software renderer/cached CPU before init; dual-core emulation disabled. |
| Start / service / stop | `BootDisc`, `PumpHostJobs`, `StopCore`, `GetCoreStateName`, `GetCoreStatus` | Stage a bounded DOL in MEMFS; poll host jobs; teardown belongs to the owning worker. |
| Execution evidence | `GetPPCPC`, `GetCoreTicksLow/High`, `GetPpcWasmBlockCompileCount/RunCount` | Inspect actual CPU progress; no title-screen inference. |
| Software video | `GetVideoStats`, `FrameWidth/Height`, `FrameBuffer` | Copy bounded RGBA bytes only after an actual `xfb:` notification. Canvas2D can present these bytes; WebGPU is unnecessary for this route. Concurrent writes still require a proper production frame-transfer protocol. |
| Audio | `AudioSampleRate`, `AudioChannels`, `AudioBufferFrames`, `AudioBuffer`, `MixAudio` | Bounded stereo signed-16-bit pull buffers; an eventual AudioWorklet/resampler is host work. |
| Input | `SetInputState(mask, stickX, stickY, cX, cY, leftTrigger, rightTrigger, analogA, analogB, generation)` | Validate byte-valued analog input; caller must map ECS controls to GameCube button bits. |
| Real state operations | `SaveCoreState` / `LoadCoreState`, or `SaveStateFile` / `LoadStateFile` | Intentionally unexposed pending pause/flush/completion/persistence validation. |

Do **not** use the fork's `RunFrame` as CPU-frame advancement: it can paint a metadata placeholder. Its `SaveState` and `LoadState` compatibility functions are stubs returning slot validity. Neither is an acceptable save-completion contract. This ABI is separate from RetroArch's `callMain`/command protocol, so changing a manifest's runtime label would not integrate it.

## Non-threaded and WebGL findings

The pinned full-core build and active snapshot patch `0001-browser-platform-core.patch` hardcode `-pthread`, `USE_PTHREADS=1`, fixed shared memory and a pthread pool. `SetCpuThread(0)` disables Dolphin dual-core emulation; Dolphin's browser host still starts a pthread. Both the C++ wrapper and PPC JIT emit a shared-memory import with flags `0x03` and matching minimum/maximum pages. Removing the pthread flag or merely changing the loader cannot make those generated modules link against ordinary memory.

A real non-threaded port therefore needs three coordinated changes: a cooperative/yielding host execution loop, non-shared generated JIT memory imports, and removal or redesign of worker/thread synchronization. No supported switch accomplishing this was found. The separate `dolphin_web_discio` target parses disc metadata without proving full emulation; the fork's `build-native-core` scaffold is also not a substitute for the upstream Dolphin CPU.

The full core has Software Renderer, OGL/WebGL2, Null and WebGPU backends. The software framebuffer path avoids WebGPU and renderer shader translation but **does not avoid shared memory**. The fork's current configure driver also builds its Rust Naga bridge unconditionally and verifies a Windows-specific toolchain lock; running it unchanged on macOS is not a valid reproducible build. No large, knowingly blocked full compile was launched.

The active patch/source lock and artifact build receipt should be retained for distribution. The committed binary's receipt records a dirty-build override at its original build; this audit verifies exact artifacts and tests them but does not claim a fresh corresponding-source rebuild. Dolphin is GPLv2-or-later; preserve full corresponding sources and dependency notices before publishing a derivative.

## Safari and next integration decision

Safari has shipped WebGPU since Safari 26 on macOS, iOS, iPadOS and visionOS, according to [WebKit's platform announcement](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/#webgpu). That does not establish this fork's Safari support. Its renderer, threading/memory allocation and dynamic PPC-module imports still need target-device acceptance. The software path could avoid WebGPU compatibility issues; the same shared-memory restriction remains.

The current player must remain unavailable for this binary. The next concrete choice is either the cooperative non-threaded port above, or a separately reviewed isolated player origin with a narrow asset/message broker. An isolated-origin design must keep session credentials out of the core, preserve user-content access checks and byte/hash bounds, and supply its own COOP/COEP and worker-resource contract. Adding `allow-same-origin` to an authenticated-origin iframe is not an acceptable shortcut.

GameCube's generated DOL boot used the fork's IPL-skip and DSP HLE paths, without supplied firmware. Wii system data/NAND, user saves, firmware-dependent titles and Wii Remote input need separate managed contracts and acceptance. The fork currently documents no Wii Remote input implementation. No current prototype result claims Wii compatibility.
