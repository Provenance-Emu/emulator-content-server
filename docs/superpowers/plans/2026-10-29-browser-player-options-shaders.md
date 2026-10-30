# Browser player options and shaders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Live core settings and optional remembered overrides plus lightweight GLSL presets in our existing player.

**Architecture:** One host command owner handles saves and typed settings requests; the opaque guest accepts bounded commands and built-in shader IDs only. Host-only local preferences generate a bounded startup core-options file. Svelte settings controls share the existing player action lock.

**Tech Stack:** TypeScript, Svelte 5, Emscripten MEMFS, GLSL ES, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-browser-player-options-shaders-design.md` (approved 2026-10-29).

## Global Constraints

- Keep our Svelte UI, authenticated client and opaque Emscripten sandbox.
- Off/session-only defaults; no new dependency or API/schema change.
- Preserve command acknowledgement and upload retry/conflict semantics.
- Existing branch/worktree; preserve concurrent disc-media edits; no new commit/push authorized.
- Safari Mac/iPhone baseline; distinguish WebKit profiles from physical-device acceptance.

## Review Focus

- Settings query errors cannot consume a later anonymous save acknowledgement (task 1).
- A game override cannot leak to another source/build or mutate core defaults (task 2).
- Deferred shader failure cannot display an old selection as newly applied (task 3).
- Scrolling settings offscreen cannot stall draw-dependent changes/captures (task 4).
- Controls cannot discard pending uploads or auto-restart unsaved gameplay (task 4).

### Task 1: Typed option queries on the shared owner

**Files:** `commands.ts`, new `options.ts`, `sandbox.ts`, `sandbox.html`; tests `player-commands.test.ts`, new `player-options.test.ts`.

**Interfaces:** `CoreOption {key,value,description,values?}`, `CommandChannel.listOptions(): Promise<CoreOption[]>`, `option(key): Promise<CoreOption>`, `setOption(key,value): Promise<CoreOption>`. Finite 60,000-character replies, 512 options, 128-character keys, 512-character values, 256 values per option.

- [x] Add failing tests for option parsing, duplicate/oversized/injected data, wrong keys/current values, queue ordering with a save, explicit unsupported response and timeout quarantine.
- [x] Run affected tests and observe expected failures.
- [x] Implement typed validation and one generic serialized exchange beneath existing save grammar. Extend the guest allowlist and bounded reply handling; expose actual helper capability through a narrow RPC.
- [x] Run tests; preserve existing save command tests.

### Task 2: Local preference scopes and startup staging

**Files:** new `preferences.ts`, `controller.ts`, tests new `player-preferences.test.ts`, `player-start.test.ts`.

**Interfaces:** `PlayerPreferences {options: Record<string,string>, shader: ShaderId}`, build+game scoped store with load/remember/clear operations, `coreOptionsConfig(options): string`; optional `StartOptions.preferences`. Configuration path `/ecs/core-options.cfg`.

- [x] Add failing tests for core/game precedence, corrupt/private storage, hash/source isolation, config injection and actual startup file/args.
- [x] Implement bounded (128 KiB) local preferences, no token/account claim, config serialization; create shared channel for option-capable runtimes independently of synchronized-save support.
- [x] Run affected tests including existing startup cases.

### Task 3: Fixed shader capabilities and selection

**Files:** new `shaders.ts`, `runtime.ts`, `sandbox.ts`, `sandbox.html`; new browser `player-settings.spec.ts`.

**Interfaces:** `ShaderId = 'off'|'scanlines'|'lcd'`, runtime `settingsInfo()` and `setShader(id)` returning applied/requested status; no arbitrary path/native calls. Trusted shader bundle staged to `/ecs/shaders`; bounded guest frame wait and error observation.

- [x] Add failing browser cases for unsupported exports, invalid ID, switch/off, allocation cleanup and failed apply recovery.
- [x] Implement original single-pass shaders, bounded guest selection/failure recovery and host result validation. Use fixed shader source packaging; free allocated native strings in finally.
- [x] Run focused browser cases.

### Task 4: Controls and real-core acceptance

**Files:** new `SettingsControls.svelte`, `Player.svelte`, `player.css`, browser tests, operations docs.

**Interfaces:** controls consume session `commands`, runtime and preference store, and existing `disabled/onbusy` props. Runtime options probe begins after startup; session-only edits, explicit remember/clear actions.

- [x] Add failing UI/real-core cases for searchable select changes, remembered launch, failure/no stale state, scroll/focus, pending-upload lock and missing capabilities.
- [x] Implement controls with refresh, scope labels and restart guidance. Keep option drafts distinct from acknowledged values and shader requests distinct from verified frames.
- [x] Run web check/build and desktop+iPhone WebKit plus proportionate Chromium real-core acceptance: changed palette pixels, shader on/switch/off pixels, screenshot and state round-trip.
- [x] One focused bridge/order review, fix material findings with regressions, record results and remaining physical-device gaps. Do not commit/push this batch.

## Completion evidence — 2026-10-29

- Web check: 280 tests passed, no Svelte errors or warnings.
- Focused Playwright: 21/21 Chromium, desktop WebKit and iPhone-profile WebKit cases passed. Real FCEUmm covered palette changes, shader on/switch/off pixels, shader capture, state save/load after shader changes, non-default remembered startup/clear, and pending upload lock/retry.
- Four review findings reproduced and fixed: >4 KiB replies through the real guest bridge; inherited preference scope contamination; focus failure preserving applied selection; deferred shader errors and remembered-preset cleanup. No deferred review findings.
- Web build passed. Affected-file Biome check passed with five non-null-assertion warnings in production/tests; no errors. Diff whitespace check passed.
- Physical Safari/iPhone and sustained hardware performance remain unverified. Shader native API still reports accepted requests, not a final compiler acknowledgement; later reported errors are monitored and recovered.
- Existing main checkout retained; new batch remains uncommitted and unpushed. Legacy command probes require necessary JS/WASM markers, then validated actual replies; unusually obfuscated builds can conservatively show options unavailable.
