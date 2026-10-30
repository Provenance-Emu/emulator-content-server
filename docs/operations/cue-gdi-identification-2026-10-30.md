# CUE/GDI identification acceptance — 2026-10-30

Multi-file disc identification runs through the existing isolated plugin worker.
The HTTP process supplies only approved local members after checking each file's
permissions, containment and availability. Providers receive validated facts;
ROM bytes and absolute paths stay local.

## Readers and cost

- `org.ecs.identify.cue`: BINARY CUE files, shared BIN/INDEX and pregap handling,
  cooked MODE1/2048 and supported raw MODE1/MODE2 sectors. A known track-01
  ISO9660 origin permits bounded PVD/root-directory/SYSTEM.CNF traversal and
  PSX BOOT or PS2 BOOT2 serial extraction. Secondary data-track ISO origins are
  reported as unsupported instead of guessed.
- `org.ecs.identify.gdi`: bounded track table, unique/contained member names,
  logical track LBAs and physical file offsets, including Dreamcast's high-density
  track 3 at LBA 45000. Exact IP.BIN bytes establish product serial evidence.
- Both: at most 256 KiB of descriptor/sector reads; descriptor 64 KiB, 128 approved
  members, 99 tracks and eight data tracks. No full-disc hashes, audio reads or
  native extraction. Unsupported layouts and missing IDs retain reviewable hints.

Jaguar CD's generic approved boot header is not a unique game ID. An audio-layout
Jaguar CUE therefore reports that it needs an authoritative catalog association
or an explicit match. Original filenames remain available to the existing
opt-in exact-edition policy. No filename becomes verified serial evidence.

## Cache and selection safety

The broker reads only explicitly approved names, opens members lazily, rejects
symlinks/noncanonical paths and checks filesystem identity around identification.
Member calls and total reads remain bounded and cancellation closes the worker's
resources. The cache vector includes the descriptor and every member's IDs,
paths, sizes, requested system and current filesystem validators. Changing a saved
system therefore cannot reuse old-system disc facts. Single-file v3 keys stay unchanged
so this feature does not require rehashing cartridge/archive libraries.

Every proposal retains the member validators even when its facts came from cache.
Changing, removing or escaping a track prevents an older proposal from being
saved. Observed serials retain their actual system IDs on system disagreement;
explicit system/identifier conflicts block automatic filename or saved-artwork
fallback. Saved selection slots retain the existing revision/occupancy protections.

The matching UI now permits CUE/GDI identification in individual and shared-job
review. The retired per-tab planner may request IDs for review, while its existing
guard still prevents provider confidence from automatically saving container data.

## Verification

Generated-byte fixtures cover Dreamcast GDI, PSX and PS2 CUE, cooked/raw sectors,
shared BINs, pregaps, malformed/oversized/truncated layouts, wrong systems, conflicting
IDs, missing/ambiguous/escaped members, cancellation and bounded reads. End-to-end
server cases verify metadata/front artwork matching, exact preservation of an
existing metadata choice, warm-cache reuse, changed-track invalidation and stale
proposal rejection. One focused review found no material integration issues.

All 108 focused plugin/server cases passed, including six integration cases and
a system correction that must retain its saved choice and surface a review. Svelte checking
and all 281 web unit tests passed. Both CUE/GDI matching-option browser cases passed.
