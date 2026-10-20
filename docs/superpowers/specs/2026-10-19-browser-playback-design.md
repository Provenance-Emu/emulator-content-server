# Browser playback: minimal implementable design

## Binding implementation profile

The selected profile is **command-reply-v1**, using the exact pinned frontend/FCEUmm sources described at the end of this document. The legacy MEMFS observer discussed below is an investigated alternative, not an enabled fallback. Initial supported content is single-file NES with explicitly compatible single-file SRAM and slot-0 RetroArch states.

The implementation plan fixes the remaining alternatives: public metadata is the additive `GET /api/v1/player/core` contract and optional `features.webPlayback`; protected loader/WASM bytes remain fixed allowlisted `/play/cores` resources. Configuration requires actual artifact hashes and retains validated immutable byte snapshots at startup (loader at most 8 MiB, WASM at most 64 MiB, game at most 64 MiB). The server performs hash verification, so LAN HTTP playback does not depend on browser WebCrypto availability. Only `/play` receives the described additional browser policy.

Save synchronization retains the loaded base revision. A successful non-conflict write may conservatively increment that local baseline by one; a conflict never advances it. Fetching a new manifest is not permission to use another device's revision as the gameplay baseline. Command timeout quarantines the channel; a fresh document is required before further runtime commands. Pending captured upload bytes remain retryable/exportable. Source play requires explicit item selection for saves and never infers identity from names. Stop disposes the browser document rather than promising an unverified generic in-document runtime exit API.

Design based on read-only investigation, 2026-10-19. No player downloads or execution of operator code. `/opt/libretro/emscripten/retroarch` is absent on this host. Findings distinguish verified upstream APIs from browser integration that still needs real-core acceptance.

## Decision

Ship a separate `/play/` application entry in `apps/web`, backed by the existing content API, with one explicitly configured, trusted, single-thread RetroArch Emscripten ES-module loader/WASM pair. The content server serves allowlisted bytes; only the browser imports JavaScript and instantiates WASM. Do not load `plugin.json`, import `@ecs/plugins` into server/web, serve a plugin directory, or evaluate operator code in Node.

Add a focused ADR: ADR 0007 still governs executable plugins and their secret-bearing directories; a separately configured directory containing only browser-static core files is an explicit browser playback exception. The older `docs/workstreams/web-playback.md` says `/ui` and a core under the data directory, whereas current plugin operations/ADR 0007 say the server never mounts player plugins. Update the brief and operations wording together so neither silently contradicts the actual behavior. `/ui` keeps its exact existing CSP; `/play` owns the additional permissions.

## Static distribution and endpoints

Add an optional `--player-dir`/server `playerDir` setting, independent of dataDir and plugins. Absent configuration means playback is unavailable with an actionable explanation. This is not an invitation to publish a filesystem root. One manifest allowlists one loader/WASM pair; arbitrary relative file lookup, directory listing, HTML supplied by operators, redirects, external URLs, and access to `secrets.json` are refused.

The operator descriptor is `core.json`, version 1, with a safe core ID/name, `systems: ['com.provenance.nes']`, `runtime: 'retroarch-emscripten-esm'`, `threaded: false`, `filesystem: 'memfs'`, and `saveCompletion: 'command-reply-v1'`. The loader and WASM fields are safe filenames for the FCEUmm pair. Require exact frontend/core commits from the build profile below, the actual 64-hex SHA-256 digest of each artifact, extension `nes`, and a finite positive maximum content size no greater than 64 MiB. Validate regular-file containment including symlinks, enforce loader/WASM caps, and retain immutable validated buffers. Digests must be computed from operator-built artifacts, never fabricated in a sample. Never trust filenames supplied by query parameters.

* `GET /play` redirects to `/play/`.
* `GET /play/` and its first-party JS/CSS shell are public static resources, like `/ui/`; an unauthenticated navigation cannot attach a bearer header. Shell asks the API for access before fetching a core or game.
* `GET /api/v1/player/core` returns the public descriptor with resource URLs, no disk paths; requires an admitted actor with read capability.
* `GET /play/cores/:coreId/loader.js` and `GET /play/cores/:coreId/core.wasm` require the same actor/read gate, serve only manifest allowlisted files, and set correct JS/WASM MIME types plus `nosniff`, `Cache-Control: private, no-store`, and `Cross-Origin-Resource-Policy: same-origin`.
* Existing game bytes remain `GET|HEAD /api/v1/files/:assetId/content` or `/api/v1/sources/:sourceId/content`; no new filesystem-content route.

Use the existing actor/local-trust rules, including public mode disabling local trust and ignoring forwarded peer headers. A global core is not a reason to bypass read scope, and guest support must respect the existing guest actor rules. Never add query tokens or auth cookies.

The simplest Vite change is a second HTML entry (`play/index.html`) using the same build output and shared CSS/session helper. Point it at a first-party player bootstrap module. Serving that entry at `/play/` must resolve its built assets correctly; a multi-entry build under the current `/ui/` base can reuse immutable first-party `/ui/assets/*` files because policy belongs to the `/play/` document. Keep a clear distinction between those public first-party bundles and protected operator loader files.

## Protected loading and runtime initialization

Use `ContentClient` methods for source collection, protected core metadata, and core byte reads. `apps/web` may depend only on `@ecs/client`; use browser-local runtime interfaces and do not import server, storage, domain, or plugin packages. New client helpers can reuse the existing range/ETag/retry collector against a typed source id instead of accepting arbitrary URLs. The public descriptor updates OpenAPI and generated files normally; core bytes stay fixed protected resources.

On explicit Start:

1. Restore the same `ecs.session` bearer session used by `/ui`, call the API, and refuse to continue if unauthorized. Trusted LAN sessions work without a token by the existing policy.
2. Resolve the requested source or asset from API metadata. A source must currently report `availability === 'local'`, and its system must match the configured core. Refuse unknown, evicted, and offline states before loader import or runtime factory invocation. The content server re-probes sources and already returns source-evicted/source-offline before reading bytes, covering a race after listing.
3. Collect complete, bounded game bytes and selected save bytes before creating the runtime. Asset manifests currently have no availability field: a successful stored-blob content fetch is its preflight; location-offline/missing errors must stop initialization. Do not claim all manifest assets are known local merely because they exist in metadata.
4. Fetch loader text and WASM bytes with the normal Authorization header. Create a JS Blob URL, then `await import(/* @vite-ignore */ loaderBlobUrl)`. Pass the fetched WASM as `wasmBinary` to the imported default factory with `noInitialRun: true`, a focusable canvas, bounded log/error callbacks, and a `locateFile` that refuses unlisted secondary dependencies. Browser ES-module import itself cannot attach bearer headers; authenticated prefetch plus Blob import avoids that problem. Retain the Blob URL until runtime disposal, then revoke it.
5. Await the factory; validate `FS`, `callMain`, save exports, and the supported filesystem interface. Create session-only directories; write config, content, and compatible selected saves through `FS.mkdirTree`/`FS.writeFile`; call main once with `['-c', configPath, contentPath]`. The binary already includes its libretro core; do not pass an unrelated `.wasm` to RetroArch's `-L` option.

For v1 restrict to a self-contained ES-module JS/WASM pair, no worker, worklet, JSPI, WasmFS, OPFS, dynamic core-loading, or relative JS imports. Blob `import.meta.url` and bearer protection complicate those additional dependencies. Give a precise unsupported-build error instead of silently switching to unauthenticated fetches. Threaded builds can be a later explicitly declared manifest format with authenticated-prefetched workers and a verified `mainScriptUrlOrBlob` arrangement.

Verified primary sources: RetroArch [v1.21.0 Makefile](https://github.com/libretro/RetroArch/blob/v1.21.0/Makefile.emscripten) uses `MODULARIZE=1` and `EXPORT_ES6=1`, and exports `FS`, `callMain`, `_cmd_savefiles`, `_cmd_save_state`, `_cmd_load_state`, pause commands, and command send/receive. Its [own web frontend](https://github.com/libretro/RetroArch/blob/v1.21.0/pkg/emscripten/libretro/libretro.js) imports the default factory with noInitialRun before callMain. Setting only `window.Module` and injecting a classic script is therefore not a correct general implementation for these builds. Emscripten documents [Module initialization hooks and WASM customization](https://emscripten.org/docs/api_reference/module.html) and [filesystem operations](https://emscripten.org/docs/api_reference/Filesystem-API.html).

## Policy

On `/play/` document/static responses set `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`.

Suggested document CSP: `default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'none'`. Add permissions only when a verified selected build actually needs them. `wasm-unsafe-eval` allows WASM compilation without enabling JavaScript `eval`. Do not add `unsafe-eval` or `unsafe-inline` by default. Existing `/ui` headers and behavior must remain byte-for-byte equivalent in regression tests.

COOP/COEP does not by itself make a LAN HTTP origin secure; shared memory additionally needs a secure context. This v1 single-thread runtime does not require SharedArrayBuffer. Operator-provided JS executes with this origin's authority and can read same-origin session storage; the setup must explicitly require trusted core builds. CSP is not a sandbox against an intentionally malicious allowlisted core.

## Saves: concrete FS contract and concurrency

Use a per-session internal ROM basename such as `/ecs/content/game.nes` and exact fixed save paths `/ecs/saves/game.srm` and `/ecs/states/game.state`, independent of an uploaded display name. In generated config set savefile_directory, savestate_directory, system_directory; disable core/content sorting, saves-in-content-directory, automatic state indexing, and automatic config writes. Pin state slot 0. Avoid embedding catalog paths directly into configuration or command strings.

Load the current live battery save and the user-selected compatible state from the associated item manifest; never auto-pick a conflict copy. A selected catalog `.sav` can map into the core's internal `.srm` path only when that core's byte format is known compatible. Retain its original catalog relativePath for upload. Stage SRAM before main so the core loads it; state file staging alone does not restore the emulator. Restore a state through the completed `LOAD_STATE_SLOT 0` command after game startup/readiness. Show a Load state control and startup errors; do not claim restoration solely because bytes were written to MEMFS.

Explicit Save battery/Save state actions are sufficient; do not promise unload handlers can finish an authenticated resumable upload. Disable concurrent save commands. Track unsynced bytes, leave failed uploads retryable, and provide a local export if upload is forbidden. A read-only account can play but cannot upload; server authorization remains authoritative.

Important runtime issue: `_cmd_save_state()` is a void command enqueue, not a completed file write. The [v1.21.0 save task](https://github.com/libretro/RetroArch/blob/v1.21.0/tasks/task_save.c) writes over task ticks and closes the file at task completion; immediate `FS.readFile` can retrieve old or partial bytes. `FS.syncfs()` flushes a mounted backend and does not wait for RetroArch's save task. `FS.trackingDelegate` is not portable here: [FS_DEBUG defaults to 0](https://github.com/libretro/RetroArch/blob/master/Makefile.emscripten) and is incompatible with WasmFS.

The investigated MEMFS observer is rejected for this profile; it cannot prove runtime command completion.

The required adapter for the pinned runtime uses `EmscriptenSendCommand('SAVE_STATE_SLOT 0')` and polls `EmscriptenReceiveCommandReply()` until the matching success/error reply, then reads the state. At investigated RetroArch commit `4d4bfc0fbaacca30d433e5c11b0b2b5242141b66`, [command.c](https://github.com/libretro/RetroArch/blob/4d4bfc0fbaacca30d433e5c11b0b2b5242141b66/command.c) defers `SAVE_STATE_SLOT`/`LOAD_STATE_SLOT` replies until tasks finish; success includes command and slot, errors include `ERROR`. `SAVE_FILES` acknowledges synchronous save dispatch with `OK`. These completion commands are absent from v1.21.0; presence of the send/receive exports does not prove command support. Do not require a current-nightly command ABI while advertising all old libretro JS/WASM pairs as supported.

Upload the resulting copied bytes using existing `ContentClient.upload`, `kind: battery_save|save_state`, the associated item/library, the existing save's original relativePath (or a stable new path), and the item's revision captured when those base saves were loaded. Do not fetch a fresh revision immediately before upload: it could overwrite another device's intervening save. A stale base revision invokes the server's existing keep-both behavior. Keep one stable idempotency key per logical save across retries. A successful upload should refresh the base manifest/revision for the next save, while retaining pending bytes until success. Show returned conflictOf/conflict path; never auto-adopt a conflict.

## Source/item association is a genuine model gap

Current SourceFile has libraryId and systemId but no itemId. Saves belong to catalog items. The browser cannot safely discover a source's saves by matching a title or basename. For source play, require an explicit existing destination item in the same library/system before loading or writing its saves, or create a catalog item on first Save and retain that association in the session. Sources without library/system identity need the explicit target selection. ContentClient already exposes createItem. A durable source-item link is a separate additive schema/API feature if required; avoid implementing it implicitly through title guesses. Item-asset play already has the correct identity and is the smallest complete saves path.

Save states are core/version/frontend-format dependent; battery saves can also differ in layout or have RTC/EEPROM companions. Do not claim cross-emulator interoperability. Store original bytes without conversion, label which core/version produced browser states, expose a compatible-save selector, and limit v1 to one supported single-file core/save format. Multi-disc playlists, archive extraction, BIOS-required systems, split SRAM/RTC files, and arbitrary device savestate formats require additional adapters and explicit tests.

## Required generated-fixture tests

1. Server injection with temp manifest/generated JS text/minimal valid WASM bytes: actor/read checks, token-mode remote access, no header/query secrets, no secret files or traversal/symlink escape, absent/mismatched files fail, JS/WASM MIME and policy, unchanged `/ui` CSP.
2. Client mocked fetch: source collection uses authenticated range/resume and If-Range behavior; protected core fetch includes Authorization and refuses redirects; no token appears in URL/errors. Generated malformed/oversized bytes fail cleanly.
3. Browser controller with injected runtime importer/factory: local generated content is staged before callMain; offline/evicted/unknown or failed source fetch never imports or invokes core; wrong systems and unsupported ABI refuse initialization. Existing battery bytes stage before main; state load invokes restore after startup.
4. Generated fake MEMFS/core: save command queues delayed writes; stale file exists first; test confirms no upload until the new successful target close, no upload for unrelated/read-only close, no upload on errors/timeouts, and exact copied bytes uploaded after completion. Include delayed multi-chunk state, write failure, double-click serialization, and failed upload retry with same logical key.
5. API integration with generated save bytes: another device changes the item during play; browser uploads using original base revision; both byte sets remain and the changes feed/manifest exposes the new asset. Do not fake keep-both only inside a frontend mock.
6. Source play explicitly maps to an item and never silently binds to a similarly titled item. Read-only playback remains possible while save upload yields the existing authorization problem.

Generated fake runtime/WASM verifies wiring, authorization, containment, and concurrency, not successful emulation or real save restoration. Manual acceptance later must run the specifically documented operator core pair with a lawful test program, verify rendering/audio/input, actual SRAM/state roundtrip, and bearer-only reverse-proxy access. This research provides no claim that a real core or binary was executed.

## Follow-up: command-reply-v1 is the supported 1.0 default

Require `saveCompletion: command-reply-v1` for the shipped profile. Do not use a MEMFS method observer as a silent fallback: observing a close cannot prove RetroArch accepted a state, handled all companions, or completed an atomic replacement. Reject unsupported runtime profiles before starting a writable playback session. v1.21.0 does not satisfy this profile even though it exports send/receive helpers; show the documented setup requirement instead of claiming it can synchronize browser saves.

### Exact JavaScript binding

At pinned RetroArch frontend commit `4d4bfc0fbaacca30d433e5c11b0b2b5242141b66`, the public module surface is:

```ts
interface CommandReplyRuntime {
  EmscriptenSendCommand(command: string): void;
  EmscriptenReceiveCommandReply(): string | undefined;
}

runtime.EmscriptenSendCommand('SAVE_STATE_SLOT 0');
// Later, from a bounded timer while the emulator main loop continues:
const reply = runtime.EmscriptenReceiveCommandReply();
```

These are JavaScript library/runtime methods, not C functions taking numeric pointers. Call those exact property names directly, without a leading underscore, `ccall`, `cwrap`, `_malloc`, `stringToNewUTF8`, or `UTF8ToString`. The helper queues a JavaScript string, raises the native command flag, and the platform glue performs its internal UTF-8 conversion. Receive shifts one JavaScript string from the reply queue; an empty queue returns `undefined`, not a WASM address. The upstream web frontend itself uses this direct-call form. Send one fixed command per call, without embedding user paths or multiple newline-separated commands. The native command parser accepts a complete queued command without a trailing newline; a trailing newline is allowed but unnecessary.

The pinned [Makefile export declarations](https://github.com/libretro/RetroArch/blob/4d4bfc0fbaacca30d433e5c11b0b2b5242141b66/Makefile.emscripten#L144) include `callMain`, `FS`, `PATH`, `ERRNO_CODES`, `ENV`, `stringToNewUTF8`, `UTF8ToString`, `Browser`, `EmscriptenSendCommand`, and `EmscriptenReceiveCommandReply` as runtime methods. They do **not** include `ccall` or `cwrap`. Native `_main`, `_malloc`, `_free`, and `_cmd_*` exports also exist, but the void `_cmd_save_state()` shortcut lacks the required completion contract. The implementation must not invent `_EmscriptenSendCommand` or assume missing convenience helpers are exported.

Binding evidence: [JS helper definitions](https://github.com/libretro/RetroArch/blob/4d4bfc0fbaacca30d433e5c11b0b2b5242141b66/emscripten/library_platform_emscripten.js#L223), [native platform conversion and reply queue](https://github.com/libretro/RetroArch/blob/4d4bfc0fbaacca30d433e5c11b0b2b5242141b66/frontend/drivers/platform_emscripten.c#L380), and [upstream direct JavaScript calls](https://github.com/libretro/RetroArch/blob/4d4bfc0fbaacca30d433e5c11b0b2b5242141b66/pkg/emscripten/libretro-thread/libretro.js#L176). These verify source ABI, not a downloaded nightly binary's identity.

### Reply grammar and completion

Use one outstanding command globally for this runtime. There are no request IDs; in particular, the battery success reply does not name its command. Drain startup replies before the first request, route all command access through one controller, and reject unexpected replies rather than treating arbitrary nonempty strings as success. Receive returns a whole queued reply, not a network stream needing line buffering. Remove trailing CR/LF only; do not split an error message into invented protocol fields.

| Request sent | Successful reply after removing trailing CR/LF | Failure reply |
| --- | --- | --- |
| `SAVE_FILES` | `OK` (raw reply is exactly `OK\n`) | `SAVE_FILES ERROR ` followed by diagnostic text |
| `SAVE_STATE_SLOT 0` | Exactly `SAVE_STATE_SLOT 0` | `SAVE_STATE_SLOT ERROR ` followed by diagnostic text |
| `LOAD_STATE_SLOT 0` | Exactly `LOAD_STATE_SLOT 0`, or `LOAD_STATE_SLOT 0, queue ended` | `LOAD_STATE_SLOT ERROR ` followed by diagnostic text |

State success replies contain no newline in the native code. The optional load suffix is appended when a queued step sequence ended; a controller that never runs STEPS should not normally encounter it, but it is a real permitted source behavior. Match command and requested slot; a slot 1 response cannot satisfy a slot 0 operation. Error diagnostics are human text, sometimes localized, and must not be matched for semantics beyond the fixed command/error prefix. Typical immediate errors cover invalid slots, unavailable state support, and allocation failure; deferred errors report actual load/save task failure.

`SAVE_FILES` calls `event_save_files()` synchronously and returns `OK\n` only when it returns true. That function aggregates the individual SRAM writes; current SRAM code can skip an unchanged save or atomically replace a changed one. Thus an unchanged save legitimately acknowledges success without opening/closing a new file. On success, copy the expected save file bytes and upload; a missing/oversized expected file is a failure even after `OK`. The fixed error wording can say nothing is loaded/no save files even when an individual I/O error caused failure; do not turn it into an unsupported-core diagnosis automatically.

`SAVE_STATE_SLOT` and `LOAD_STATE_SLOT` dispatch work outside the core's input-poll stack and reply through the completion callback. In the pinned state writer the final callback follows close/error handling and atomic replacement, so reading the final path after matching success avoids partial or previous-file upload. An error or timeout must never result in reading/uploading the old file. Main-loop progress must continue while waiting; never busy-wait synchronously. After timeout the operation's eventual response is ambiguous with a retry, so quarantine command/save synchronization for that session and require a fresh runtime rather than allowing an old reply to satisfy a later identical command. Keep already captured unsynced upload bytes available independently.

Grammar/completion evidence: [command error formatting](https://github.com/libretro/RetroArch/blob/4d4bfc0fbaacca30d433e5c11b0b2b5242141b66/command.c#L95), [deferred reply formatting](https://github.com/libretro/RetroArch/blob/4d4bfc0fbaacca30d433e5c11b0b2b5242141b66/command.c#L987), [slot operation dispatch](https://github.com/libretro/RetroArch/blob/4d4bfc0fbaacca30d433e5c11b0b2b5242141b66/command.c#L1520), [battery command acknowledgement](https://github.com/libretro/RetroArch/blob/4d4bfc0fbaacca30d433e5c11b0b2b5242141b66/command.c#L1861), [SRAM write aggregation](https://github.com/libretro/RetroArch/blob/4d4bfc0fbaacca30d433e5c11b0b2b5242141b66/save.c#L608), and [state writer completion](https://github.com/libretro/RetroArch/blob/4d4bfc0fbaacca30d433e5c11b0b2b5242141b66/tasks/task_save.c#L437).

### Concrete reproducible support restriction

The initial supported build recipe should pin the RetroArch frontend to `4d4bfc0fbaacca30d433e5c11b0b2b5242141b66` and FCEUmm core to `ac0d00a7fc01166f84c7bac01d1084ebfd2b865e`, using Emscripten SDK `3.1.46` as the upstream documented single-thread baseline. These are investigated source pins and a proposed build recipe, **not a claim that this exact toolchain/core pair has already compiled or passed acceptance**. If that toolchain cannot compile the pinned frontend, resolve it in the acceptance/build environment and publish the exact successful SDK version before labeling the profile verified. Do not fabricate hashes for artifacts not built here.

Follow upstream core-build/static-link procedure: build FCEUmm with `emmake make -f Makefile.libretro platform=emscripten`; copy its `fceumm_libretro_emscripten.bc` to the pinned frontend's `libretro_emscripten.bc`; link with `emmake make -f Makefile.emscripten LIBRETRO=fceumm HAVE_THREADS=0 PROXY_TO_PTHREAD=0 HAVE_WASMFS=0 HAVE_EXTRA_WASMFS=0 HAVE_AUDIOWORKLET=0 JSPI=0 FS_DEBUG=0`. The frontend Makefile enables HAVE_COMMAND and supplies the required exports. The output pair is `fceumm_libretro.js` and `fceumm_libretro.wasm`; record both actual SHA-256 hashes, frontend commit, core commit, SDK version, `threaded: false`, `filesystem: memfs`, and `saveCompletion: command-reply-v1` in the operator descriptor. Serve only that pair. A version string alone cannot prove the command ABI or linked core identity.

Limit first acceptance to a lawful single-file NES program requiring no external BIOS and using ordinary single-file SRAM; then test state save/load with this exact pair. Declare broader systems/buildbot downloads unsupported unless their pair is separately pinned and accepted. No core or copyrighted test content is committed. Runtime startup verifies the direct methods exist; missing commands, missing reply, invalid state, and write failure fail closed. Optional command introspection may supplement the artifact pin but cannot replace verifying actual state completion.

Recipe evidence: [pinned upstream single-thread build instructions](https://github.com/libretro/RetroArch/blob/4d4bfc0fbaacca30d433e5c11b0b2b5242141b66/pkg/emscripten/README.md#L6) and [pinned FCEUmm Emscripten target](https://github.com/libretro/libretro-fceumm/blob/ac0d00a7fc01166f84c7bac01d1084ebfd2b865e/Makefile.libretro#L427).

Replace/add controller fixture tests for command-reply-v1: direct JS string arguments/no ccall; empty receive is undefined; delayed exact state acknowledgement gates file reads and upload; wrong command/slot and arbitrary text do not acknowledge; error/timeout never uploads old bytes; success on unchanged SRAM works without close events; load suffix accepted; all requests serialize; timeout prevents reuse of a late reply; missing helpers/profile mismatch refuses startup. Keep a real API stale-revision/keep-both test for the bytes captured after acknowledged completion.
