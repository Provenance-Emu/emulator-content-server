# Shared library work

Use **Library tools → Library activity** to match existing indexed games or scan saved folders. Jobs belong to the server and appear across signed-in owner sessions. Closing a tab or signing out leaves the job running. Cancel from any owner session; resume processes pending work. Failed and unmatched retries reuse the job. Review acknowledgements persist without silently saving suggestions.

SQLite stores job scope/options, a keyset work list, outcomes and aggregate progress. Duplicate active scopes/options reuse a job; partial overlaps with different options return conflict. One worker services bounded pages of 50 sources and yields between files. The UI requests 20 outcomes at a time. Old per-tab bulk execution is no longer used by the library. Legacy scan calls and enabled watchers enter the same worker.

A restart marks an active job interrupted, retaining completed outcomes for explicit resume. Queued jobs start on readiness. Cancellation cannot publish a partial folder traversal as evidence that files disappeared. Existing saved metadata/artwork, files, sessions and root assignments survive migration. The worker reloads the creator's current permissions. Job inspection/control/review endpoints require the server owner.

Matching never overwrites an occupied category. Automatic saving still requires one unambiguous checksum candidate per category, agreeing systems and healthy providers. Filename-only matches, ambiguity and provider failures remain reviewable. One exact canonical box cover can be corroborated by a unique ROM checksum identity; ambiguous covers, alternate editions, title screens and screenshots remain reviewable. This is game identity evidence, not a checksum equality claim about image bytes. Unlisted games cannot acquire fabricated details.

## Resource behavior

- Folder availability is freshly checked; local-volume probes avoid per-file subprocesses, and other mount-type facts are cached briefly by device. macOS mount types and Linux filesystem mode are read correctly for network-volume classification.
- Folder enumeration streams directory entries. Metadata I/O batches are limited to four on internal volumes, two on network volumes, and one on removable/iCloud volumes. ROM bytes and cloud placeholders are not opened by enumeration; only bounded local disc descriptors are parsed.
- Companion lookup uses persisted normalized directory/stem/extension indexes, including legacy rows. Each indexed seek and combined result are bounded. It does not reload a folder's entire source list for every game.
- Hashing uses 64 KiB chunks, a 64 MiB ROM ceiling, cancellation, and before/after identity/size/nanosecond timestamp checks. SQLite caches hashes against a fresh source ETag including identity and timestamps. Changes invalidate reuse; container hashes are not inner-ROM identities.
- Providers run in isolated child processes with bounded messages, memory and deadlines. Public catalog caching is separate from ROM checksum caching. The host reuses at most two serial workers, with a 64-request queue, 192 MiB heap cap, per-request deadline, five-second idle expiry and periodic recycling. Parsed/indexed public data is bounded (32 MiB raw cache plus 64 MiB parsed/index estimate, at most eight parsed datasets). Cancellation or timeout kills the active child before replacement. No provider code runs in the HTTP process or browser.
- Progress uses stored aggregates. Result listing uses indexed state/keyset seeks; it does not repeatedly count or scan 100,000 completed rows to find the next pending page.

## Generated benchmark

`node scripts/benchmark-matching-index.mjs 100000` creates a temporary generated catalog, performs 1,000 companion lookups, records query plans and removes its data. It never reads an operator catalog or ROM bytes.

The 2026-10-28 run indexed 100,000 generated ROM records plus 500 sidecars in about 3.35 seconds. After eliminating SQLite's whole-root ORDER BY plan, 1,000 lookups took about 254 ms total, with p95 about 0.26 ms. The initial indexed-but-unconstrained plan took about 48 seconds for the same lookups. These are local database measurements, not end-to-end matching throughput or disk/network speed claims. Filesystem inspection retains an O(n) snapshot for conservative rename/absence verification; streaming transactional scan staging remains a later memory optimization.

Regression coverage includes a pre-queue catalog retaining saved choices across two reopens, normalized sidecars beyond 50,000 entries, a 60,000-completed-row queue index plan, cross-session cancellation, disconnected HTTP requests, resume/retry and persisted review. Manual provider choices and source revision checks remain authoritative.

The existing 16 MiB public-catalog body bound remains. An oversized upstream dataset needs a split or streaming index adapter; raising concurrency or creating more browser sessions does not bypass that bound.
