# Delta skin import and emuskins browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, with one final focused review.

**Goal:** Import and render PNG/PDF Delta skins in the unified layout editor and browse/install the emuskins catalog with Safari-compatible fallbacks.

**Architecture:** Bounded ZIP worker plus pure Delta conversion; browser-only artwork decoder; IndexedDB library/preferences/catalog cache; a skin session coordinates previews/active layouts with InputSession. The host gets narrow network/worker policy additions; the opaque guest remains unchanged.

**Tech Stack:** Svelte 5, TypeScript, @zip.js/zip.js 2.24.0 (BSD-3-Clause), pdfjs-dist 6.4.299 legacy build (Apache-2.0), IndexedDB, existing WebKit acceptance harness.

**Spec:** docs/superpowers/specs/2026-10-30-browser-player-skins-design.md, approved by user 2026-10-30.

## Global Constraints

- Existing main checkout, preserve unrelated AI-library work. No commit/push requested for this new batch. User explicitly authorized immediate implementation; preserve inline execution from prior batches, no additional plan approval gate.
- Changes limited to apps/web, lockfile/docs and matching /play/ host policy/tests in apps/server. No server archive conversion, proxy, API/schema, core/native or Swift changes.
- ZIP limits: 32 MiB archive, 256 entries, 64 MiB expanded, 16 MiB artwork, 512 KiB info.json, 200:1 expansion, 16 assets; decoded layer <=8 MP. Installed library <=20 skins /256 MiB. Catalog <=2 MiB/5,000 entries, TTL24h.
- Current verified input build/live single-full-screen gate remains. Preview/report unsupported variants; no silently dropped required inputs/screens/filters. Original imports stay separate from overrides.
- Host requests omit credentials/referrer; HTTPS known origins only; raw repository thumbnail mirror; external download/import fallback. No guest network/worker/policy changes.
- Preserve saves, source isolation, epoch/neutral release, native screenshot pixels and existing input preferences. Storage failures keep session usable and distinguish partial persistence.

## Review Focus

- Archive sizes/paths/symlinks/CRC/ambiguities and decode bombs must fail before unbounded allocation, retaining active input/layout.
- A slow/cancelled import or preview must not replace a newer selection or leak Blob URLs/workers.
- Stored overrides must bind to the exact skin hash; failed/removed/cross-tab library assets recover without stale invisible controls.
- Catalog redirects, credentials, malformed entries, stale cache and unsupported hosts must not become a proxy or leak app authentication.
- Imported D-pad/combination/analog controls and reference-plane transforms must agree with artwork/screen placement after rotation; browsing/editing suspends input without pausing/restarting the core.

### Task 1: Package conversion, bounded archive and shared model

Files: create apps/web/src/player/skins/{types,delta,archive,import-client,import.worker}.ts; modify layout.ts/TouchSurface.svelte; tests player-skins.test.ts and generated fixture helper.
Interfaces: SkinPackage {id,name,author,system,variants,assets,original,bytes,created}; SkinVariant {key,device,display,orientation,representation,issues,live}; readSkinArchive(bytes,signal?,progress?):Promise<SkinPackage>; selectSkinLayout(pkg,choices):{layout,issues,live}. Existing ControllerLayout gains hotspot visuals, dpad and combo actions with bounded digital arrays and up to two preview screen frames. Active application separately requires one uncropped screen.
- [x] Tests first: generated valid ZIP/PNG/PDF metadata, small/large frames, combo/dpad/analog, standard/edgeToEdge selection, missing orientation, unsupported actions/screens, traversal/case duplication/symlink/encryption/CRC/byte caps. Observe RED (missing modules), implement, run focused compiled tests GREEN.
- [x] Put extraction in a fixed first-party module worker with abort/timeout termination. Validate declared and actual output; read all members for atomic integrity, retain only referenced artwork. Stable IDs use SHA256. Never insert input HTML/SVG.

### Task 2: Artwork decoder and library/preferences/catalog

Files: create skins/{artwork,library,catalog,network}.ts; tests player-skin-storage.test.ts, player-skin-catalog.test.ts; generated browser fixture tests.
Interfaces: renderSkinAsset(asset,signal):Promise<{url,width,height,release}>; SkinLibrary list/put/get/remove/getPreference/putPreference/getCatalog/putCatalog; network boundedFetch(url,limit,signal). Catalog load returns {catalog,stale,dropped}; search/pagination pure.
- [x] Tests first: PNG headers/pixel budgets, single-page transparent PDF render; library transaction limits, exact-hash override scopes, private/quota/missing storage; catalog lossy parsing/2MiB/5k/aliases/known thumbnail rewrite/credential omission/TTL+offline/redirect policy. Observe RED, implement, focused GREEN.
- [x] PDF.js legacy module/worker are lazy, local and eval-free. Decode only selected assets with cancellation and bounded canvas. Store original+normalized blobs atomically before selection; explicit removals, no silent library eviction.

### Task 3: Session and Safari UI

Files: create skins/session.ts, SkinControls.svelte, SkinPreview.svelte; modify InputSession, InputControls, Player, TouchSurface and CSS. Tests player-skin-session.test.ts plus browser player-capture-real.spec.ts / player-skin-artwork.spec.ts.
Interfaces: SkinSession initialize/import/preview/apply/useBuiltin/resetOriginal/remember/clear/remove/dispose, asset URL map and subscribe. InputSession has external layout persistence port and presentationBusy gate; activating/clearing layout releases input and cancels gestures. Remember reports partial input-vs-layout writes accurately.
- [x] Tests first: stale preview/replacement cancellation, apply/cancel keeps active layout, missing assets/default fallback, exact-hash scoped overrides/reset/remove/cross-tab deletion, input suspension and save-busy controls. Implement same transform for artwork, screen and hotspot; safe-area-aware fit.
- [x] UI provides Files input/drop, trait/compatibility preview, installed presets/imports, search/system/format pagination and stale/error/fallback states; narrow viewport preview sheet/dialog. No actual third-party artwork fixture; original procedural test artwork only.

### Task 4: Host policy, acceptance and review

Files: modify apps/server/src/routes.ts + test/ui-mount.test.ts, web player config/new browser tests; update operation/design docs.
- [x] Add failing host-header assertion, then allow host-only Blob images, self module workers, and exact catalog/raw-thumbnail/direct-download origins. Guest policies/COOP/COEP stay intact. Run focused server test.
- [x] Run web check/build, focused Chromium + desktop/iPhone WebKit skin acceptance. Generated PNG and vector PDF render; controls and art align, imported A changes generated NES pixels; screenshot/state/save/shader and pending upload recovery persist. Run existing affected cases proportionately, no full native/monorepo matrix.
- [x] One fresh focused review of archive/storage/network/lifecycle. Fix Important findings with RED→GREEN and a green affected suite; document hardware gaps and no new commit.

Completed 2026-10-31. Validation and hardware gaps: docs/operations/browser-player-skins-acceptance-2026-10-31.md. All browser execution was headless and silent after the user constraint; no visible fallback. No new commit/push.
