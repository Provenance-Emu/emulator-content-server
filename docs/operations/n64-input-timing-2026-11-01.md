# N64 input timing, 2026-11-01

Super Mario 64 passed a brief real-game movement check outside Peach's castle.
After title/file/tutorial navigation and a deliberate 900 ms guest stall, Mario
moved across the grounds during a six-second touch-stick hold. Captures were
reviewed to confirm the tutorial was closed and the scene moved. Native gamepad
polls observed nonzero analog input 440 times; held X remained `0.764525` and
release restored all four native axes to zero. The
[receipt](n64-input-timing-2026-11-01.json) records the exact core/content hashes,
pixel digests, browser, timings and native input states. Counts are diagnostics,
not an emulation-speed benchmark.

Two host-input timing defects reproduced with the operator-local N64 v0.2.1
profile. The loader and WASM are unchanged from the previous
[real-game checks](n64-real-games-2026-10-31.md).

After watchdog expiry, a centered stick still has a pointer owner. The engine
previously required an empty owner list before rearming, so centering without
lifting could leave the next drag ignored. Fresh, fully neutral sources now
rearm a previously armed session after watchdog expiry. Every source on every
port must have zero buttons and axes. Stale packets and held sources cannot
rearm. Explicit inactive/invalid input and ordinary release revoke this recovery
permission and retain the empty-packet requirement.

A second reproduction initially delivered analog input to 30 native gamepad
polls, then lost it during a long guest frame despite continuing host heartbeats.
Native polls were expiring the watchdog synchronously, before the guest could
process queued MessagePort events. Expiry now runs from the 100 ms event-loop
watchdog, with one deduplicated zero-delay task allowing queued messages to run.
The threshold remains 750 ms. Missing heartbeats still release input; explicit
inactive, invalid, capture and visibility releases remain immediate. Disposal
cancels both the interval and any deferred task.

## Validation

Engine regressions failed before the neutral recovery change. Real adapter and
engine regressions failed before the event-loop change, then passed together
with session tests (15 cases). The web check passed all 325 tests and Svelte
reported zero errors or warnings. The production UI build, package boundaries
and secret/fixture scan passed. Existing non-null assertion lint warnings in
unchanged lines remain; the new browser/adapter test code passes its lint check.

The real Svelte touch surface, input session and opaque sandbox also passed a
muted headless component check. A right drag reached virtual gamepad X
`0.764706`; after a deliberate 900 ms guest stall, a left drag reached
`-0.764706`. Releases returned all axes to zero. Its lightweight synthetic frame
pump is UI/bridge evidence, not N64 gameplay evidence.

## Acceptance controls

Real-game checks install an external package and upload owner content through
an authenticated isolated server. Audio is disabled in the emulator config
before `main`; Chromium is muted and headless. No native browser is opened.
Test-only wrappers count the emulator's native gamepad polls and record the
held and released states. A 900 ms synchronous guest stall exercises timing.

Fixed wall-clock menu delays proved unreliable under host contention: a passing
analog-delivery check remained on Mario's title screen, and another run was
still in the opening cinematic. Neither qualifies gameplay. The harness now
supports external reference captures for title/file/tutorial navigation.
Reaching the HUD alone does not imply the opening tutorial has closed.
References, games and captures remain outside Git. Failure diagnostics include
bounded input packet history and pointer events.

Mario Kart race acceptance made no first-capture progress before its deadline.
Its owned runner and headless browser descendants were stopped; race steering
is not qualified by this batch.

Native Safari, sustained performance, synchronized saves and broader game
compatibility remain unqualified. The existing operator-local N64 distribution
restriction remains in effect; this batch changes host input and acceptance,
not emulator binaries or their release status.

## Local deployment

The running server serves the rebuilt player bundle. Static files were published
without a server restart; old hashed assets remain available to existing pages.
Player settings and the N64 profile manifest were compared unchanged before and
after the update. The prior UI and private deployment receipts are preserved in
ignored `dist-release/`. The catalog, games, firmware and saved choices were not
written by this UI update.
