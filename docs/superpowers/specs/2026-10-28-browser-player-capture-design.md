# Browser player capture, state browser and scaling

## Intent and scope

Extend our Svelte player and opaque-origin Emscripten sandbox. Deliver reliable screenshot/state-thumbnail capture first, then browsing/loading saved snapshots and resizing/scaling controls. Prioritize Mac Safari and iPhone Safari; retain usable Chromium/Firefox behavior. Stable browser features are the default. No Nostalgist package dependency or core-loader rewriting.

The user selected this approach after the [one-core comparison](../../operations/browser-player-nostalgist-comparison-2026-10-28.md). Specific decisions below are implementation proposals pending approval, not additional requirements attributed to the user.

## Approaches

1. **Selected:** extend our existing runtime, borrow bounded completion/API patterns from Nostalgist, and retain authenticated uploads and conflict semantics. Most control and least duplication of the existing save owner.
2. Embed the whole Nostalgist wrapper inside the sandbox. The spike established feasibility but it adds loader-text patching, filesystem/path translation and another operation owner. Its screenshot/state helpers still inform this implementation.
3. Adopt EmulatorJS. More existing UI, but replaces UI/runtime assumptions the user chose to keep; outside this batch.

## Capture boundary

- Add narrowly typed screenshot, state-preview and display operations to the existing MessagePort bridge. Keep `sandbox="allow-scripts"`, credential isolation and current CSP. No generic native-function invocation, arbitrary commands, origin access or device permission bridge.
- Discover required runtime methods at startup and report available capture/display capabilities. Unsupported operations get an explicit unavailable state rather than a button that will hang. Existing profiles without save support must remain playable.
- One operation owner serializes state/save/load work. Preserve the existing completed command acknowledgement before reading state bytes. Screenshot acquisition must not consume, inject or race the anonymous save-reply channel.
- **Capture method selected from the diagnostic:** configure only the sandbox's own WebGL canvas with `preserveDrawingBuffer: true` before context creation and encode a PNG immediately after the core's draw callback through a verified Emscripten `postMainLoop` hook. Preserve/chains any existing callback. The external probe passed nonblank/current-frame pixel checks in Chromium, desktop WebKit and iPhone-profile WebKit, with and without a CRT shader. An independent `requestAnimationFrame`, and a post-loop callback without buffer preservation, both produced transparent PNGs in some engines. Do not use the unreliable native screenshot-command route as a fallback, and never return an old screenshot after failure. Report unsupported capture when required hooks/context behavior cannot be verified; 2D canvas paths need their own acceptance.
- Buffer preservation may retain additional graphics memory and affect performance, particularly on phones. Bound canvas dimensions/area before encoding, avoid resizing merely to capture, and include the setting in focused real-core browser acceptance. Do not claim physical-device performance from the WebKit device profile.
- Reuse Nostalgist's useful completion approach as a bounded, cancellable wait, with fresh output and PNG size/header validation. Keep copied code minimal and retain MIT notices if actual source is copied. Do not replace save acknowledgement with file existence or unchanged size alone.
- State thumbnails come from the runtime's thumbnail for the completed state, not an unrelated later display frame. Clear the previous thumbnail before capture. Wait separately for the fresh PNG to finish. An absent/broken preview must not lose a valid state: show a placeholder and a specific preview warning.
- Builder chooses exact deadlines and image limits after reproducing the failure; limits must be explicit, finite, tested and enforced on both sides of the bridge. Bound image dimensions as well as encoded bytes before rendering or exporting.

## Persistence and recovery

- Use existing `save_state` and `screenshot` asset uploads in `apps/web`, without a schema migration or OpenAPI change for this batch.
- New state captures are unique snapshots, rather than repeatedly replacing the loaded state's path. Use a versioned browser-owned relative-path namespace containing full loader/WASM SHA-256 identities, a timestamp and random capture ID. Keep names within existing path limits. Battery-save replacement behavior stays as it is.
- Store a preview at the committed state's exact relative path plus `.png`. Derive pairing only from an authorized manifest for the same item and the recognized namespace; never match a thumbnail by title or an arbitrary URL. Missing previews are allowed. Imported states may have no preview.
- Upload state first, then preview. Advance the gameplay baseline only for our own successful, nonconflicting writes, as today. Never refresh a remote manifest revision into that baseline. Retain exact bodies, idempotency keys and bases on retries.
- A successful state followed by a failed preview upload is reported as saved with a pending preview. Retry uploads only that preview; do not duplicate or recapture the state. Keep an export/recovery action for pending bytes. New captures and loads cannot discard an unresolved pending operation.
- **Builder-check decision:** screenshot uploads do not receive save-conflict-copy semantics. If a preview upload gets a definitive stale-revision 409, retain it for download and offer an explicit Keep state without preview action that clears only the pending PNG. Disable futile retry of that rejected base. Network/unknown-outcome failures retain the original retry request. Do not refresh a remote revision into either a pending request or the gameplay baseline, or change server semantics for this batch. Apply the same download/dismiss recovery to a standalone screenshot upload rejected on revision.
- Pair previews using the returned committed state path, including any server-generated conflict path. Show conflict copies without silently adopting them. Regression tests must cover partial upload and conflict outcomes.
- Standalone screenshots can be downloaded through a Blob link and optionally saved to the current item using the same authenticated client. Source-only playback can still download a screenshot without selecting a save target.

## Save-state browser

- Browse states before Start and during play. Show preview/placeholder, timestamp where available, core/build compatibility and conflict status. Provide Load and Download. Capturing a new state refreshes the list without resetting the save baseline.
- Known browser snapshots with different loader/WASM identities cannot be loaded into the running build. Legacy/imported states require the existing explicit compatibility confirmation. Enforce this before fetching/staging load bytes, not just through presentation.
- Selecting another state during play validates item membership/kind/size, stages the selected bytes, and waits for the completed load reply. Prevent overlapping capture/load actions and return keyboard focus to the game afterward.
- Load previews lazily in a bounded visible batch; validate bytes and embed bounded PNG data URLs under the existing host `img-src 'self' data:` policy. Release cached preview references on list replacement/unmount. Use Blob URLs only for downloads and revoke them afterward. Use accessible controls and a layout usable with touch and narrow iPhone screens.
- Renaming/deleting states, autosave, automatic state migration and cross-core conversion are outside this first batch.

## Display controls

- A responsive player stage observes available space, handles iPhone portrait/landscape changes and safe areas, and keeps controls reachable without covering the game. Avoid a fixed desktop-only height assumption.
- Offer Fit, Fill and explicit aspect/filter choices; Fit preserves the selected aspect ratio and Fill is an intentional stretch. Offer fixed/integer scale factors only when trustworthy native geometry is available. Do not treat a high-DPI/upscaled output canvas as native game resolution or hardcode every core to 4:3.
- Apply changes to the real sandbox canvas/stage, not only the hidden host canvas. CSS presentation dimensions and backing-store dimensions are separate. Avoid resizing the backing store every frame or erasing content without redraw.
- Fullscreen is an enhancement where available; standard embedded controls must work without it on iPhone. Popout, AirPlay and shader configuration are separate follow-up batches.

## Validation and completion

- Meaningful failing regressions first: stale/partial PNGs, missing preview without lost state, pending-preview retry, conflict path pairing, incompatible state rejection and operation ordering.
- Focused web unit tests, Svelte checking/build, browser tests of the sandbox/controls and real cached FCEUmm with the original generated NES program. No full native/OS/core matrix.
- Prioritize WebKit desktop and iPhone-profile coverage, plus a proportionate Chromium check. Use installed Safari/physical iPhone only if available for automation without changing user settings; distinguish emulation from device acceptance and report remaining gaps.
- No ROM/BIOS/save/core binaries, credentials or serve logs in commits. No commits or pushes unless authorized. Changes remain in the existing branch/worktree.

## Builder discretion

Choose component/module names, pagination batch size, visual styling consistent with the existing UI, and capture implementation after gathering evidence. A missing native-geometry export may leave integer scaling unavailable for that profile in this batch; Fit/Fill/aspect/filter controls must still work. Document this limitation clearly rather than guessing dimensions. Scope changes requiring a public API or database change return to the design before implementation.
