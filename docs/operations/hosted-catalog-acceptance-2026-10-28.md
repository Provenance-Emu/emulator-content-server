# Hosted catalogs and compressed-disc identification acceptance — 2026-10-28

Published catalog: [catalog-2026.10.28.1](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/catalog-2026.10.28.1).
The committed application pin verifies the public index as 18,376 bytes, SHA-256
`5ff3e4be9e579f2b477b4e1483206ee3cd53178629dae3d9c168992ac4e77ab4`.
All 37 uploaded release assets matched GitHub's independent size/digest receipts
before publication. The public index was downloaded and verified before pinning.

## Coverage and bounds

- 100,302 metadata records across 19 systems; 16,745 validated RetroArch cheat-file references; two BPS patch references.
- 33 system/kind shards, 14 attributed source definitions. Includes pinned Flycast aliases for Naomi, Naomi 2 and Atomiswave alongside disc databases, plus Dreamcast, Jaguar/Jaguar CD, MAME/FBNeo, GameCube, Wii and PSP.
- 444 cheat files excluded with explicit reasons: 424 unsupported/malformed CHT files, 19 oversized files, one empty file. Resource checksums describe original upstream bytes; normalized cheats are saved with every code disabled.
- Cheat/patch payloads remain at pinned original upstream URLs. Catalog release assets contain metadata, pointers and notices, with no ROM/BIOS/disc/save or cheat/patch payloads.
- Catalog refresh warms the committed release for the job's systems. A new catalog version requires a new immutable release and an application-pin update; this does not silently accept a mutable latest manifest.

RVZ/WIA readers validate bounded container headers and canonical GameCube/Wii IDs.
Dolphin sparse CISO and PSP CSO v1 plain/DEFLATE readers use bounded logical windows;
PSP identity comes from ISO9660 `PSP_GAME/PARAM.SFO`. They do not claim a full-image
hash or decompression validation of every packet. Generated fixtures cover these
layouts, cancellation, corrupt/truncated headers, invalid ranges and expansion
limits. Native Dolphin conversion and real user RVZ/CSO media acceptance remain
unverified on this machine; unsupported CSO versions/codecs fail closed.

## Local checks

- Reader/native/worker regressions: 39 passed.
- Hosted client, matching/evidence, coverage, worker lifecycle and cheats: 98 passed; the final provenance adjustment passed 46 focused cases.
- Queue affinity, migration and server job integration: 20 passed. Includes 65 interleaved systems, a 60,000-completed-row prefix, indexed query-plan assertions, and v19→v20 preservation across two opens.
- Server resource integrity regressions verify raw digest/length before cheat normalization and reject BPS/UPS base CRC/size mismatches.
- Builder: three generated-data tests passed; every release asset checksum verified.
- Web: Svelte check clean and 244 unit tests passed. Sixteen existing browser cases passed; the new catalog-action case passed after correcting its fixture navigation.
- TypeScript, client drift, secret/fixture scan and package-boundary checks passed. No native app, Swift or multi-OS rebuild was needed for this batch.

Public-network acceptance used the pinned client and isolated worker to sync 12
shards (32,461 records), resolve metadata for GameCube/Wii/PSP and the six locally
used disc/arcade systems, download/verify one real CHT resource (60,039 bytes), and
download/verify one real BPS resource (345 bytes). No game files were uploaded.

## Running installation

The loopback LaunchAgent now serves the detached `hosted-catalog-20261028/server`
snapshot and current web UI. Before activation, the v19 database, LaunchAgent and
596 saved-choice digests were backed up in the private ignored release directory.
The server migrated to schema 20, and its real shared catalog-refresh/matching job
completed all 918 imported games with zero failures. Every prior selection JSON
and content byte remained identical: 420 metadata selections and 176 artwork
selections. No additional automatic selections were saved; 325 games remain in
review and 334 unmatched. The temporary acceptance session was revoked.

System-affinity scheduling now uses `(job_id,state,system_id,entity_id)` so large
jobs process adjacent systems without hash-order cache thrashing. Public result
pagination keeps its existing cursor ordering. The parsed/index cache retains two
systems within a 64 MiB estimate and raw text stays bounded separately at 32 MiB;
a single system exceeding that budget may still reparse cold shards.
