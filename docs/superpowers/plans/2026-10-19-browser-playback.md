# Browser Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Use focused TDD, independent task reviews, and a final whole-branch review.

**Goal:** Play a local asset or scanned source through one trusted operator-provided single-thread core, load explicitly compatible saves, and upload completed browser saves through the existing keep-both API.

**Architecture:** A separate `/play/` document fetches protected core/content bytes through `@ecs/client`. The browser imports the ES-module loader with pre-fetched WASM; the server serves an immutable allowlisted core pair and never executes it. A pinned command-reply runtime profile gates save reads on completed commands.

**Tech Stack:** Svelte 5, Vite multi-entry build, TypeScript client, Fastify, operator-provided RetroArch/FCEUmm Emscripten ES-module JS/WASM.

**Spec:** `docs/superpowers/specs/2026-10-19-browser-playback-design.md`, including its final command-reply-v1 support restriction. The selected profile supersedes the exploratory legacy FS-observer alternative.

## Global Constraints

- `/ui` CSP stays unchanged. `/play` alone receives COOP/COEP, same-origin CORP, no-referrer, nosniff, and the specified self/blob/WASM CSP; no JavaScript unsafe-eval or unsafe-inline.
- Web/tray remain API clients depending only on `@ecs/client`; do not import server, filesystem, catalog, domain, storage, or plugins into browser code.
- No plugin directory, `plugin.json`, server-side JS execution, hotlinked core, downloaded nightly bundle, ROM/core fixture, or token in URLs/logs.
- Use one explicit configured core pair, immutable server snapshots, manifest hashes, supported single-thread MEMFS ES-module runtime, and command-reply-v1. Do not silently fall back to old asynchronous save exports or FS observation.
- The first supported profile is FCEUmm/NES with the pinned frontend/core commits in the spec, single-file SRAM and slot 0 states. Unsupported builds, dependencies, formats, and systems fail clearly.
- Refuse offline/evicted/unknown sources before importing a loader; fetch all bounded game/save bytes before starting a core. Stored assets need a successful content fetch, not invented availability metadata.
- Keep the loaded revision as the save baseline. Never advance it from an unrelated fresh manifest or automatically adopt a conflict.
- Required automated checks precede merge commits; manual emulation/native client acceptance is explicitly outstanding. Leave local main/primary checkout untouched; no release publication.

## Review Focus

- A core loader must receive Authorization through authenticated fetch, not script URLs or a cross-origin redirect.
- A delayed or failed save command must never upload an old or partial file; a timed-out command channel cannot be reused for an ambiguous retry.
- A phone write during play must remain retrievable after repeated browser saves; acknowledged conflicts do not become the browser's loaded baseline.
- A scanned source has no item identity: saves require explicit same-library/system target selection, never a guessed title match.
- Source availability, actor scope/ACLs, immutable core containment, and `/ui` CSP remain enforced in public/token and trusted-local modes.

### Task 1: Protected core distribution and client contract

**Files:** new `apps/server/src/player-assets.ts` and tests; server app/context/static-route wiring; CLI serve/service options and tests; `packages/protocol/openapi/openapi.yaml`, capability helpers, generated TS/Swift models and surface; `packages/client-ts/src/client.ts` and tests.

**Interfaces:**
- `OpenServerOptions.playerDir?: string`; CLI `--player-dir <absolute-path>` / `ECS_PLAYER_DIR`, optional service registration round-trip. Default playback disabled with no filesystem probe.
- Directory contains `core.json` plus exactly one allowlisted loader and WASM pair. Descriptor version 1, safe `id`, name, `systems: ['com.provenance.nes']`, runtime `retroarch-emscripten-esm`, `threaded: false`, `filesystem: memfs`, `saveCompletion: command-reply-v1`, pinned frontend/core commits, actual 64-hex loader/WASM SHA-256, safe content extension `nes`, and finite content cap at most 64 MiB.
- Loader cap 8 MiB, WASM cap 64 MiB; read contained regular files, validate digests, and retain immutable buffers at configured startup. A missing/invalid configuration fails clearly. No arbitrary file route.
- Add optional `features.webPlayback` and `GET /api/v1/player/core` returning a public generated `PlayerCoreDescriptor` without disk paths. Disabled metadata returns 404; configured metadata and bytes require an actor with read permission.
- Protected fixed routes `/play/cores/:coreId/loader.js` and `/play/cores/:coreId/core.wasm`; correct MIME, no-store, nosniff, same-origin CORP, immutable hash ETag. Core ID must match configured ID exactly.
- `ContentClient.playerCore()`, `playerCoreAssets(id)` and `collectSource(sourceId, options)` use authenticated typed fixed paths. Core asset fetch forbids redirects; extend existing `CollectOptions` with optional `maxBytes` while preserving asset resume/If-Range behavior.

- [ ] Write failing server/client tests for disabled/configured/invalid manifest, scope/token/public/local rules, core bytes/digests and immutable snapshots, traversal/symlink/secret refusal, no query credentials, redirects, source resume/weak-validator restart and byte caps. Observe intended RED.
- [ ] Implement the minimal pure descriptor/capability contract and server snapshot; add guarded fixed routes. Keep existing UI/static and API admission rules. Persist only non-secret configuration through service installation.
- [ ] Regenerate clients, intentionally update the surface, run focused tests and drift/boundaries. Existing v1 fields remain optional/additive; commit and report exact RED/GREEN evidence.

### Task 2: Isolated player, completed saves, and operator guidance

**Files:** `apps/web/play/index.html`, new player bootstrap/components/controller modules under `apps/web/src/player`; shared session/UI play links; Vite multi-entry config; server `/play` shell policy; generated-runtime and real-API tests; focused browser-static ADR and operator/workstream docs.

**Interfaces:** Player selection is `{ kind: 'asset'; itemId; assetId }` or `{ kind: 'source'; sourceId; itemId?: string }`. A source's target is explicitly selected and validated against known library/system before loading/writing its saves. No new durable source-item association is inferred.

- [ ] Write failing controller tests with generated content/WASM and injected importer/factory: local bytes staged before callMain; failed/offline/evicted/unknown/wrong-system inputs never import/invoke a core; selected compatible saves stage into fixed `/ecs` paths; explicit source identity; system/ABI/size failures.
- [ ] Add `/play` redirect/document with only its required security policy. Build a second first-party Vite HTML entry that reuses public `/ui/assets` bundles without changing `/ui` headers. Restore existing `ecs.session` bearer storage, fetch protected loader/WASM, import the loader Blob URL, pass `wasmBinary`, `noInitialRun`, `noExitRuntime` and canvas, then stage fixed config/content/save paths and call main once. Refuse unlisted worker/worklet/relative dependencies.
- [ ] Verify direct JavaScript helpers `EmscriptenSendCommand(string)` and `EmscriptenReceiveCommandReply(): string|undefined`. Serialize commands; drain startup replies; accept only exact SAVE_FILES `OK` (CR/LF trimmed), SAVE_STATE_SLOT 0, and LOAD_STATE_SLOT 0 (optional `, queue ended`). Reject wrong command/slot/text, errors and missing exports. Use asynchronous polling with a bounded 30-second command deadline; quarantine after timeout and require a fresh document/runtime before another command.
- [ ] Write delayed-save tests: old file exists, success arrives after multi-chunk replacement, no read/upload before matching success, errors/timeouts never upload old bytes, unchanged SRAM succeeds, operations serialize, late replies cannot satisfy retry. Stage state and invoke actual LOAD_STATE_SLOT after startup, not merely FS.writeFile.
- [ ] Use existing `ContentClient.upload` with a stable idempotency key/body/baseRevision per pending logical save. Retain bytes on failure, expose Retry/Export and conflicts, and block overlapping capture while pending. On non-conflict success advance the local baseline conservatively by exactly one; on conflict retain the loaded baseline. Do not refresh a newer device's manifest revision into the browser's baseline. A real API regression must show repeated browser saves after a phone write keep both histories retrievable.
- [ ] Add bounded UI: compatible Play links, canvas/focus, Start, battery/state Save, Load selected state, pending Retry/Export and visible conflict/error state. Stop navigates away from the document to dispose the runtime; do not claim generic native in-document shutdown/restart exists. Failed/partial runtime startup requires reload. No asynchronous unload upload promise.
- [ ] Document trusted-core setup, exact profile/build pins and operator-computed hashes, supported NES/save compatibility, source target selection, optional configuration, and no native emulation claim from generated fixtures. A focused ADR explains browser-static core assets without loading plugin manifests or directories.
- [ ] Run controller/client/server/API integration tests, `pnpm verify`, `pnpm ui`, Swift tests for generated models and `git diff --check`. Commit and report. Controller reviews tasks/full branch, opens/attaches PR, fixes CI/review findings, and merges with exact head guard. Actual rendering/audio/input/save roundtrip with the operator core remains manual acceptance.
