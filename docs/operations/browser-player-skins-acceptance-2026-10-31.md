# Browser player skin import acceptance — 2026-10-31

The player now imports `.deltaskin` archives into the same reference-coordinate layout used by procedural controls. PNG and single-page vector PDF artwork, screen placement, D-pad regions, combinations and stick regions share the existing input/editor path. Files import and Mac drag/drop work without an external service. Inspect a skin, apply for the session, keep it locally, and explicitly remember the selection/edits for the exact core build or game. Original archives and normalized artwork remain separate from orientation overrides.

The emuskins browser provides search/system/format filters, 50-entry pages, known raw-repository thumbnail mirrors, bounded direct downloads, a 24-hour catalog cache and stale offline fallback. Unsupported providers expose a download link for the normal Files import flow. Provider requests omit credentials and referrers; redirects are refused. Catalog availability does not gate local import.

## Compatibility and limits

Live playback retains the existing verified FCEUmm input-build gate. A selected representation must have one uncropped game screen. Missing orientations use procedural controls; multi-screen/cropped/CoreImage-filtered/unknown-input variants are preview-only. Menu/save/load-style skin controls are reported inactive and use the existing player toolbar. SVG, animation, legacy skin formats and full Provenance extensions are not implemented. PDF.js legacy modules and fixed first-party workers are loaded lazily; the guest sandbox capabilities are unchanged.

Limits are 32 MiB archive, 256 entries, 64 MiB expanded bytes, 16 MiB per artwork file, 512 KiB metadata, 200:1 expansion, 16 artwork assets, 8 MP output layer and 8 MP per embedded PDF image. Animated PNGs are rejected. PDF.js excludes embedded images exceeding its image budget. Installed packages are limited to 20 / 256 MiB with no automatic eviction. Catalog limits are 2 MiB / 5,000 entries. These are practical import limits, not an operating-system memory quota for PDF.js.

IndexedDB stores archive/artwork byte buffers and recreates Blob handles on read. This avoids a reproduced WebKit `Error preparing Blob/File data to be stored in object store` failure. Imports transfer artwork bytes out of their worker before it terminates. Denied storage leaves session-only import/application available.

## Validation

Only original generated ZIP, PNG, vector PDF and NES fixtures were used. No distributed skin artwork, game, BIOS or save data was added to Git. ZIP workers were exercised with DEFLATE compression under the actual isolated `/play/` host policy.

- Web Svelte/typecheck and unit suite: 314 tests passing, zero Svelte errors/warnings.
- Host policy/worker isolation: 4/4 passing. Silent Chromium, desktop WebKit and iPhone WebKit acceptance: 12/12 passing. Package boundary and secret/fixture scans passed.
- Regressions cover archive paths/ambiguity/CRC/entry/link/encryption/pixel/animation limits, catalog bounds/credentials/cache, denied/full storage, stale preview errors, exact-hash scope inheritance, pending persistence versus newer edits/clear, and PDF embedded-image allocation limits.
- Browser acceptance exercises transparent PNG/PDF worker decoding and binary library round-trip; the real FCEUmm path checks imported touch input changes native pixels, native captures/saves/settings survive, remembered skin reload works, and catalog paging/provider refusal/offline fallback remains usable.

Playwright WebKit desktop/iPhone profiles are automated compatibility checks, not physical iPhone or shipping Safari acceptance. Hardware touch, orientation/safe-area behavior on actual devices and browser-private storage policies remain device checks. External catalog/provider availability can change.

## Quiet local testing

Browser tests default to headless; opt-in real-core suites no longer switch to visible mode. Chromium launches mute audio. The expanded real-core acceptance assembles a temporary silent NES fixture with a fail-closed source-pattern check. Do not fall back to a visible/audible run when a graphics check fails. This follows the user's explicit request to avoid audio and focus stealing during development.

zip.js (BSD-3-Clause) and PDF.js (Apache-2.0) distribution licenses are included at `/ui/third-party-skins.txt`, linked from the skin dialog. Other editors were references only; no GPL editor code or third-party skin artwork was copied.
