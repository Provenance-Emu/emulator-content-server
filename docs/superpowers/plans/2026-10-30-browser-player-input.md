# Unified controller layouts and input editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution with one final focused review.

**Goal:** Controller/keyboard/mouse remapping and a playable touch editor, using one procedural/artwork-capable layout model ready for future Delta conversion.

**Architecture:** Pure TypeScript layout/validation and input-state modules; a first-party guest virtual-pad adapter, independent realtime input messages, and Svelte layout/editor controls. Existing save/settings RPC remains independent. Input preferences use distinct per-build/core/game scopes and sparse edited keys.

**Tech Stack:** TypeScript, Svelte 5, DOM/Pointer Events, existing Emscripten gamepad driver, Playwright WebKit.

**Spec:** `docs/superpowers/specs/2026-10-30-browser-player-input-design.md`, approved including unified skin-compatible geometry on 2026-10-30.

## Global Constraints

- Existing branch/worktree; preserve other agents' server/catalog/core edits. No commit/push requested for this new batch.
- Opaque sandbox/CSP unchanged. No native builds, dependencies, API/schema changes, ZIP import or emuskins transport.
- Procedural presets and future imported artwork share reference size, screen rectangles, control frames/hit geometry and logical actions.
- Release input independently of busy save/settings RPC; scope host/guest focus correctly. No automatic pause/restart.
- Safari Mac/iPhone baseline; report physical-device/hardware acceptance gaps.

## Review Focus

- A queued save, hidden page or stale host cannot leave an input held (tasks 1/2).
- One source's release cannot cancel another source and short taps cannot vanish before a core poll (task 1).
- Focus transitions to host touch controls must preserve touch ownership (tasks 2/3).
- Rotation, resize, hit padding and visual size must share a transform (tasks 1/3).
- Remembering a game change cannot capture unrelated inherited core mappings or connection indices (tasks 1/3).

### Task 1: Shared data model and engine

Files: new `layout.ts`, `input-model.ts`, `input-engine.ts`, `input-preferences.ts`; new corresponding web unit tests.

Interfaces: versioned `ControllerLayout` with portrait/landscape representations, reference size, screen frames, shape/image visuals and asset IDs; `MappingConfig`, `TouchPacket`, pure `createInputEngine()`. 4 ports, 16 digital actions, 4 axes, 16 touch sources, 32 controls, 128 KiB stored document, 750 ms heartbeat watchdog. No arbitrary URLs/HTML/commands in layout data.

- [x] Write and observe failing behavior tests for shared transform/insets/finite bounds, future asset round-trip, source OR/SOCD/axis arbitration, short taps, stale releases, map changes and sparse scoped preferences.
- [x] Implement strict model validation, procedural presets and shared geometry; state engine and bounded preference records.
- [x] Run focused unit tests.

### Task 2: Guest/native adapter and realtime bridge

Files: new `input-bridge.ts`, update `runtime.ts`, `sandbox.ts`, `sandbox.html`, `controller.ts`; new `player-input.spec.ts`.

Interfaces: optional runtime `inputInfo()`, `configureInput(config,assignments)`, `sendInput(packet)`, `captureInput(request|null)`. First-party self-contained guest module uses virtual gamepad objects and real getter; no native command sends. Realtime packets bypass the RPC tail. Gate known verified FCEUmm pair, observe native polls before ready; leave other builds' native input intact.

- [x] Observe browser failures for missing operations, then implement module packaging and independent messages, driver config and hotkey safeguards.
- [x] Verify positive driver polling, unknown-build fallback, invalid packets, watchdog, short taps, keyboard/mouse capture-neutral gating and safe release without consuming save replies.

### Task 3: Unified renderer and editor

Files: new `input-session.ts`, `TouchSurface.svelte`, `InputControls.svelte`; update `Player.svelte`, `player.css`; browser component/real-core tests.

Interfaces: session owns validated map/layout, sparse changes, ephemeral assignments and subscriptions; both touch surface and inspector consume it. One ResizeObserver fit transform positions existing game mount and all touch controls. Separate visual and hit frames; parent owns top-level focus heartbeat, guest blur only clears guest keys/mouse.

- [x] Add failing UI cases for bindings, duplicate conflicts, touch press/cancel/drag, multiple pointers, analog neutral, edit/apply/cancel/undo, equal preset padding, orientation and private storage.
- [x] Implement control diagram/live highlights, port/device assignment, keyboard/mouse/controller capture, dead-zone/inversion and clear/reset. Implement editable procedural layouts, play/reference/edit, overlay/underlay, add/remove, numeric geometry and safe focus/refocus.
- [x] Verify local preferences and unsynced-save coexistence; no full config reload or pause claim.

### Task 4: Acceptance and review

- [x] Run affected web suite/Svelte check/build and focused Chromium/desktop+iPhone WebKit. Use generated NES program and external FCEUmm build to prove changed game data from remapped keyboard/mouse/controller/touch and continued save/state/screenshot/shader operation.
- [x] One focused review of input lifecycle, bridge, storage and native compatibility. Fix important findings with RED→GREEN regressions; document acceptance and gaps.

## Completion evidence

Implemented on the existing main checkout, left uncommitted. `pnpm --filter @ecs/web check`: 296/296 tests, zero Svelte errors/warnings. `pnpm ui`: passed. Native input/bridge acceptance: 15/15 across Chromium, desktop WebKit and iPhone-profile WebKit; final geometry plus existing sandbox/settings/capture browser regressions: 45/45. The three real-core cases repeat after the geometry correction; 57 distinct browser/project cases are covered in total. Package-boundary, secret/fixture and diff-whitespace checks pass.

One fresh review returned four Important findings; all were fixed with observed failing regressions followed by passing checks. No review findings remain deferred. Physical Safari/iPhone/controller pairing, notch rotation and sustained latency remain acceptance gaps. Delta archive import, artwork/PDF rendering and emuskins catalog browsing remain the next batch. See [implementation notes](../../operations/browser-player-input-2026-10-30.md).
