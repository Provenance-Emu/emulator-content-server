# Web emulation plugin inventory and next step

## What already exists

`packages/plugins/src/manifest.ts` accepts a data-only player declaration with `systems` and a relative WASM `module`. `packages/plugins/src/player.ts` and `apps/plugins/src/host.ts` can report whether that artifact exists. They do not instantiate it. The plugin process and its feed routes do not expose a browser emulator runtime.

Browser playback is a separate first-party implementation. `apps/server/src/player-assets.ts` validates and snapshots one configured `--player-dir`; `packages/protocol/src/player-core.ts` describes that build. `apps/web/src/player/runtime.ts` and preflight validate its supported profile before launching it. The accepted build is pinned NES/FCEUmm, nonthreaded MEMFS, one `.nes` file, a bounded payload, and a known save-command ABI. Loader/WASM hashes and build pins are checked. This is working playback, with intentionally narrow compatibility.

The existing player-plugin inventory is therefore not yet connected to the browser playback path. For the modularized Emscripten output used here, the host needs the JavaScript factory/loader plus its WASM and declared resources; see the official [modularized-output](https://emscripten.org/docs/compiling/Modularized-Output.html) and [Module configuration](https://emscripten.org/docs/api_reference/module.html) documentation. The emulator profile also needs its runtime ABI, file layout, supported content and save behavior.

## Smallest useful next implementation

1. Add a versioned, data-only web-player profile contract: supported systems/content extensions, loader/WASM/additional asset hashes and sizes, runtime ABI, build provenance, memory/content limits, filesystem/thread requirements and save capabilities. Keep the current NES descriptor/API compatible as the default.
2. Validate installed profile files and snapshot only declared regular-file resources. Register accepted profiles and expose a bounded catalog through the content server. Keep profile discovery, artifact validation and browser execution separate; never execute Emscripten loader code in the HTTP/plugin credential process.
3. Keep a first-party launcher responsible for authentication, game selection, reads and save uploads. Before accepting third-party loader code, add a browser realm that cannot read the app origin’s sessions or credentials. An opaque-origin sandboxed frame is a candidate; authenticate its message channel by the expected window, a per-launch nonce and transferred MessagePorts, rather than trusting an origin string alone.
4. Pass only declared artifact bytes and the selected game/save data through that bounded channel. Give the core no bearer token, arbitrary server path, connector credential or generic privileged fetch bridge. Define launch, ready, input, save and shutdown messages with explicit quotas and cancellation.
5. Accept another known build end to end before advertising its system as playable. Test incompatible profiles, resource/hash/size failures, forged messages, credential isolation, teardown, and save round trips. BIOS files, archives/disc layouts, threads, workers/audio worklets, large memory and core-specific state formats need separate profile acceptance.

## Current trust boundary

The current trusted loader runs inside `/play` and can access that origin’s storage. Hashes pin the chosen code; they do not sandbox malicious JavaScript. Do not connect arbitrary operator plugin loaders to that authenticated document. The isolated launcher/channel should precede third-party core installation in the UI.

This inventory does not enable additional emulators or claim that a desktop libretro core will run unchanged in a browser. See [browser playback](browser-playback.md), [plugin operations](plugins.md), and the existing [web playback brief](../workstreams/web-playback.md).
