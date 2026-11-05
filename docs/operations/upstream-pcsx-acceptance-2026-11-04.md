# PCSX ReARMed upstream default — 2026-11-04

Issue [#29](https://github.com/Provenance-Emu/emulator-content-server/issues/29).
The [byte pins and qualification receipt](./upstream-pcsx-acceptance-2026-11-04.json)
record the fetched official pair and immutable core-info metadata revision.

## Decision

New catalog installations of `org.libretro.pcsx-rearmed` now use the verified
official `https://web.libretro.com/pcsx_rearmed_libretro.js` / `.wasm` pair.
The previous source recipe records no source patches, so no documented ECS
patch/build-option gap requires retaining it as the default after these probes.
The source recipe and historical release remain available for reproduction or
an explicitly documented future compatibility gap. No core was compiled or
republished, and no application release tag was created.

The profile ID, PSX system mapping, single-file EXE/CHD/PBP/ISO extension list,
512 MiB content limit, MEMFS runtime, no-thread requirement and lack of
synchronized saves are preserved. New exact artifact hashes intentionally fail
closed if upstream replaces the mutable paths. The verified local cache remains
the way to retain those bytes for offline installation.

Existing managed and operator installations keep their own saved manifests and
bytes. Changing the default catalog does not replace them or modify firmware,
enabled/default settings, library content or saves. Earlier approved catalog
snapshots and cached ECS packages remain usable for explicit older selection.

## Qualification

- Fresh official factory startup passed through the production opaque sandbox.
- The original generated PS-X EXE rendered green without firmware.
- A generated ISO9660 disc booted that same executable through `SYSTEM.CNF` and
  rendered green without firmware.
- A generated Mode 2/2352 data track converted to CHD with `chdman 0.289`
  rendered green on both the official pair and the archived ECS custom pair.
- All successful video probes produced `[0,251,0,255]`, within the declared
  tolerance of the expected green pixel, with no page errors or unexpected
  network requests.

The first MODE1/2048-derived CHD fixture stayed black on both builds, including
a Deflate-only variant on the official pair. The corrected probe uses Mode 2
user data at byte 24 of each raw sector. This records a fixture-specific failed
case rather than claiming all CHDs work. The raw fixture leaves error-correction
fields zero and is intended for emulator data-loading probes, not disc mastering.

Browser checks ran headless with Chromium muted and the game configured with
`audio_enable = "false"` before launching. Each page, browser and temporary
HTTP server closed on completion. Only generated program/media bytes were used;
the generated media and downloaded binaries stayed outside the repository.
Committed generators reproduce the exact EXE, ISO and raw-track hashes in the
receipt. PBP, commercial compatibility, input, audio, performance, firmware and
save synchronization remain unqualified; the existing PBP extension is retained
without adding a compatibility claim.

## Reproduction

Run the generator tests and fresh official factory audit:

```sh
node --test scripts/psx-smoke.test.mjs
node scripts/browser-core/audit-libretro-web.mjs \
  --cores=pcsx_rearmed --output=/absolute/new-external-audit
```

Write `psxSmokeExe()`, `psxSmokeIso()` and `psxSmokeMode2Track()` from
`scripts/browser-core/generate-psx-smoke.mjs` into a new external directory.
Create a CUE with `TRACK 01 MODE2/2352`, pointing at the generated raw track,
then run `chdman createcd`. Pass each original content path, its extension and
`expectedPixel: [0,255,0,255]` to `smokeLibretroPairs` with the audited loader and
WASM paths. Use a new external results directory for each probe.

Core-info declares GPLv2 and optional firmware; its exact metadata hash is
retained with the profile. Its source repository is the official
[PCSX ReARMed repository](https://github.com/libretro/pcsx_rearmed). The receipt
does not establish an exact source revision or frontend/compiler mapping for
the official web binary. Source/notice distribution records still need
completion before any new ECS mirroring or binary publication.
