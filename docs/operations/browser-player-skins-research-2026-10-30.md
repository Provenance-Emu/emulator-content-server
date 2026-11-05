# Delta skins in the browser player — 2026-10-30

Feasibility research following the user's request to consider their Swift SkinKit and emuskins.com API while building browser input mappings. This is not an implemented importer or a claim of full Delta/Provenance skin compatibility.

## Existing code to reuse as a specification

The local shared package is `/Users/jmattiello/Workspace/Provenance/SkinKit`. It separates `SkinKitCore`, `SkinCatalogKit`, `SkinKitUI` and manager/storage code. No files in that repository were changed.

- `SkinKitCore/DeltaSkin.swift` opens a `.deltaskin` ZIP or directory, reads `info.json`, chooses representations and exposes mapping sizes, screen rectangles and controls.
- `DeltaSkinCodable.swift` preserves the representation structure: assets, items, screens, mappingSize, translucency and legacy gameScreenFrame; items contain inputs, frames, extendedEdges and thumbstick data. Screen entries include inputFrame/outputFrame and filters.
- `DeltaSkinTypes.swift` and `DeltaSkinDisplayType+LookupChain.swift` model device, display-type and orientation selection/fallback. These rules and tests can inform a TypeScript resolver.
- `DeltaSkinAssets.swift` resolves files in archives; the package deliberately handles filename/case/stem differences. A web importer needs bounded, deterministic path resolution and explicit ambiguity handling.
- `SkinKitUI/Rendering/DeltaSkin+Rendering.swift` handles PNG, PDF and SVG rendering and raster caches. UIKit, CoreGraphics/CoreImage and SwiftUI UI code cannot simply be dropped into the browser.
- `SkinCatalogKit/SkinCatalogService.swift` uses `https://emuskins.com/catalog.json` with a raw GitHub fallback, a 24-hour TTL and offline cache fallback. Reuse that contract and behavior, not an additional independently maintained catalog.

Local `SkinKit/docs/research.md` documents format differences: Ignited altRepresentations, Provenance themes/gameOverrides and keyboard overlays, and assets supported by the different apps. Baseline Delta support and those extensions should have separate capability reporting.

## Recommended browser presentation

Use TypeScript for parsing, representation selection, geometry and action mapping, with Svelte for the editor and accessible controls. Keep the existing native WebGL game canvas in its opaque iframe.

Place skin artwork and screen/control rectangles in one reference-coordinate plane. Fit that plane into the available space once; apply the same transform to artwork, screen frames, visual controls and enlarged touch hit regions. Do not derive button positions independently in viewport percentages while images use another scale. Safe areas and orientation changes belong in this transform and representation selection.

Use ordinary image layers for supported artwork and DOM/Pointer Events for touch regions, live highlights and editor handles. This preserves keyboard focus, accessibility labels and clear hit targets. Canvas is useful for thumbnails, previews and rasterization; it does not need to own every control or redraw the game's WebGL output into another canvas every frame.

PDF assets are a real compatibility requirement. They need an explicit browser PDF renderer or a trusted pre-rendering path, with bounded dimensions/pixels and caching. A PDF URL cannot be treated as a PNG image. SVG assets must remain passive images, not arbitrary markup inserted into the document. Imported artwork should retain its intended layout; consistent padding is a rule for our built-in preset, not a reason to rewrite an author's skin geometry.

Map skin input names to logical player actions through a per-system adapter. Route menu/save/load-style skin actions through our existing host controls and SaveSynchronizer rather than native hotkeys that bypass acknowledgements/uploads. Unsupported special actions, CoreImage filters, animation, alternate representations, dual-screen cropping and Provenance extensions need explicit unsupported states until implemented and tested.

Keep editor overrides separate from the original imported skin, so edits can be reset and the archive remains intact. Use the same input engine for built-in controls and imported skins; skin artwork does not become an input backend.

## Catalog/browser transport check

A single direct read of `https://emuskins.com/catalog.json` on 2026-10-30 returned HTTP 200, JSON with `version`, `lastUpdated`, `totalSkins` and `skins`, 1,308 entries and approximately 1 MB of bytes. The response included `Access-Control-Allow-Origin: *`. The homepage also returned 200 with that CORS header. This does not verify every thumbnail/download host or redirect.

The current player host's CSP restricts fetches to self; the opaque runtime has no network access. Catalog browsing/downloads therefore require an explicit host-side transport and CSP decision, or a reviewed server/plugin integration. Never pass the app bearer token to catalog/download origins, weaken the core sandbox, or build an unrestricted download proxy to work around browser policy.

## Useful sequencing

1. Complete the approved input engine/editor with a skin-compatible layout model: reference size, screen frames, logical actions, separate visual/hit geometry and orientation variants.
2. Add bounded local `.deltaskin` import, representation selection and artwork rendering, including an intentional PDF strategy; test with generated fixtures and a permitted representative skin. ZIP limits/path containment apply in the browser too. Server filesystem/ZIP modules cannot be imported into `apps/web` across package boundaries.
3. Add the emuskins catalog picker, download/cache lifecycle and supported extension set using the existing catalog semantics. Distinguish format capabilities from browser/device/core capabilities.

The renderer architecture is feasible on Safari; actual PDF/SVG decoding, multitouch, device rotation and core screen placement still require desktop/iPhone WebKit and physical Safari/iPhone acceptance. No dependency, API or security-policy change has been made for this research.

## Mockup spacing correction

The preview's responsive CSS forced 40/44-pixel controls even when the inspector specified another size. Its original percentage coordinates also produced unequal outer insets. Version 4 removes those overrides and derives default groups from shared edge/gap geometry. Browser measurements at the inspected viewport gave equal A/B sizes of 56 px, portrait insets of approximately 14.32 px and landscape insets of approximately 26.91 px on both sides. These measurements validate the mockup correction, not production input support.
