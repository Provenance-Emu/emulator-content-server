# Upstream core exception audit — 2026-11-02

Issue: [#29](https://github.com/Provenance-Emu/emulator-content-server/issues/29).
Machine-readable evidence: [download pins, metadata and startup results](./upstream-core-exceptions-2026-11-02.json).

## Scope and method

The current compiled catalog contains 64 entries: 49 upstream resource profiles,
11 downloadable ECS packages, and four other entries. These are catalog counts,
not claims of live availability or content qualification. The official selector
still lists 88 names. This audit deliberately tests the overlap with ECS custom
builds, rather than repeating the historical all-core inventory.

Ran `scripts/browser-core/audit-libretro-web.mjs` with the 17 names recorded in
the receipt. Downloaded bytes stayed outside the repository. The audit captured
exact loader/WASM sizes and SHA-256 hashes, core-info metadata at an immutable
libretro-super revision, and the production sandbox hash. Startup ran in headless,
muted Chromium through the existing opaque sandbox. No content or firmware was
loaded, and no catalog pins or installed players were changed.

A separate follow-up loaded the repository's generated original PS-X EXE in
the official PCSX ReARMed pair without firmware. It passed the production opaque
sandbox's video probe (green pixel `[0,251,0,255]`), with no page errors or
unexpected requests. See the [content receipt](./upstream-pcsx-original-program-2026-11-02.json).
This qualifies that original executable path, not commercial games, all media
formats, inputs, audio or saves.

Eight complete pairs downloaded; three passed startup. Five downloaded loaders
use the legacy global `Module` format without an ESM default export and failed
the current startup probe. Both artifact URLs returned 404 for the other nine
names. These are observations of the checked web paths on this date, not proof
that no other upstream artifact or future release exists.

## Individual decisions

| ECS core / checked upstream name | Fresh result | Distribution decision |
| --- | --- | --- |
| FCEUmm / `fceumm` | Official pair passes factory startup | Keep the patched ECS package for its explicit save-completion contract. Upstream startup does not establish that contract. Do not rebuild merely to refresh upstream bytes. |
| PCSX ReARMed / `pcsx_rearmed` | Official pair passes factory startup and generated EXE rendering without firmware | Candidate to migrate upstream. The current ECS recipe records no source patches and advertises no synchronized saves. Original-program HLE/video passed; qualify the other advertised single-file formats before replacing the catalog entry. |
| Virtual Jaguar / `virtualjaguar` | Official pair passes factory startup | Retain the custom exception. The ECS recipe removes four embedded boot-ROM arrays, forces CD HLE at boot and disc insertion, and rejects real-firmware-only paths. Factory startup cannot establish equivalent firmware removal or CD behavior in the upstream pair. |
| ProSystem / `prosystem` | Legacy loader fails startup | Retain custom compatible frontend linking. Revisit when a compatible final upstream pair is available. |
| Stella 2014 / `stella2014` | Legacy loader fails startup | Same compatibility exception; no blanket rebuild requirement. |
| FreeIntv / `freeintv` | Legacy loader fails startup | Same compatibility exception; user firmware remains separate. |
| Atari800 / `atari800` | Both web paths return 404 | Retain the recipe and its explicit 5200 machine-default patch. |
| PokeMini / `pokemini` | Both web paths return 404 | Retain the missing-artifact exception and FreeBIOS metadata. |
| Potator / `potator` | Both web paths return 404 | Retain the missing-artifact exception. |
| SameDuck / `sameduck` | Both web paths return 404 | Retain the missing-artifact exception. |
| Beetle PC-FX / `mednafen_pcfx` | Legacy loader fails startup | Retain custom compatible frontend linking and separate user firmware. |
| Flycast / `flycast` | Both web paths return 404 | Retain the documented WASM JIT port exception and its source/build receipts. |
| N64 / `parallel_n64`, `mupen64plus_next` | Legacy parallel loader fails; next paths return 404 | Retain the documented operator-local fiber port. Existing distribution limitations remain in `scripts/browser-core/n64-source-notes.md`. |
| Dolphin / `dolphin` | Both web paths return 404 | Retain the separate runtime/worker prototype; do not treat it as a drop-in Libretro pair. |
| Play! / `play`, Azahar / `azahar` | Both web paths return 404 | Keep explicit blockers; no compatible pair established. |

## Final artifacts and source inputs

A core `.bc` file or static `.a` archive is a frontend link input, not a runnable
browser loader/WASM pair. The ECS software-core recipe explicitly builds that
input and links it with RetroArch. An upstream core source release does not by
itself replace that step. The [RetroArch Emscripten instructions](https://github.com/libretro/RetroArch/blob/master/pkg/emscripten/README.md)
describe the frontend build; the [official buildbot index](https://buildbot.libretro.com/nightly/emscripten/)
currently offers date-named full RetroArch archives as well as a mutable latest
archive. This audit did not download or qualify those archives, and does not
claim the web paths exhaust their contents.

## Remaining work for #29

At the start of this audit, the installer verified exact bytes and staged
complete packages before activation, but had no retained verified download
cache. The approved first batch now adds [immutable catalog receipts and a
bounded verified local cache](./browser-core-cache.md). Installed profiles and
retained packages survive upstream outages. Duplicate installation remains
rejected rather than offering installed-version selection or rollback. The
bundled upstream pins remain curated in the application; operators can also select a
reviewed catalog file and expected ID independently. There is no live remote
channel.

The first batch retains matched resources, runtime requirements and available
upstream provenance/license metadata. Complete the corresponding-source/notice
distribution records as applicable before changing artifact publication.
Advance any future channel only after its entire snapshot verifies; never
refresh one loader independently. Follow with explicit version activation and
rollback that preserves operator-supplied system files and the previously
working installation on failure.

Direct upstream downloads remain sufficient for obtaining compatible bytes while
the pinned paths remain available. A local verified cache is needed for offline
reuse after upstream changes. Neither requires compiling all cores. A separate
artifact repository and new per-core application tags are deferred; this audit
does not establish a storage/retention requirement that justifies either.
