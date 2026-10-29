# One-core Nostalgist comparison — 2026-10-28

## Recommendation

Keep the Svelte player and direct Emscripten adapter. Use Nostalgist as a reference and consider small attributed MIT-licensed parts where they reduce maintenance. The spike demonstrates that Nostalgist can also run behind our opaque sandbox with our existing interface and authenticated saves, so it remains a viable alternative. It does not demonstrate enough replacement of our existing responsibilities to justify adopting the whole wrapper now.

The user's target is primarily Mac and iPhone users, especially Safari, with Chrome/Firefox also relevant. Experimental browser features may be offered to advanced users; they should be detected explicitly and remain optional. None of the successful cases here required experimental browser flags.

This was an authorized throwaway comparison, not a production integration. No player source, package dependencies, lockfile, server policy or installed player registry was changed. The prototype and downloaded runtime assets remain outside the repository at `/Users/jmattiello/.cache/ecs-nostalgist-spike-20261028`.

## Inputs and method

- Nostalgist npm package **0.23.0**, published source commit `4534b28e2f3f59e6760b6f133575ee452b3fb266`. Package tarball SHA-256: `529099b3993111b6f6f80e645f5321b5fd7c38734e54806ab8830b3e602e23ca`. ESM distribution SHA-256: `745a0fbef6b65213ba88b133251f891365507cda42caf56c180f169c0d28b665`.
- The same cached, pinned FCEUmm loader/WASM pair in both paths. Frontend base `4d4bfc0fbaacca30d433e5c11b0b2b5242141b66`, core `ac0d00a7fc01166f84c7bac01d1084ebfd2b865e`, SDK 3.1.46; existing SAVE_FILES correction. Loader SHA-256 `4198e886f14d2c82a41c6405523f6dc748177bf1a4cadb97e93ce49a77cfcef8`, WASM SHA-256 `c54d033d3f7856074e48bf824bc92b9b2e6f9cf3d529d4d646685ed626d62205`.
- The repository's original `examples/browser-playback/acceptance.s`, assembled outside the repository using ca65/ld65. This is a generated NES program with a battery-backed counter and changing palette, not commercial content or firmware.
- CRT-easymode from `libretro/glsl-shaders` commit `468f67b6f6788e2719d1dd28dfb2c9b7c3db3cc7`. The downloaded shader retains its upstream GPL notice and stays outside the repository. This experiment is not a decision to distribute a shader pack.
- Visible browser execution on macOS. Playwright Chromium **145.0.7632.6**, WebKit **26.0**, Firefox **146.0.1**, plus desktop WebKit using the iPhone 13 device profile.

The runtime harness bundles the existing `startPlayer`/sandbox importer and uses the actual sandbox document and CSP extracted from server source. Nostalgist is injected only into an in-memory copy of that first-party bootstrap. A temporary adapter stages the existing `/ecs` writes, supplies core/content bytes to Nostalgist, and maps its save paths back to the existing save synchronizer. Core/WASM inputs are identical; Nostalgist internally rewrites loader source as part of its normal startup.

No CDN fetch is needed inside the sandbox: the host supplies core, ROM, wrapper and shader bytes; permitted Blob URLs handle module/resource loading. Parent-document access, app storage access and an attempted same-server fetch were blocked. The existing importer also checks the frame's handshake origin is `null`. This establishes feasibility for the tested operations, not an audit of every possible library path.

A second harness uses an ephemeral real content server, the existing built Svelte player, generated owner credentials, authenticated uploads and the original save controls. For the Nostalgist case it substitutes only an in-memory sandbox bootstrap through browser routing. No credentials enter the core. The test server and its generated data are removed at completion.

## Results

The runtime comparison exercised four modes in each of four browser configurations: direct, direct with CRT shader, Nostalgist, and Nostalgist with CRT shader. All **16** cases started, rendered, resized to a 512×480 backing canvas, accepted keyboard input, saved battery/state data and restored the saved counter from **2 back to 1**. The Nostalgist cases also returned state/thumbnail blobs and standalone screenshot blobs. Shader-enabled frame captures differed from their unfiltered counterparts, and CRT-mask output was visually inspected.

| Browser configuration | Direct startup/input/save/load/resize | Nostalgist startup/input/save/load/resize | GLSL rendering in both | Nostalgist state + thumbnail and screenshot |
| --- | --- | --- | --- | --- |
| Chromium 145 | Passed | Passed | Passed | Passed |
| WebKit 26.0 desktop | Passed | Passed | Passed | Passed |
| WebKit 26.0, iPhone 13 profile | Passed | Passed | Passed | Passed |
| Firefox 146 | Passed | Passed | Passed | Passed |

The unchanged Svelte interface and real authenticated server passed in **four additional cases**: direct and Nostalgist in Chromium and desktop WebKit. The visible save controls uploaded an 8 KiB battery save and a nonempty state, input advanced the counter, and selecting that server state after reloading restored counter 1. No UI alerts remained. Chromium automation used focus/Enter for save controls, following the existing real-core acceptance test; pointer-click automation had stalled waiting for completion in the first attempt, whereas WebKit passed either path. This is a retained acceptance caveat, not a claimed product fix.

In eight targeted direct-runtime follow-ups, enabling thumbnails and waiting for a bounded, nonempty PNG produced a valid preview in all eight cases. A state command acknowledgement alone did not reliably imply that its thumbnail was already complete: initial reads sometimes found no file or a zero-length PNG.

**The direct standalone screenshot prototype is not a pass.** Its final GPU-capture probe produced PNGs in only two of eight cases (unfiltered desktop/mobile-profile WebKit); the other six exceeded a 12-second deadline. Nostalgist's standalone screenshot helper passed in its eight runtime cases. The probes used different capture sequences: the direct call followed command-based state capture, while the wrapper screenshot followed its own state helper. This does not isolate whether the difference is wrapper completion handling, configuration or a native state/screenshot interaction. Resolve this before shipping the direct screenshot path; Nostalgist's capture helpers are the strongest immediate reuse candidate from this comparison. The [machine-readable receipt](browser-player-nostalgist-comparison-2026-10-28.json) preserves both successful and unsuccessful outcomes.

## What adopting Nostalgist would change

| Area | Benefit from Nostalgist | Work we still own |
| --- | --- | --- |
| Startup | Resolvable byte/blob inputs, RetroArch defaults, loader compatibility handling | Verified host loading, profile selection/capabilities, sandbox protocol and cancellation |
| Scaling | Existing `resize()` convenience method | Aspect ratio, integer scaling, responsive layout, high-DPI policy, fullscreen/windows; direct runtime already exports `setCanvasSize()` |
| Shaders | Preset/file staging and launch configuration | Curated assets, parameters, per-game settings, performance checks and runtime capability detection |
| States/screenshots | Blob-returning helpers, file completion polling, thumbnail pairing | Server associations/gallery, compatibility identity, retries, export, conflict handling and safe operation ordering |
| Core options | Initial core-configuration file generation | Runtime option discovery/categories/allowed values, live changes, restart requirements and override UI |
| BIOS | Filesystem staging helpers | Required-firmware metadata, validation, permissions, storage and readiness UI; NES did not exercise BIOS behavior |
| Inputs/devices/windows | Keyboard helper methods and some event handling | Mapping editor/overlays, device permissions and adapters, popout lifecycle and platform behavior |

The full ESM distribution is about 104 KiB before transport compression, including bundled helpers and core metadata. This is not a performance benchmark or an apples-to-apples size comparison with our application. The more significant cost is that our own runtime/save layer would remain, with an additional wrapper and adapter to maintain.

## Important integration findings

1. **Our current loader validator will not accept the complete wrapper as an operator core loader.** It rejects imports and worker/worklet patterns. The spike instead placed the wrapper in the first-party sandbox bootstrap. A real integration would need an explicit reviewed packaging/profile design; bypassing validation or adding `allow-same-origin` is not the proposed solution.
2. **Nostalgist patches loader source text.** Its compatibility helper selects known factory names and rewrites particular Emscripten source strings to access runtime internals. Our current loader uses its default ESM factory directly. Either approach still needs per-build acceptance; a library upgrade does not verify the installed cores.
3. **Save completion semantics differ.** Nostalgist prefers native `_cmd_*` methods and polls for a file's size to stabilize. Our synchronizer waits for a completed command reply and preserves upload idempotency and conflict baselines. Do not replace that contract with file existence alone. The spike retained our synchronizer for server writes.
4. **Do not mix save owners casually.** A preliminary sequence that called our command-based save first and then the wrapper's state helper exceeded its short deadline. Running the wrapper helper first passed. The cause was not fully isolated; this is a reason to design one serialized operation owner, not to claim Nostalgist cannot save states.
5. **Thumbnail readiness is separate.** After a successful state reply, wait separately for preview completion with a deadline, size/type validation and a missing-preview fallback. Preserve a valid state even if its thumbnail fails.
6. **Configured output directories need to exist before startup.** The direct screenshot experiment needed explicit directory creation as well as configuration. Raw-frame and GPU-output screenshot paths also need separate acceptance, particularly when shaders are enabled.
7. **Browser execution matters.** An early headless Chromium attempt failed during graphics setup in the direct runtime; visible execution passed. WebKit emitted a denied wake-lock warning from the core in both paths and stylesheet-policy warnings during browser screenshot capture. Those were not treated as clean-console passes.

## Scope limits

- Playwright WebKit is not installed Safari, and an iPhone viewport/device profile is not a physical iPhone. Safari 26.6.2 was present, but this comparison did not drive it. Physical Mac Safari and iPhone acceptance remain necessary before declaring support.
- This is one FCEUmm build and one generated program. No general statement about all installed cores, sustained performance, audio quality, gamepads or touch behavior follows from it.
- No BIOS, camera, mic, MIDI, gyro, WebGPU, Slang, popout or AirPlay acceptance was performed. Browser feature toggles cannot substitute for missing core/frontend adapters.
- The experiment was not a new security audit and did not test server conflict races. Existing conflict/retry code was retained; normal authenticated save round-trips were exercised.

## Useful reuse and next batch

Use the MIT wrapper's configuration defaults, shader staging, keyboard mapping tables and Blob-returning API shapes as focused references. If code is copied, pin its source and retain its license/attribution. Keep server synchronization and the bounded bridge under our ownership. EmulatorJS remains a useful separate reference for structured core-option metadata and mapping UI; it was not integrated or runtime-tested here.

The next implementation batch should add capability-gated pause/volume/resize operations, display scaling controls, screenshot capture and a state/thumbnail capture result to the existing bridge. Then build the state gallery and settings UI against those operations. Use stable Safari-compatible behavior as the default and make experimental capabilities opt-in with actual adapter/device checks.

## Evidence and reproduction

The external throwaway scripts are `run.mjs` (runtime comparison) and `ui.mjs` (unchanged UI/real-server round-trip) in `/Users/jmattiello/.cache/ecs-nostalgist-spike-20261028`. They are machine-local experiment code with absolute paths, not a supported test command or a dependency to ship. `run.mjs` supports `SPIKE_BROWSERS` and `SPIKE_MODES`; `ui.mjs` uses generated temporary data and credentials. The receipt stored beside this report contains sanitized outcomes and input hashes; raw logs, generated content, browser archives and emulator binaries stay outside the repository.

Primary references: [Nostalgist published source](https://github.com/arianrhodsandlot/nostalgist/tree/4534b28e2f3f59e6760b6f133575ee452b3fb266), [launch API](https://nostalgist.js.org/apis/launch/), [state/thumbnail API](https://nostalgist.js.org/apis/save-state/), [RetroArch Emscripten](https://github.com/libretro/RetroArch/blob/4d4bfc0fbaacca30d433e5c11b0b2b5242141b66/Makefile.emscripten), [CRT shader source](https://github.com/libretro/glsl-shaders/blob/468f67b6f6788e2719d1dd28dfb2c9b7c3db3cc7/crt/shaders/crt-easymode.glsl).
