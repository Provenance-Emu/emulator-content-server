# Player Windows Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, with one final focused review.

**Goal:** Separate-window startup, reversible Game view and accurate AirPlay Screen Mirroring guidance for Safari Mac/iPhone.
**Architecture:** Pure bounded launch-URL helpers and a per-launch window handle; Player owns lifecycle and presentation state. Keep the stage/iframe and all save/input/settings components mounted while CSS changes their visibility. A first-party help dialog explains system mirroring without media capture/transport.
**Tech Stack:** Existing Svelte/TypeScript/Playwright only.
**Spec:** docs/superpowers/specs/2026-10-31-browser-player-windows-design.md (approved 2026-10-31).

## Global Constraints

- Existing branch/worktree, apps/web + docs only; no new dependencies or server/core/schema changes. Preserve unrelated AI-library docs. Commit when requested; no push requested.
- All browser tests headless and silent; no OS picker, visible UI, foreground/focus changes or headed fallback.
- Separate window before Start; no live detach, duplicate runtime, credential forwarding or direct AirPlay transport.
- Keep sandbox/CSP/COOP/COEP and existing original screenshot/save/input/skin paths.
- Native inline execution continues from previous batches. User explicitly approved immediate implementation; no additional plan handoff approval.

## Review Focus

- Blocked/severed/closed popup handles must never silently lose setup or open repeated windows.
- Copied save IDs must be freshly verified against target/profile; compatibility confirmation cannot be transferred in a URL.
- View toggles must preserve iframe/component identity and pending capture bytes while releasing controls.
- Help close, teardown and display transitions must not restore mapped input into another open modal.
- A parent setup page closing must not own/dispose the child; pending save navigation needs an explicit user decision.

### Task 1: Bounded launch selection and window lifecycle

Files: create src/player/windows.ts and test/player-windows.test.ts.
Interfaces: WindowSelection {source?,item?,asset?,profile,battery?,state?}; gameWindowUrl(origin,selection):string; readGameWindowSelection(URLSearchParams):WindowSelection|null; validateWindowSaves(selection,files):void; GameWindowLaunch.open(url,openWindow), checkClosed(), dispose(), opened/error. Only allow bounded known string fields and same-origin /play/ URL. openWindow abstraction is a minimal Window-like handle; no focus/close calls.
- [x] Write tests for allowlisting (no token/arbitrary params), invalid/ambiguous/control/oversize identifiers, save kinds, blocked/throwing launch, repeat suppression, observed closure and uncertainty. Observe RED, implement, focused compiled tests GREEN.

### Task 2: Player startup handoff and presentation UI

Files: modify Player.svelte, DisplayControls.svelte, player.css; create AirPlayHelp.svelte. Tests: browser/player-windows.spec.ts, using original silent generated fixture.
- [x] Add failing browser cases: Open game window absent before change; popup copies selected profile/game/saves and requires fresh confirmation; parent does not start; child starts once and survives parent close; blocker fallback preserves Start.
- [x] Integrate launch helpers and child selection validation in boot; parent setup locked until positively closed. Enter Game view after explicit Start in game-window page. Keep normal Start and current ready/preflight gates.
- [x] Add Game view controls/toolbar, safe areas, no iframe movement/unmount. Keep hidden panels mounted; block while editing/modal/busy/pending. Input transitions release/cancel gestures. Help is a scoped accessible dialog with Apple links and no capability/picker claims. Add browser tests proving identity, help cancellation and hidden screenshot state preservation.
- [x] Add active/pending save protection: force normal controls view; prevent app Stop/return from losing pending bytes without an explicit discard confirmation; beforeunload only while busy/pending, no flush/guarantee. Test pending-save visibility and cancellation.

### Task 3: Focused acceptance and review

- [x] Run web check/build and affected browser cases in muted Chromium and silent desktop/iPhone WebKit; generated loader produces no audio. Existing silent native acceptance only if unresolved continuity risk requires it.
- [x] One fresh read-only ownership/lifecycle/concurrency review; fix Important findings with RED→GREEN and affected checks. No review fleet or unrelated matrix.
- [x] Record acceptance/hardware limits, update plan/ledger. Leave batch uncommitted.

Completed 2026-10-31. Implementation added presentation.ts / player-presentation.test.ts for the two reviewed modal-input issues and an optional SettingsControls.onready callback for initial display setup. Acceptance: docs/operations/browser-player-windows-acceptance-2026-10-31.md. Commit authorized 2026-10-31; no push requested.
