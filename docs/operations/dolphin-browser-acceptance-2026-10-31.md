# Dolphin: genuine VI output through a separate-origin browser runtime

The pinned Dolphin PPC-to-WASM JIT now boots an original generated DOL in Chromium and renders real video-interface output. This uses a separate loopback origin, a private MessagePort asset broker and blob-only runtime resources. No content-server authentication, existing opaque iframe, production endpoint, source checkout or emulator WASM was changed for the proof.

## Reproduce

```
node scripts/browser-core/dolphin-browser-probe.mjs PINNED_EXTERNAL_FORK NEW_EXTERNAL_OUTPUT
node --test scripts/browser-core/dolphin-abi.test.mjs
```

Use fork `dougchansan/wasm-dolphin` commit `7e38409ace3dda709c178312ff63fd92a3653cc7`, already pinned by `dolphin-probe.mjs`. The output directory must be new and outside this repository. Receipts, generated DOL and compositor screenshot remain in that external directory. No native Safari UI automation or full emulator build is required.

The original 452-byte PPC program fills a RAM XFB with green/blue BT.601 YUYV bands, writes the GameCube VI timing/framebuffer registers, then advances a guest RAM counter. It uses no ROM, BIOS or game data. VI registers and scanout semantics were checked against [Dolphin's pinned VideoInterface implementation](https://github.com/dolphin-emu/dolphin/blob/e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1/Source/Core/Core/HW/VideoInterface.cpp). This tests real CPU, MMIO, VI scanout, YUYV decoding and presentation; it does not test GameCube GPU drawing, commercial games, audio or Wii compatibility.

## Result and immutable bytes

- Chromium **145.0.7632.6**, headless, with no graphics/security bypass switches.
- Three distinct positive XFB publication sequences: **2, 3, 4**. Initial `xfb:0` is rejected by the host and cannot satisfy acceptance.
- Six generated PPC JIT blocks; execution count advanced **3,447,824 → 7,228,899 → 10,954,385** in the final bounded-resource separate-origin probe.
- Real VI geometry **320 × 240**, with the upstream default presentation scale producing **160 × 120**. Sampled upper pixel **[0,255,1,255]** and lower pixel **[0,0,255,255]**; screenshot visually inspected.
- Parent, companion and core worker all report cross-origin isolation. No page errors. The companion received exactly **one bootstrap GET**; it served no loader, WASM, content, filesystem or API route.
- Original WASM: **15,175,335 bytes**, SHA-256 `d7395b3a94080f5b7d08a0522f59096007419d117b7b0eb868246429adee6f5c`.
- Upstream loader: SHA-256 `7c78f3fc2207daab059af3b15c230c23d11205584cf1dfe89c65f66996e18b99`. The sole byte transformation remains eager pthread pool **16 → 2**. Transformed loader SHA-256: `0bfc73fbbf370d831fbce04239f062a93f885c053a86866ce5dca3a879be331f`.
- Original generated DOL SHA-256: `7d6123b0dad9d74883586dd366b10774a7b411ff5d177d3464ea7bdac6084ce7`.

The bounded pool is sufficient for this diagnostic, not a general gameplay qualification. Runtime memory remains a fixed **1.5 GiB SharedArrayBuffer**. Neither Safari support nor mobile memory viability is inferred from this Chromium result.

## Proven bridge contract

The top-level loopback page uses COOP `same-origin`, COEP `require-corp` and an explicit `cross-origin-isolated` permission for the companion. The iframe is on a **different origin**, with `sandbox="allow-scripts allow-same-origin"` and `allow="cross-origin-isolated"`. This does not add same-origin capability to an authenticated-origin frame.

The companion serves only fixed first-party bootstrap HTML. Its CSP permits the bootstrap script by SHA-256, blob scripts and `wasm-unsafe-eval`; **`connect-src blob:` and `worker-src blob:`** exclude HTTP runtime fetches. `frame-ancestors` names only the expected parent. Origin/source/nonce checks establish one private MessagePort; a second initialization is ignored. Loader/WASM are hash-checked before brokering and again by the companion, with strict resource sizes. The core receives no authentication token or parent network API.

Create verified loader, ABI and worker blob URLs on the companion origin. The worker imports the loader blob and calls its ESM factory with:

```
{
  wasmBinary,
  noInitialRun: true,
  mainScriptUrlOrBlob: loaderBlobUrl,
  locateFile(name) {
    if (name === 'dolphin-core-upstream.wasm') return wasmBlobUrl;
    throw new Error('Undeclared runtime resource');
  }
}
```

`mainScriptUrlOrBlob` makes the two Emscripten pthreads load the same verified loader blob. A declared WASM blob URL is still required by `locateFile`: the glue computes its filename even when `wasmBinary` is supplied. This is a runtime option, with **no additional loader patch**. The entire core execution path then uses blobs, compiled-module messages and shared memory.

## Host API requirements

Configure Software Renderer, cached CPU and `SetCpuThread(0)` before `CoreInit`, then call `BootDisc` on the bounded staged DOL path. Enable `SetPpcWasmJitEnabled(1)`. Service `PumpHostJobs`; do not use the diagnostic `RunFrame` as emulation advancement. `SetPresentationScale(1)` selects native presentation dimensions if desired; query `FrameWidth/Height` rather than assuming source geometry.

Require `GetVideoStats` to match `^xfb:([1-9][0-9]*)` and present only a new sequence. Copy bounded RGBA bytes from `FrameBuffer` into an owned buffer before transferring to the canvas host. `GetFrameSignalPtr` is atomically stored/notified after publication and can drive polling. The upstream buffer is reused, so its publication signal alone does not guarantee a tear-free concurrent snapshot; reliable captures may need a pause barrier or a subsequent frame-transfer contract. The proof's static colour bands do not qualify dynamic scene synchronization.

`SetInputState` takes `(mask, mainX, mainY, cX, cY, leftTrigger, rightTrigger, analogA, analogB, generation)`. Analog values are bytes; stick centers are 128 and released triggers are zero. Mask bits are A/B/X/Y = 0/1/2/3, Start = 4, L/R/Z = 5/6/7, D-pad up/down/left/right = 8/9/10/11, main stick up/down/left/right = 12/13/14/15, C-stick up/down/left/right = 16/17/18/19. This is the fork's custom mask, not native GameCube PAD bits. Keyboard/gamepad state must be cleared on blur/disconnect.

For audio, bound `MixAudio(requestedFrames)` by `AudioBufferFrames`; its return is the mixed frame count. `AudioBuffer` points to interleaved stereo signed 16-bit samples, normally at `AudioSampleRate() == 48000`. Copy before transfer, convert to float and resample for the actual AudioContext rate. No audible-output claim is made by this video program. Use real `SaveCoreState`/`LoadCoreState` or file variants only after a validated completion/persistence contract; legacy `SaveState`/`LoadState` are diagnostic stubs.

The existing opaque player remains unsuitable for this shared-memory binary. Production integration requires the separately isolated companion contract above, strict RPC/content bounds and independently verified lifecycle/persistence behavior. This proof adds no installable/public Dolphin package and makes no corresponding-source rebuild claim.


## ECS integration and current limits

The `org.dolphin.wasm` operator-local profile now runs through the normal authenticated
ECS player. The full player test passed in 9.8 seconds: a generated DOL is uploaded
to an empty test library, selected in the emulator picker, verified/collected by the
normal client, then transferred over the private port. JIT dispatches advance and
actual XFB output renders at 320 × 240. Pressing the configured A key reaches the
core's pad-poll mask (`input:1`); release returns it to zero. The reusable remapping,
keyboard, gamepad and touch bridge is reused; physical-controller acceptance is
still pending. GameCube defaults include both sticks, four face buttons, L/R and Z;
saved user layouts win over those defaults.

The [compact receipt](dolphin-browser-acceptance-2026-10-31.json) records this full-page
run separately from the standalone proof above. The parent remains authenticated;
the different-origin frame cannot access its DOM or local storage. Core/content
bytes are hash checked, and the reviewed loader/WASM pair is explicitly pinned
before workers are permitted. Other cores retain their original opaque sandbox.

The [isolated host contract](isolated-browser-player.md) documents authentication,
origin enforcement, cleanup and resource limits. The companion serves only fixed
first-party HTML; user ROMs and credentials never enter its HTTP server. Expired or
closed origins remain reserved as 404-only tombstones within that server run.

This first profile is **GameCube only**, with software video, one controller,
512 MiB staged content, no synchronized states/battery saves, and a fixed 1.5 GiB
shared WASM memory allocation. It advertises DOL/ELF/ISO/GCM/GCZ/RVZ/WIA/CISO;
the original DOL is the verified end-to-end input, not a compatibility claim for
every format or commercial title. Disc/GPU/audio compatibility, native Safari
Dolphin acceptance, Wii/NAND/Remote support, more controllers, streaming larger
discs and reliable concurrent frame capture remain deferred. Audio is wired to a
bounded stereo pull/scheduling path but is not qualified by this silent program.
No native/browser security settings are disabled. The package remains operator-local
until a clean corresponding-source rebuild and distribution notices are assembled.


## Local installation

The verified `org.dolphin.wasm` package is installed and enabled on the running local
server. Reload the UI and select **Dolphin (experimental WASM JIT)** for a compatible
GameCube file. Installed loader/WASM bytes were fetched through authenticated HTTP
and matched against the accepted hashes. Companion creation, bootstrap headers and
404 retirement were verified on the live server. The existing emulator default and
all 807 saved metadata/artwork selections are unchanged; no matching job was started.
Private package, consistent catalog backup and detailed receipts remain under the
ignored `dist-release/dolphin-browser-20261031` directory in the primary checkout.

Browser acceptance now defaults to headless and silent. Chromium tests explicitly
mute audio, the native Safari manual harness disables RetroArch audio, and test
pages/servers must be closed after a run. Native browser interaction requires an
explicit request for the current test; routine checks must not steal user focus.
