# Jaguar CD catalog and artwork acceptance — 2026-10-30

Published catalog: [catalog-2026.10.30.1](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/catalog-2026.10.30.1).
The application verifies the index at 19,007 bytes, SHA-256
`5e0d851b90b42e278369d96a46ee6cf766d64063f4c30b5af812424a2eab0e9b`.
All 39 release assets matched GitHub's size/digest receipts before publication;
the public index and Jaguar CD shard were downloaded and verified afterward.

## Catalog and artwork changes

The original Redump AJCD snapshot replaces the partial Libretro Jaguar CD mirror:
40 complete release names instead of 27 records. All other 117,022 catalog records
remain identical. Filename matching retains alternate, unlicensed, demo, language,
revision and reissue labels; all 35 local disc-set names have exactly one automatic
metadata candidate. First-track hashes are catalog assertions, never a fabricated
verification of CUE bytes, audio tracks or Jaguar's shared boot header.

The bounded snapshot loader verifies compressed and decompressed sizes/SHA-256,
accepts one stored/DEFLATE metadata entry without extracting paths or resolving
external entities, and verifies release-name uniqueness and record count. The
archive and source receipts support offline reproduction after the upstream DAT
changes. Redump's separate source notices do not inherit Libretro's license.
Flycast and the two patch catalogs now retain their own source revision receipts.

Jaguar CD no longer searches cartridge thumbnails. Its provider checks the
dedicated upstream repository, then uses the pinned [Virtual Jaguar collection](https://github.com/libretro/virtualjaguar-libretro/tree/ffea7893a59dd9b9e6f9b85c51627810338b0778/site/thumbnails/Atari%20-%20Jaguar%20CD).
Explicit public-name aliases connect the older artwork DAT names to the full
release names while retaining the original image path, blob identity and source.
The source's generic Blue Lightning scans and unverified Songbird reissue covers
remain review-only, including when a ROM hash agrees. Captures retain title/snap
roles. Distinct artwork scans are not collapsed into a guessed cover.

Both the HTTP resource gate and isolated worker permit the mirror only at its
fixed repository, commit and Jaguar CD PNG subtree. Credentials, query/fragment,
wrong commits, traversal and encoded path separators are rejected. Existing
redirect rejection, response bounds, image validation and worker isolation remain.

## Running-library results

The detached `jaguar-catalog-downloads-20261030/server` snapshot is active through
the loopback LaunchAgent. The original database, LaunchAgent and 691 choice digests
were backed up privately before activation.

| Jaguar CD disc groups | Before | After |
| --- | ---: | ---: |
| Metadata choices | 14 / 35 | 35 / 35 |
| Front-cover choices | 0 / 35 | 17 / 35 |

Six remaining groups have front-cover suggestions needing review; twelve have no
matching front in the source. Existing saved metadata remains the artwork anchor,
so these live results differ slightly from a filename-only dry audit. No saved
metadata or artwork was replaced, and no title screen was mislabeled as a cover.

An initial live pass exposed the missing mirror download permission; it preserved
all choices and saved available metadata. After fixing that gate, two sessions
joined one shared job, which processed all 918 library items in 26.6 seconds with
zero failures or skips. All 721 choices present before this final pass, and all
691 original choices independently rechecked afterward, remain byte-identical.
Temporary acceptance sessions were revoked and no work remains queued.

The library now has 473 metadata and 298 front-cover choices, up from 430 and 261.
Review results decreased from 250 to 234; unmatched results decreased from 327 to
310. These counts describe saved catalog facts and art, not complete descriptive
metadata or verified game-content hashes.

## Local checks and remaining work

Focused provider, evidence, hosted-catalog, isolated-worker, saved-selection and
disc server regressions passed. Snapshot/builder tests cover changed pins,
expansion bounds, first-track selection, full release variants and independent
source revisions. TypeScript, changed-file Biome, package boundaries and the
secret/fixture scan passed. A real pinned PNG also downloaded through the worker.
No protocol, migration, native shell or installer changes were needed.

Remaining artwork work is upstream coverage for missing releases and verification
of edition-specific scans. Richer descriptions and a verified Jaguar CD identity
beyond exact catalog names remain separate work; shared boot/audio data must not
be promoted to a unique game ID. Native RVZ/CSO acceptance and the previously noted
platform dependency updates remain deferred.
