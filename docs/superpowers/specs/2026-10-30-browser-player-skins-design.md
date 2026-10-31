# Delta skin import and emuskins browser

Status: approved by the user on 2026-10-30. The user requested this batch after committing mappings/touch editing, using the unified layout model and prioritizing Safari on Mac and iPhone. The prior batch is `ed81764`.

## Intent and approach

Add local `.deltaskin` import, an installed-skin library and emuskins catalog browsing to our existing Svelte player. Normalize imported representations into the same reference-plane document used by procedural presets. Keep native gameplay in the opaque guest canvas and all skin assets, parsing and browsing in the trusted host.

The user has already selected the owned frontend/unified-model direction. The recommended implementation is a browser-side importer and library, using SkinKit's format/selection/catalog behavior and selected open-source libraries. Embedding the separate Next/React editor would duplicate our UI/runtime and bring its GPL code into this MIT package. Server-side conversion would add archive/PDF execution and caching to the content server; it is unnecessary for this first browser batch.

[GitHub research](../../operations/browser-player-deltaskin-code-research-2026-10-30.md) identifies the closest editor, converters, licenses and concrete transport constraints. Borrow behavior and format knowledge; retain attribution/notices for any source actually reused. Do not copy skin artwork into fixtures.

## User flow

Add a Skins panel beside existing controls. Local import opens a file picker that works from iPhone Files; desktop drag/drop is an additional convenience. Inspect the package before applying: name/author/system, supported device/orientation variants, artwork preview and a concise compatibility report. Apply replaces layout/artwork after releasing input; it does not restart or pause the game. Cancel/failure leaves the current layout and remembered defaults intact.

The library offers built-in procedural presets and locally installed skins. Selection stays session-only until remembered for a core or game. Imported originals remain intact, with geometry edits as separate overrides and a reset-to-original action. Removing an installed skin confirms when it is currently selected; release input and switch to the procedural fallback before deleting blobs. No deletion of saves or game data.

The catalog has search, system/format filtering, author/source attribution, thumbnail placeholders, details and import/download actions. Initially filter to the current system; allow browsing all systems. Render a bounded visible page/list, not 1,308 full image cards. Fetch only after the user opens the catalog. Show when offline cached data is being used and provide Refresh.

For downloads that support browser CORS, download and inspect before applying. If a provider refuses or cannot be fetched, offer its original download page/file and the same local import picker, with plain instructions. Do not imply one-click install works for every provider. Unknown formats (including `.manicskin`) remain visibly unsupported, rather than renamed or guessed compatible.

## Compatibility in this batch

Support standard Delta ZIP/info.json packages, PNG and single-page PDF artwork. PDF is required for useful coverage, not a later optional enhancement. PDF.js is loaded on demand, uses a bundled first-party worker and produces bounded transparent raster layers. No React renderer, native Poppler, WebGPU, OffscreenCanvas requirement or Safari experimental flag. Choose and pin maintained ZIP/PDF libraries during planning, checking their browser requirements and licenses. SVG and unsupported asset types receive an explicit report in this pass; the unified model can retain future SVG metadata without claiming rendering support.

Select iPhone/iPad/desktop representations using deterministic SkinKit-style standard/edgeToEdge fallback and orientation variants. On desktop, prefer a matching landscape representation; allow choosing available traits explicitly in the preview. Never silently turn a portrait representation sideways. Missing orientation can fall back to the procedural representation with a visible notice. Retain original representation metadata for later expansion.

Map arrays of digital inputs (including combinations), directional D-pad objects and left/right analog inputs to logical actions through explicit per-system adapters. Unsupported/special actions are reported and inactive; never map menu/save/load/fast-forward commands into anonymous native hotkeys. Existing host controls remain available. A package with no usable gameplay controls cannot replace the current layout. Reject or clearly disable required unsupported screen behavior before Apply, rather than silently dropping it.

The current virtual-input gate remains the verified FCEUmm build; this batch does not certify additional emulator builds. Live application supports one full native game screen. Multi-screen/cropped-screen skins can be cataloged and their artwork/frames previewed but are marked unavailable for live application in this pass. Do not show a second live canvas with the first screen duplicated. DS touchscreen forwarding, CoreImage filters, animation/reactive assets, alternate runtime windows, themes/gameOverrides and legacy GBA4iOS conversion remain follow-ups. The preview reports these limits before selection is remembered.

## Unified layout and rendering

Extend the current document additively for imported hotspots, directional pads and digital combinations. Imported art is a layer in the reference plane; transparent hit regions sit above it, with selection/pressed highlights when appropriate. The procedural generator still produces the same document. Separate model validity from the default editor's convenient 20–180-unit resize limits, since legitimate skin coordinates can be smaller/larger; all imported frames remain finite and bounded by a validated reference plane and touch regions remain usable.

Game output frame, artwork frame, controls and hit insets use one contain transform and the usable safe-area region. Preserve authored geometry and aspect ratio. Keep screenshots/state thumbnails as guest game/shader pixels without host artwork. Store image/PDF bytes outside the layout JSON and refer to them by stable asset IDs. Crop metadata is normalized only after source dimensions are known; unsupported dynamic crops are not guessed.

Use passive Blob image layers, never insert archive SVG/HTML/scripts into the document. Revoke object URLs and cancel work on replacement/teardown. Rasterize only the selected/previewed representation, cap pixel dimensions and cache a small number of results; do not decode every image/PDF in a catalog. A changing preview selection cannot apply stale decode results.

## Parsing, storage and preferences

Archive processing runs off the main UI path where supported, with cancellation and progress. Start with explicit limits: 32 MiB archive, 256 entries, 64 MiB total expanded bytes, 16 MiB per artwork file, 512 KiB info.json, 200:1 expansion ratio, 16 assets and 8 megapixels per rendered layer. Enforce actual extracted/decode output as well as declared sizes. Reject encrypted, symlink, nested/archive-type surprises, duplicate/ambiguous names, absolute/traversal paths and unsupported compression. Resolve case/stem variations deterministically like SkinKit, never select an ambiguous candidate. Validate CRC/integrity and fail the import atomically. No filesystem or server ZIP imports across package boundaries.

Use a versioned IndexedDB skin library for original package bytes, bounded normalized metadata, artwork Blobs and content-hash identity. Keep layout overrides tied to the exact imported content hash and orientation, separate from the original. Store per-core/game selection and edited fields without capturing unrelated inherited input mappings or connection indices. Existing `ecs.input.v1` data remains readable and clear/reset retains its labeled behavior.

The session coordinates remembered mappings and active-layout preferences: imported image references must never be written as standalone `layout.portrait` overrides with no resolvable asset basis. Library data must be durable before remembering a selection that points to it. Failed/blocked/quota storage keeps the current session usable and reports what was not remembered. Never claim a partial multi-store write was fully saved; allow retry without erasing valid prior data. Cross-tab deletion/missing assets fall back visibly to procedural controls after releasing input. Keep a bounded library (initially 20 skins / 256 MiB total) and offer explicit removal rather than silently evict installed user skins.

## Catalog and host policy

Reuse SkinKit's primary `https://emuskins.com/catalog.json`, raw GitHub fallback, 24-hour freshness policy and offline cached catalog with a stale indicator. Bound JSON at 2 MiB/5,000 entries and validate each entry lossily, skipping malformed records with a count; distinguish an invalid catalog from a valid empty list. Normalize system aliases using existing identifiers and retain source URLs/author credits. Catalog data is untrusted text/URLs, not HTML.

Use credential-free, no-referrer HTTPS requests, bounded time/bytes and explicit destination handling. Reuse the known raw GitHub thumbnail mirror for the exact catalog repository/release ID shape; arbitrary thumbnails get a placeholder when blocked. Permit only the known catalog/download origins needed by this first pass; unsupported destination types use an external link after URL validation. Do not forward app tokens or persist provider responses in saves.

The player host currently permits only same-origin connections/images and no workers. Narrowly extend the `/play/` host policy for the selected catalog/download origins, Blob images and self-hosted module workers; preserve COOP/COEP, credential guarantees and the guest's opaque `allow-scripts` sandbox/network/worker policy. Changes are limited to `apps/web`, relevant docs/dependency lockfile, and the matching host CSP/header tests in `apps/server`. No general proxy, arbitrary URL relay, server-side skin conversion or public protocol/API change.

## Validation and acceptance

Generated ZIP/PNG/vector-PDF/info.json fixtures exercise archive budgets/path ambiguity/corruption, representation fallbacks, system aliases, input combos/D-pad/sticks, unsupported screen/actions, crop conversion, stale preview cancellation, byte/pixel limits, selection/override scope and unavailable/quota storage. No ROM, BIOS, distributed skins or copyrighted artwork committed. Browser tests cover Files-style local selection, catalog search/pagination/cache/fallback, CORS refusal, passive artwork, safe-area/rotation geometry, applying/cancelling while saves remain retryable, default-layout recovery and decoded PDF/PNG pixels aligned with hotspots.

Run focused web tests/Svelte check/build and relevant host-policy tests. Use desktop and iPhone-profile WebKit plus one Chromium check for browser behavior, with the generated NES program and verified core for live geometry/input/save/capture coexistence. Profiles do not establish physical Safari/iPhone, hardware controller or sustained performance acceptance. One proportionate review covers archive/network/storage/lifecycle risk; no full native/Swift/OS matrix.

Builder discretion: exact library versions, component/module names, small UI styling, progress cadence and cache implementation, within these limits. Material changes to live multi-screen support, remote transport/proxy scope or supported formats require surfacing before expanding the batch.

## Builder check

One fresh-context browser engineer check found "nothing important left" before planning. No product code or dependencies have been added for this batch. The companion mockup uses generated example artwork/cards, labels the direct-download fallback and multi-screen preview limit, and changes no running game. The user approved this scope and immediate implementation.
