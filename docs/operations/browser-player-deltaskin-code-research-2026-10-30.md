# Delta skin web code references — 2026-10-30

The previous input batch is committed as `ed81764`. The user subsequently approved implementation; see [acceptance notes](browser-player-skins-acceptance-2026-10-31.md) for the resulting importer/catalog browser. No third-party editor source or skin artwork was copied into product code.

## GitHub findings

| Project / inspected revision | Evidence and useful parts | Reuse decision |
| --- | --- | --- |
| [PseudoResonance/delta-emu-ui-editor](https://github.com/PseudoResonance/delta-emu-ui-editor), `79dd934d92743fdc085dfed20af54e5f021b6f59` | Next/React editor with browser archive import/export, representation/element editing, PNG/PDF preview. Inspected `src/utils/zip/zipRead.tsx`, `src/utils/pdf/pdfToImg.tsx`, package manifest, type/console file inventory. Uses `@zip.js/zip.js` and React-PDF/PDF.js. Repository license is GPL-3.0. | Closest browser behavior reference. Keep our Svelte UI and original adapter; do not copy GPL implementation into this MIT package. Its ZIP helper concurrently extracts every entry and tolerates per-entry errors; our importer needs explicit budgets, cancellation and atomic failure. Use underlying ZIP/PDF libraries directly if selected. |
| [Dark-Violet/DeltaSkinConverter](https://github.com/Dark-Violet/DeltaSkinConverter), `d8136028fd600f6d6678b2e11322648eed40eec1` | MIT, Python/Pillow conversion of older GBA4iOS archives to Delta info/representations. Inspected `convert.py` and license. Useful examples of directional inputs, A+B and inherited extended edges. | Mapping reference; reusable source with required notice if any is ported. Legacy `.gbaskin`/`.gbcskin` conversion is outside this pass. Do not carry over unrestricted extraction or square-height assumptions. |
| [Dark-Violet/Dark-Violet-Editor](https://github.com/Dark-Violet/Dark-Violet-Editor) | MIT Python editor; PDF conversion depends on Poppler/pdf2image. Read repository metadata and README. | Coordinate/editing reference, not a browser renderer dependency. |
| [shelbyklein/skin-editor-2025](https://github.com/shelbyklein/skin-editor-2025), `e6c7cee6571660f0ae7794ff57520dd5f19342ac` | Mobile-oriented vanilla JS editor; source has config/data/UI service modules and reference skins. No license returned by GitHub metadata or visible in the inspected tree. | Reference only; no source or artwork copied without a usable license. |

The [Enix web editor](https://delta-skin-editor.enix.one/) advertises import/export, schema validation and movable screen/input frames. Its public source/license was not verified in this quick search, so it is not a reuse dependency. [Skin Studio](https://deltaskin-studio.vercel.app/) is another current browser UX reference, but no source/license review was performed.

Use the user's local SkinKit as the primary representation/catalog behavior specification, with the [Delta format guide](https://github.com/noah978/Delta-Docs/blob/master/skins/README.md) for format details. The guide's screen input frames are source pixels, not normalized fractions: converting to our normalized crop metadata needs the relevant source dimensions. Multi-input arrays and directional objects are real format features, not just single named buttons.

## Current emuskins transport evidence

A fresh bounded read of `https://emuskins.com/catalog.json` returned 1,005,376 bytes, schema version 2 and 1,308 entries, with `Access-Control-Allow-Origin: *`. It contains 1,179 `.deltaskin` URLs, 115 `.manicskin` URLs and other/unknown formats. These are current observations, not permanent feed invariants.

Download/thumbnail hosts include deltastyles.com, github.com, raw.githubusercontent.com and drive.google.com. URLs may contain unescaped spaces/brackets; parse as URLs rather than rejecting otherwise valid names. One encoded NES download probe on deltastyles returned HTTP 403. This does not prove every file or browser request is blocked.

A GitHub release thumbnail redirected to release-assets.githubusercontent.com; the response had no CORS or CORP header in the inspected HEAD/ranged GET. Under the player's COEP, arbitrary catalog thumbnail URLs cannot be assumed embeddable. The same exact catalog thumbnail ID was present in [the catalog repository's `thumbnails/` directory](https://github.com/Provenance-Emu/skins/tree/main/thumbnails); its raw.githubusercontent.com URL returned PNG with CORS `*`. Use this narrowly scoped mirror when the catalog thumbnail has the known repository/release shape, with placeholders for missing/other images.

Direct fetches must omit app credentials, use CORS and a no-referrer policy, enforce byte/time limits, and validate destinations. No unrestricted download relay, bearer forwarding or guest network capability is justified. The initial design uses direct supported downloads with a clearly labeled external-download/import fallback where a provider cannot be fetched by the browser.
