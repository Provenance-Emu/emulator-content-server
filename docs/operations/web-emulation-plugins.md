# Emscripten / WebAssembly player plugins

The server supports multiple installed browser emulators through versioned, data-only player manifests. The library shows Play for a compatible local single-file game; the player offers an **Emulator** selector when more than one installed profile matches. No emulator binary is bundled or downloaded automatically.

## Install a player

For normal setup use **Settings → Emulators**: one-click trusted installs or a native `.ecsplayer` file picker, enable/disable, default and managed removal. See [emulator management](emulator-management.md). The manual directory instructions below remain available to operators.

1. Copy the [installation template](../../examples/plugins/player-web/) into an operator-owned absolute directory, for example `/opt/ecs-players/my-emulator/`.
2. Put the self-contained Emscripten ES-module loader, WASM binary and any declared data files beside `plugin.json`. Set the supported system identifiers, content extensions, build version and content size limit to match that build.
3. Replace the template's zero SHA-256 values with hashes of the actual artifacts. For example, `shasum -a 256 loader.js core.wasm` prints the two digests.
4. Start `ecs serve --data ./content-data --player-plugins /opt/ecs-players`. `ECS_PLAYER_PLUGINS` selects the same registry. `ecs service install` persists the option too.
5. Reload the library interface and open Play on a supported game. Restart the server after installing or replacing a profile, then reload the interface.

Each immediate registry subdirectory contains one `plugin.json`. Its `kind` is `player`; `player.module` names the same WASM file as `player.web.wasm.file`. `player.web` specifies `profileVersion: 1`, runtime, MEMFS, threading, save completion, content extensions, build version, loader/WASM hashes and optional named assets. An executable plugin `entry` is not accepted in this registry. Existing player inventory manifests without `player.web` remain valid for the separate plugin host, but are not browser playback profiles.

Startup validates every configured profile and snapshots only declared regular files. Duplicate profile IDs, unsupported manifests, leaf/subdirectory symlinks, invalid WASM headers, digest mismatches and oversized resources fail configuration. No JavaScript or WASM executes in the HTTP server or the credential-bearing plugin process.

The legacy pinned NES/FCEUmm `--player-dir` is still supported and becomes the default profile when both options are configured. Its existing descriptor and resource API remain compatible. New clients use `/api/v1/player/profiles` and `/api/v1/player/profiles/:id`; protected resources are served from fixed `/play/plugins/:id/` routes. Read admission is required for profiles and artifact bytes. Responses are private/no-store.

## Runtime contract

`emscripten-esm-v1` requires a default asynchronous module factory accepting the Emscripten `Module` options, `FS.mkdirTree`, `FS.writeFile`, `FS.readFile` and `callMain`. It receives `wasmBinary`, a focusable canvas, `noInitialRun: true`, `noExitRuntime: true`, bounded logging and declared resource lookup functions. See the upstream [modularized output](https://emscripten.org/docs/compiling/Modularized-Output.html) and [Module configuration](https://emscripten.org/docs/api_reference/module.html) documentation for building that shape.

The launcher stages the selected game at `/ecs/content/game.<extension>`, preserving its supported extension, then calls `callMain([contentPath])`. `retroarch-emscripten-esm` instead receives `['-c', '/ecs/retroarch.cfg', contentPath]` and a configuration for fixed save/state/system directories. The build must return control to the browser event loop after main; it cannot require a blocking native loop.

Optional `player.web.assets` entries contain flat portable `name`, `file` and `sha256` values. They are exposed to the module through `locateFile` and `getPreloadedPackage`, and staged in MEMFS at `/ecs/system/<name>` before main. Resource names must match the names requested by the build. Relative/static/dynamic loader imports, undeclared dependencies, workers, worklets, threads and persistent filesystems are unsupported. Supply a self-contained loader built for this environment.

`saveCompletion: 'none'` supports playback without cloud save controls. `command-reply-v1` requires `EmscriptenSendCommand` and `EmscriptenReceiveCommandReply`, exact completed replies for `SAVE_FILES`, `SAVE_STATE_SLOT 0` and `LOAD_STATE_SLOT 0`, and raw single-file paths `/ecs/saves/game.srm` and `/ecs/states/game.state`. This is a build-specific adapter contract, not a generic Emscripten or libretro guarantee. Save uploads retain the existing item revision, keep-both conflict and retry/export behavior. Users explicitly select compatible saves; no cross-emulator state conversion is provided.

## Isolation and limits

The authenticated `/play/` document collects and verifies selected bytes, then launches a first-party frame with `sandbox="allow-scripts"` and an opaque origin. The core cannot read app storage or the parent document. A per-launch random nonce, expected frame window, opaque origin check and transferred MessagePort establish the channel. Only artifact/game/save bytes and fixed virtual filesystem, main, focus and save-command operations cross it. No token, API client, arbitrary privileged fetch or upload bridge is exposed.

The frame's content policy blocks network reads and workers; its sandbox blocks forms and navigation privileges. Declared resource Blob URLs support loader/WASM/data startup. The parent does not have Blob execution or WASM-eval permission. Removing the frame closes its private channel; startup and operations have deadlines, and navigation/cancellation releases it. This isolates origin credentials, not CPU or memory consumption by arbitrary code. Install builds you have tested and trust to behave.

| Resource | Limit |
| --- | --- |
| Profiles | 16, including a configured legacy player |
| Loader / WASM | 8 MiB / 64 MiB per profile |
| Declared extra assets | 16 files, 32 MiB total per profile |
| Startup snapshots | 256 MiB across the registry |
| Game / selected or captured save | Plugin game up to512MiB; saves64MiB; legacy NES64MiB, or a smaller declared game limit |
| Systems / extensions | 64 / 32 per profile |
| Pending runtime operations | 32 |

Local availability, system, extension, size, profile identity and resource hashes are checked before launch. Multi-file disc layouts and grouped sources are not advertised as playable. Larger discs, archive extraction, BIOS provisioning, threaded cores and additional save layouts need further adapters and acceptance.

## Validation status

Focused tests cover manifest compatibility, startup snapshots, authorization, hash/size failures, client hashing on LAN HTTP, CLI/service configuration, profile selection, extension preservation, save namespaces and profile-change races. Browser tests execute generated WASM and a declared data package through the actual player, prove parent/storage/network isolation and cancel stalled startup. Existing player/library flows also pass.

Those generated fixtures establish the framework, not rendering, audio, controls or save compatibility of a new emulator. The pinned FCEUmm plugin passed [real NES acceptance through this isolated launcher](browser-playback-plugin-acceptance.md), including rendering, keyboard input, nonzero audio and battery/state restoration. Validate every installed console build with lawful test content, keyboard/gamepad/audio, startup failure and any claimed save round trips. Keep emulator, ROM, BIOS and save binaries outside this repository.

See [legacy browser build instructions](browser-playback.md) and [plugin operations](plugins.md).
