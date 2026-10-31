# Player windows and AirPlay Screen Mirroring

Approved by the user 2026-10-31; implementation authorized. User request: popout windows and AirPlay, prioritizing Safari on Mac and iPhone; all browser tests headless and silent. The previous scope question was interrupted. Following “continue”, this document uses the recommended startup-window approach as a proposal for approval, not as an explicit user choice of seamless live detachment.

Builder check completed: a fresh read-only reviewer reported “nothing important left”. Product implementation follows the approved design. No browser, emulator, system picker or foreground UI was launched during design work.

## Intent and scope

Make the player useful in a separate Mac window or iPhone tab, and provide a clean game view suitable for system Screen Mirroring. Keep one emulator for the launched session, existing save/input/skin behavior, and the opaque sandbox. All work stays in apps/web and documentation unless a specific host-policy incompatibility is found and explained. No dependencies, server stream endpoints, schema/client changes, native code, or new emulator build.

Success means a user can finish session setup, open that setup in another window/tab, explicitly Start there, resize/play/save there, enter and leave Game view without restarting, and find accurate AirPlay instructions. This batch does not claim direct in-page game streaming to an AirPlay receiver. Screen Mirroring includes whatever is on the device display, including touch controls; separate phone-only controls with game-only TV output are future transport work.

## Approaches

1. **Launch a separate player before Start; system Screen Mirroring. Recommended.** Reuse /play/ as the session owner from startup. Keep the current sandbox and normal save commands. This delivers a useful Safari path without moving a running iframe or introducing encoding latency.
2. **Detach/reattach an already-running session. Deferred.** Requires an independently validated owner/output/control or state-handoff design. Moving an iframe across documents can change its lifetime; starting another core is not a substitute for continuity.
3. **Direct canvas/audio-to-AirPlay transport. Deferred.** A receiver-compatible live media source, audio capture/synchronization and receiver testing are separate work. A local canvas MediaStream and detection of the Safari picker do not establish working AirPlay.

The user may override the recommendation when approving this design. The builder may settle module names and minor presentation details; changing this scope to live detachment or direct receiver streaming requires a new design decision.

## Separate-window setup

Add **Open game window** beside Start in Session setup. Only available before startup, with the same readiness and save-compatibility gating as Start. The normal Start action remains available until a window opens successfully. Opening the window does not start either emulator.

Construct a same-origin /play/ URL from an explicit allowlist of selection fields: source/item/asset, profile, selected battery/state identifiers, and a game-window marker. Do not forward arbitrary query strings, credentials, filenames, runtime commands, blobs or save bytes. Bound field lengths. The receiving page freshly validates the selected profile, game/source, save target and save files using existing API/preflight rules. Unknown/deleted/mismatched selections must produce an actionable error and no startup. Selected save IDs may be carried, but the new page requires the existing explicit save-format confirmation again before Start. It never treats URL parameters as consent or authority.

Use a user-gesture window.open call with a modest resizable popup hint. iPhone Safari may choose a tab and ignore dimensions; that is supported. Do not auto-retry, auto-focus or repeatedly open windows. A null/failed open leaves setup and Start usable and reports popup blocking; the user may continue in this tab. If a window opens, show **Game setup opened in another window or tab** in the original page and disable its launch/Start controls. Preserve the original setup in memory. Offer Return to library. The child is a complete player with its own Start gesture and normal authentication, not a remote-controlled view.

Both documents already use /play/'s COOP/COEP. Keep the opened WindowProxy only to check closure; sever the child's opener when possible. No postMessage RPC, BroadcastChannel authority, token transfer, CSP relaxation or guest popup permission is needed. If browser isolation makes closure uncertain, keep the original page's launch disabled and offer the library link rather than assuming ownership was released. When closure is positively observed, restore setup controls. No heartbeat timeout automatically starts a second game. This is per-launch UI protection, not a new global lock against intentionally opening the same game elsewhere.

Once launched, closing or navigating the original setup page must not stop the child. Closing the game window ends that session. An already-running player offers Game view instead of a live Pop out action; do not offer a button that restarts the game under that label.

## Game view and controls

Add **Game view** to Display controls. A successfully started game-window page enters it initially; ordinary embedded player pages enter only on request. The mode fills the available viewport, hides the inspector/setup/settings/state browser and logs, and leaves the existing stage, game iframe and touch/skin surface mounted in place. Use CSS/layout state changes, never DOM reparenting or a second runtime. Fit/aspect/filter settings remain in effect. Safe areas and the shared artwork/screen/hit transform still apply on iPhone.

A small accessible toolbar remains with **Show controls**, **AirPlay / Screen Mirroring**, and **Release controls** when input is available. Buttons have at least 44 CSS-pixel touch targets and safe-area spacing. Show controls restores the workbench and appropriate focus without changing playback or settings. Do not globally reserve Escape from the game's keyboard mappings; a focused toolbar button can provide its own keyboard dismissal. Fullscreen stays a separate capability-detected, user-triggered enhancement; Game view works without it.

Release active input and cancel capture gestures on mode transitions. Do not discard an unapplied layout draft: disable entry while editing or a skin dialog is open, with a clear reason. Temporary presentation suspension must be scoped and restored correctly when a help dialog closes. UI hiding must not unmount SaveControls or reset pending upload bytes, prepared screenshots, state browsing or settings.

A pending or active save/capture must remain visible: automatically leave Game view when a save operation begins or an upload becomes pending, and show the normal retry/export controls. Do not auto-reenter afterward. Block entry while one is active/pending. No automatic save, state capture, upload or background-close flush is introduced. The existing warning about pending bytes being lost on document closure remains; beforeunload may warn only while work is active/pending, and cannot promise protection on iPhone. The app's Stop/return action must not silently bypass retry/export while pending: show those controls before allowing explicit discard/navigation.

## AirPlay UI

**AirPlay / Screen Mirroring** opens an accessible help dialog, not a receiver picker. State clearly: **Uses your device's Screen Mirroring. This page cannot start the connection for you.** Provide compact Mac and iPhone instructions, a reminder to use the same local network, and links to Apple's documentation. Offer **Use Game view** after dismissal when entry is permitted. Do not infer a connected receiver from fullscreen state or API presence. Do not start camera, microphone, screen capture, MediaRecorder, audio rerouting or discovery from opening help.

Mac: use Control Center > Screen Mirroring; choose a receiver and the available window/screen sharing option. iPhone: Control Center > Screen Mirroring; choose the receiver, return to Safari and keep the game open. Explain that returning to another tab/app or locking the phone may suspend browser execution. Instructions stay available in other browsers; avoid UA sniffing as a capability guarantee. Link sources instead of baking in a promise about exact OS menu layouts.

## Lifecycle and data

Local mappings/skins/settings use existing origin/core/build/game keys. Native screenshots and state thumbnails continue to use the original core output; Game view must not alter their pixels or include host UI. No save or ROM data crosses between windows through app messaging. Child startup and command failures remain recoverable through existing error/reload/exports. No silent restart, automatic takeover, or duplicated audio owner.

## Validation

Use generated non-emulating, audio-free browser fixtures for launch/blocking/closure, selected-save revalidation, source association, startup count, parent teardown independence, Game view, help dialog, focus/input release and pending-save visibility. Assert the existing iframe and runtime survive view toggles. Test desktop Chromium and desktop/iPhone WebKit profiles headlessly; Chromium remains muted. Do not open native AirPlay selectors, system settings, visible windows or foreground apps in automation. A popup created by a headless test is a headless page.

Add focused unit tests for URL allowlisting/limits and presentation/window lifecycle decisions; run web typecheck/tests/build. Reuse the silent original NES acceptance only if needed to check actual runtime continuity; no full unrelated native/browser matrix. Use one proportionate review for ownership/lifecycle/concurrency changes, not multiple review seats. Actual macOS/iPhone Safari and receiver/latency/audio behavior remain explicitly documented manual acceptance gaps. No claim of hardware AirPlay success from headless tests.

## Sources and deliberate limits

[Research](../../operations/browser-player-windows-airplay-research-2026-10-31.md) records primary-source evidence: Apple's media-element AirPlay APIs, WebKit's receiver-playable-URL requirement and unresolved MediaStream report, and Apple's Screen Mirroring instructions. No new dependency installation is needed. The user authorized committing this batch on 2026-10-31; no push requested. Preserve unrelated AI-library docs.
