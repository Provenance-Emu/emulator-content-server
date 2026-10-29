# Browser player capture implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation. Steps use checkbox syntax for tracking.

**Goal:** Add reliable screenshots/state previews, browseable snapshots and responsive display controls to our player.

**Architecture:** Keep the opaque MessagePort sandbox and existing command-reply save owner. Add bounded capture/display operations, client-owned versioned snapshot paths and existing asset uploads, then Svelte controls.

**Tech stack:** TypeScript, Svelte 5, Emscripten MEMFS, browser canvas, Playwright.

**Spec:** ../specs/2026-10-28-browser-player-capture-design.md (approved by “continue” on 2026-10-29).

## Global constraints

- Existing branch/worktree; no commits/pushes without authorization.
- No schema/OpenAPI/dependency changes. Preserve opaque sandbox, CSP, credentials and save acknowledgements.
- Safari-first stable APIs; distinguish WebKit emulation from physical iPhone acceptance.
- Never refresh the gameplay baseline from a polled manifest. Retry retained bodies/keys/bases.
- Keep core/content/save binaries and credentials outside the repository.

## Review focus

- A previous or partially written PNG must not become the next state preview.
- A successful state must survive a preview failure, including definitive stale-revision 409.
- Refreshed state lists and in-session loads must not silently rebase future writes.
- Wrong-build snapshots and malicious/oversized images must fail before staging/rendering.
- Resizing and hidden/background frames must not produce blank captures or an unbounded pending operation.

## Task 1: Capture validation and sandbox operations

Files: create `apps/web/src/player/images.ts`, test `apps/web/test/player-images.test.ts`; modify runtime/sandbox types and `apps/web/public/play/sandbox.html`; extend sandbox browser tests.

Interfaces: PNG validator with encoded/dimension limits; optional runtime `captureScreenshot`, `prepareStatePreview`, `captureStatePreview`, `displayInfo`, `setDisplay`. Bounded typed display settings.

- [x] Write failing PNG boundary tests and browser regression for after-draw capture, stale preview removal and display changes.
- [x] Implement preserved WebGL drawing buffers, post-main-loop capture, fresh/stable preview reads and narrow validated RPC operations. Limits: screenshot 8 MiB, preview 2 MiB, image dimensions <=8192 and area <=16,777,216; 5-second capture and 3-second preview deadline.
- [x] Run affected unit and sandbox browser tests; preserve existing isolation checks.

## Task 2: Snapshot identity and recovery

Files: create `apps/web/src/player/states.ts` and tests; modify `saves.ts`, `controller.ts`, `preflight.ts` and save/start tests.

Interfaces: snapshot path/compatibility/pairing helpers; synchronizer snapshot capture with optional preview, `loadState` for a validated manifest member, pending-preview export/dismiss/retry and screenshot upload. Keep battery and legacy API behavior where not deliberately changed.

- [x] Write failing regressions for unique state paths, build mismatch rejection, fresh preview capture, failed preview without lost state, unchanged retry identity and conflict-path pairing.
- [x] Implement state-first/preview-second uploads, terminal-409 recovery and in-session loading. Preserve original baseline semantics.
- [x] Run player unit tests.

## Task 3: Player UI and responsive display

Files: create state-browser and display-controls Svelte components; modify Player/SaveControls/player CSS; add browser tests with generated fixtures.

Interfaces: refresh callback after uploads, browser selection/load callback, transient screenshot download and optional library upload; fit/fill/aspect/filter settings applied to the actual frame/canvas.

- [x] Write failing browser checks for browse/load, recovery controls and display settings.
- [x] Implement accessible touch-friendly gallery with bounded preview batches, legacy compatibility confirmation, current-build checks and data-URL previews. Add capture/download actions and display settings; no assumed native geometry.
- [x] Run Svelte check, web unit tests and web build.

## Task 4: Real-core acceptance and focused review

Files: extend real-core acceptance test and operations documentation.

- [x] Verify changing nonblank screenshots, native state thumbnails, authenticated snapshot/preview uploads, in-session state restore and resize behavior with generated NES content.
- [x] Run focused Chromium/WebKit and iPhone-profile WebKit checks; note hardware/Safari gaps.
- [x] One focused fresh review of sandbox/capture/save changes; fix material findings with regression tests. No review matrix.
- [x] Record checks and limitations; leave changes uncommitted for review.

## Execution ledger

- Setup: user approved design by “continue”; execute inline without another approval gate. Existing-branch policy overrides optional worktree setup. No source changes existed at start.

## Completion evidence

- 2026-10-29: `pnpm --filter @ecs/web check` passed: Svelte 0 errors/warnings and 253 unit tests.
- `pnpm ui` passed. Focused affected-file Biome check passed with test-style warnings (non-null assertions/template suggestions); no errors.
- Chromium: 5 original focused browser cases, the real FCEUmm capture/state/display test, the partial-preview writer regression and both review regressions passed.
- WebKit desktop and iPhone 13 profile: 12 original focused cases including real FCEUmm passed; 6 additional partial-preview/review regression cases passed.
- One focused reviewer found two P2 capture issues; both reproduced RED and fixed GREEN. No deferred reviewer findings.
- The review WebKit rerun initially lacked the custom executable path and failed browser launch; corrected with ECS_WEBKIT_EXECUTABLE and all 6 targeted WebKit cases passed.
- Physical iPhone and installed Safari were not driven. Integer scaling remains explicitly unavailable without native geometry.
- No commit or push; unrelated concurrent server/database/docs changes were left alone.
