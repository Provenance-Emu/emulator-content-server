# Browser playback

Build the first-party interface with `pnpm ui`, then run the content server with `--player-dir /absolute/path/to/trusted-browser-core`. For multiple emulators, configure `--player-plugins /absolute/registry` instead or alongside it; see [player plugin installation](web-emulation-plugins.md). With neither configured, playback is disabled and the UI explains the setup requirement. `/play/` is a separate document; `/ui/` keeps its existing content policy. The player restores the same `ecs.session` bearer session used by `/ui/`. Sign in there, then follow Play from a supported file. Trusted LAN admission follows the existing server policy. For a reverse proxy use token mode and the documented public/TLS settings; never put tokens in URLs or proxy-generated peer headers.

The authenticated player host collects and verifies bytes, then runs core JavaScript inside an opaque-origin sandboxed frame. The core has no app storage, parent document or privileged API bridge. A private MessagePort carries bounded virtual filesystem and command operations. Artifact hashes pin bytes; they do not establish build compatibility. The server never evaluates core JavaScript. See the [isolation and limits](web-emulation-plugins.md#isolation-and-limits).

## Legacy pinned build profile

The following instructions describe the legacy `--player-dir` adapter. Plugin profiles declare their own supported systems, extensions and build versions; the framework does not imply those builds have passed console-specific acceptance.

The supported configuration is a single-thread, self-contained ES-module RetroArch/FCEUmm loader/WASM pair:

| Component | Required value |
| --- | --- |
| RetroArch upstream base | `4d4bfc0fbaacca30d433e5c11b0b2b5242141b66` |
| FCEUmm core | `ac0d00a7fc01166f84c7bac01d1084ebfd2b865e` |
| Emscripten SDK | `3.1.46` |
| Runtime / filesystem | `retroarch-emscripten-esm` / `memfs` |
| Threading / completion | `false` / `command-reply-v1` |
| System / extension | `com.provenance.nes` / `nes` |

The exact base/core pins compile with SDK 3.1.46. The supported build also requires the bundled [SAVE_FILES correction](../../scripts/browser-core/retroarch-save-files.patch), SHA-256 `ffc78048f23214a2aaccd84e7c8e443edfce06a194aa501818dcb11923738f21`. The unmodified frontend writes NES SRAM but then reports failure for FCEUmm’s absent RTC region. The correction skips absent regions while preserving failure when all regions are absent or any real write fails. The browser still requires the completed success reply and never uploads after an error.

`frontendCommit` identifies the upstream **base**, with that exact patch applied; it does not claim an unmodified upstream tree. Artifact hashes identify the resulting bytes. See the [local acceptance record](browser-playback-acceptance.md) for the actual tested pair and remaining limits. RetroArch v1.21.0 and nightly/buildbot pairs remain unsupported.

Clone the exact upstream frontend/core checkouts outside this repository, activate the official SDK 3.1.46, then use the bounded build helper:

```sh
# In external RetroArch and libretro-fceumm checkouts, respectively:
git -C /absolute/RetroArch checkout 4d4bfc0fbaacca30d433e5c11b0b2b5242141b66
git -C /absolute/libretro-fceumm checkout ac0d00a7fc01166f84c7bac01d1084ebfd2b865e
# In this repository, after sourcing the SDK's emsdk_env.sh:
node scripts/browser-core/build.mjs /absolute/RetroArch /absolute/libretro-fceumm /absolute/new-operator-core
```

The helper verifies SDK/source pins, patch digest and applicability, rejects unrelated tracked changes, clones committed sources into isolated temporary build directories, builds with two workers, and writes only the loader, WASM and descriptor into a new or empty external operator directory. It accepts a clean base checkout or the exact already-applied patch. It computes hashes from the finished artifacts rather than installing example digests. The [upstream procedure](https://github.com/libretro/RetroArch/blob/4d4bfc0fbaacca30d433e5c11b0b2b5242141b66/pkg/emscripten/README.md) is the basis for the helper’s explicit flags.

The build must provide `fceumm_libretro.js` and `fceumm_libretro.wasm`. The loader must have a default asynchronous ES-module factory and direct JavaScript methods `EmscriptenSendCommand(string)` and `EmscriptenReceiveCommandReply(): string | undefined`. Browser startup also requires `FS.mkdirTree`, `FS.writeFile`, `FS.readFile` and `callMain`. Relative/static/dynamic imports, workers/worklets and secondary dependency requests are refused. The pinned patched pair passed this loader check and actual browser execution in the acceptance record; another build still needs its own validation. Do not enable an unauthenticated fallback. No JSPI, WasmFS, OPFS, dynamic core loading or threading is supported.

## Operator directory and actual hashes

Use a new directory outside both the data directory and all plugin directories. It must contain **only** `core.json`, `fceumm_libretro.js` and `fceumm_libretro.wasm`, as regular files with no leaf symlinks. There is no directory browsing, operator HTML, plugin manifest loading, external URL or arbitrary file route. Loader size is at most 8 MiB; WASM and game size are each at most 64 MiB. Selected/captured saves are bounded at 64 MiB.

After building and copying your trusted pair there, compute the descriptor from its actual bytes; no sample digest can stand in for a built artifact:

```sh
ECS_BROWSER_CORE_DIR=/absolute/path/to/trusted-browser-core node --input-type=module <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const directory = process.env.ECS_BROWSER_CORE_DIR;
const artifact = async (file) => ({
  file,
  sha256: createHash('sha256').update(await readFile(join(directory, file))).digest('hex'),
});
await writeFile(join(directory, 'core.json'), JSON.stringify({
  version: 1, id: 'fceumm', name: 'Trusted FCEUmm',
  systems: ['com.provenance.nes'], runtime: 'retroarch-emscripten-esm',
  threaded: false, filesystem: 'memfs', saveCompletion: 'command-reply-v1',
  frontendCommit: '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66',
  coreCommit: 'ac0d00a7fc01166f84c7bac01d1084ebfd2b865e',
  emscriptenVersion: '3.1.46', contentExtension: 'nes',
  maxContentBytes: 64 * 1024 * 1024,
  loader: await artifact('fceumm_libretro.js'),
  wasm: await artifact('fceumm_libretro.wasm'),
}, null, 2));
JS
```

The server verifies hashes at startup and retains immutable byte snapshots. Restart it to install a new pair. The protected descriptor/core routes require API read admission; core responses are private/no-store. The public first-party `/play/` shell and `/ui/assets` bundles contain no operator code. The authenticated `/play/` host has COOP/COEP and frame permission, without Blob/WASM execution. Only the first-party `/play/sandbox.html` opaque frame permits its bootstrap, Blob module and WASM execution. Its CSP blocks network reads and workers. LAN HTTP is not made a secure context by these headers, and this single-thread profile does not use SharedArrayBuffer.

## Content, saves and controls

Use a lawful single-file NES program without BIOS requirements. Source availability must be `local`; offline, evicted, unknown, unsupported-system and failed-byte-fetch inputs never import the core. An asset manifest has no availability field: collecting its stored blob successfully is its preflight. Archive extraction, playlists, multi-disc content and BIOS-dependent systems are outside this profile.

Asset play already identifies the item. Source play offers an explicit existing item in that source’s known library and system, or playback without saves. A matching title/basename never creates an association; sources lacking known library/system cannot acquire a save target. There is no durable source-item relationship. Stop and reopen to choose another target.

Select only a battery save whose raw single-file format is known compatible with this FCEUmm build. `.sav` is mapped to the internal `.srm` path without conversion. Select states only from the exact compatible frontend/core pair, slot 0. The UI requires compatibility confirmation and labels conflict copies; none is automatically adopted. No arbitrary emulator-state interoperability is claimed. Browser-created state display names identify the pinned pair. Split SRAM/RTC/EEPROM companions require another adapter.

Start collects complete game and selected save bytes before transferring them to the isolated runtime. The frame imports the loader Blob and passes already fetched `wasmBinary` with `noInitialRun`/`noExitRuntime`. The session stages fixed `/ecs/content/game.nes`, `/ecs/saves/game.srm`, `/ecs/states/game.state` and generated config paths, independently of catalog filenames. SRAM is staged before main; a selected state also runs the completed `LOAD_STATE_SLOT 0` command after main.

Focus the canvas for keyboard input. Save battery and Save state send fixed direct commands and wait asynchronously for exact completed acknowledgements before reading expected MEMFS bytes. No file observer, native void `_cmd_*` shortcut or `FS.syncfs` substitutes for completion. A failed command never uploads old bytes. A 30-second timeout quarantines commands until a fresh document; unsupported replies fail closed too. Failed/partial startup requires reload. Stop navigates away to dispose the document; there is no promised generic in-document native shutdown/restart API.

Uploads use the item revision captured with the loaded saves. Successful non-conflict writes advance that local baseline by exactly one; conflicts leave it unchanged, even after another device updates the item. The player never refreshes a phone revision into this gameplay baseline or confuses an asset revision with an item revision. Keep-both copies stay visible in the library.

A failed upload retains copied bytes, one idempotency key and the original base revision. Retry sends that same logical save; Export downloads its retained bytes. Another capture is blocked while pending. A read-only reader can play, then receives the API’s authorization problem on upload and can export. Pending data is session-only and lost on navigation/reload; no unload upload is promised. Retry or export before Stop.

## Acceptance and operator validation

Generated tests exercise transport, API authorization, byte staging, minimal valid WASM instantiation in the opaque frame, storage/parent/network isolation, cancellation, delayed fake command completion, retry and real API keep-both. They do **not** execute a native NES core or establish rendering, audio, input, actual state restoration or cross-emulator save compatibility. The separate [2026-10-20 local acceptance](browser-playback-acceptance.md) executed the pinned patched pair with an original generated program before the isolated launcher was introduced; repeat it for this launcher. It does not establish cross-emulator compatibility.

Before calling a particular artifact pair verified, build the exact profile, record its actual hashes and successful SDK, then use a lawful NES test program to verify rendering/audio/input, real SRAM save/reload and slot-0 state save/load. Repeat through a bearer-only reverse proxy, including read-only export, phone/browser stale-save conflicts, failed startup and timed-out command recovery. No core binaries, ROMs, real saves or nightly downloads belong in this repository.
