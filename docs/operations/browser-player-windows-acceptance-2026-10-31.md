# Player windows and Screen Mirroring acceptance — 2026-10-31

Implemented the approved separate-window startup and Game view design in apps/web. No new dependencies, server endpoints, runtime protocol, guest permissions, core build or native code.

## User flow

Before Start, **Open game window** copies the selected profile, source/game, explicit save target and selected save IDs into a bounded same-origin player URL. Credentials and save-format consent are not copied. The child checks its current catalog/manifest again and requires the existing explicit compatibility confirmation before starting with copied saves. Safari on iPhone may use a tab instead of a window. Popup refusal leaves the original setup usable.

The original setup disables Start and repeat launch while its child remains open. Observed closure unlocks it; uncertain access does not trigger a takeover. Closing the original setup page does not stop the child. The launcher never focuses, closes or remotely controls the child. This is per-launch UI protection; users can intentionally open another independent session elsewhere.

After the child's explicit Start, it enters **Game view** once initial core/display settings have settled. Embedded players enter on request. **Show controls** restores the workbench. Fit/filter/aspect settings remain; skins/touch controls share their existing transform. The existing iframe and capture/settings/state components remain mounted. A safe-area toolbar keeps Show controls, AirPlay guidance and Release controls reachable; no live iframe detachment or duplicate emulator is involved.

**AirPlay / Screen Mirroring** provides Mac/iPhone system instructions and Apple links. It explicitly says the page cannot initiate the connection. Screen Mirroring includes touch controls and other visible content. No in-page receiver discovery, picker, capture stream, audio rerouting or encoding occurs. This is guidance for OS mirroring, not direct game-to-AirPlay streaming.

Active operations and pending uploads prevent Game view and restore normal controls. Retry/export and prepared screenshot bytes remain available. The app's Stop action asks before discarding pending work. A beforeunload warning is scoped to active/pending work; it is not an iPhone close-protection guarantee or a background save. Both Leave and AirPlay dialogs hold mapped input neutral until all their presentation leases are released. Duplicate guidance requests cannot overwrite the previous input state while a capture-cancellation RPC is pending.

## Automated checks

All browser execution was headless. Chromium was muted; every new and related browser fixture was generated without audio APIs or an emulator. No visible tab/window, system settings, native receiver picker or foreground application was opened. Popups exercised by Playwright were headless pages.

- Unit/Svelte suite: 323/323 passing; zero Svelte errors/warnings.
- New browser cases cover popup refusal/closure, copied save confirmation and wrong-kind rejection, parent teardown independence, one runtime/iframe identity across view changes, retained screenshot data, guidance, pending retry/export and scoped beforeunload.
- Existing affected capture/settings acceptance: 27/27 passing across Chromium, desktop WebKit and iPhone WebKit.
- New post-review window/presentation acceptance: 12/12 passing across Chromium, desktop WebKit and iPhone WebKit (39 focused browser cases total with the related checks).
- Package boundaries, secret/fixture scan and diff whitespace checks passed. Focused lint has warnings/informational style suggestions and no errors.

One fresh code review found two Important modal-input issues and no Critical issues. Both were fixed with presentation ownership regression tests. The initial Game view/settings-read race was also reproduced in the browser and fixed with an explicit settings-ready callback rather than timing guesses.

## Limits and manual checks

Headless Playwright WebKit profiles do not prove shipping Safari or Apple receiver behavior. Actual Mac/iPhone window/tab policy, hardware controller/touch input, safe areas, system mirroring, receiver discovery, latency and routed audio remain physical-device checks. OS menu choices vary by OS version. Keep Safari/game visible during iPhone mirroring; backgrounding or locking may suspend execution.

This batch does not detach an already-running game, automatically reconnect or take over a session, provide phone-only controls with a separate TV picture, or implement a receiver-compatible media transport. No real emulator acceptance was repeated because the guest/core path is unchanged and original silent generated frames prove display and capture continuity. Original native screenshots/state thumbnails still use the existing runtime path.

The user authorized committing this batch on 2026-10-31. No push was requested. Unrelated AI-library documents are preserved.
