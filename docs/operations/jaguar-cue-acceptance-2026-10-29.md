# Jaguar CD CUE/BIN acceptance — 2026-10-29

Virtual Jaguar core 3.10.0 now has compressed CHD and CUE/BIN browser acceptance.
The [CHD receipt](jaguar-chd-acceptance-2026-10-29.md) records the converter,
session metadata, image hash and actual emulated output. No core rebuild or
firmware was required for either format.

## CUE/BIN staging

Profiles opt in through their existing `contentExtensions` manifest. The Jaguar
profile is now 1.2.0 and advertises `cue`. Its loader and WASM are byte-identical
to 1.1.0. Source-group responses add an optional `relativePath` field relative to
the common disc-group directory. The generated TypeScript and Swift clients and
v1 surface snapshot include that additive field; every group member and content
download retains its existing authorization check.

The browser collects the descriptor and every referenced BINARY member before
importing operator code. It resolves contained paths, rejects missing, ambiguous,
offline, evicted and changed-size tracks, and rewrites filenames to flat internal
`track-NNN.bin` names. Session, track and index directives remain unchanged.
Multiple tracks sharing one BIN collect and stage that file once. Limits are
64 KiB per descriptor, 128 staged files and the profile's aggregate content limit
(512 MiB for Jaguar), enforced again by the parent bridge and opaque iframe.
Cancellation stops further collection. WAVE/MP3/AIFF/MOTOROLA files, playlists,
multidisc swapping, real BIOS boot and synchronized saves remain unsupported.

The scanner also resolves unique case-insensitive references to actual indexed
track names. Exact names retain priority; ambiguous casing and traversal remain
errors. Its fallback index is constructed only if a case mismatch is encountered,
once per scan rather than once per descriptor or track.

## Real-core acceptance

`jaguarSmokeCue()` splits the original generated two-session disc into two BINARY
files. Session 1 is silence; session 2 holds the original word-swapped 68000
counter/green-frame program. The browser cases use a descriptor in `disc/` and
tracks in sibling `tracks/`, exercising contained parent references.

- A registered folder was scanned and launched through the source-group API.
- A CUE and both BIN files were uploaded to one item and launched through its
  manifest. Each upload used the current item revision.
- Both passed with advancing guest counters, green compositor pixels and no
  page errors in an opaque `allow-scripts` iframe with Chromium/SwiftShader.

Unit/integration checks cover reference containment, case ambiguity, shared BIN
deduplication, size/count limits, offline and changed members, cancellation,
preflight ordering, ACLs and group-relative paths. A browser regression covers
the aggregate MEMFS budget and replacement writes. All 270 web unit tests and
Svelte diagnostics passed; the focused storage/server suites passed 16 cases.
One focused review found no material staging issues.

## Delivery

[Profile 1.2.0](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/v0.1.6-jaguar-media.1)
is a manifest-only update with unchanged sanitized core resources. The public
package is 4,604,920 bytes, SHA-256
`b3c8dbd57a7691a2e7335e99f9c2afe120be5a2d229a6f3c0b1994e654e016de`.
The corresponding sanitized source archive remains linked from the release.
