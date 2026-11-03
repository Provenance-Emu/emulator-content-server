# Verified browser core cache

Catalog installs retain verified packages in `<data-directory>/player-cache`.
The owner installation route and public API response stay unchanged. Package
uploads and operator-managed player directories keep their existing behavior.

Catalog downloads and cache verification run outside the management mutation
queue, so a slow upstream request does not block owner configuration, package
uploads, firmware changes or removals. Initial checks and final activation stay
serialized. Activation checks the current installed IDs again: if another
request installs the same ID while the download is pending, the catalog install
returns a conflict and preserves that installation, its firmware and settings.

Each manager captures a version-1 immutable catalog snapshot. Its SHA-256
identity covers canonical JSON for every entry, including matched resource
hashes/sizes, runtime manifest and retained upstream core-info/license/firmware
metadata. A package's cache key covers its complete entry, so changed URLs,
pins or runtime metadata cannot silently select an older manifest. Receipts
are `catalog-<snapshot-sha256>.json`; packages are
`player-<entry-sha256>.ecsplayer`. Snapshot receipts describe the curated catalog,
not a claim that every listed artifact has been downloaded or game-qualified.

Before reuse, the server reads a bounded regular file without following a
symlink, verifies the package parser's hashes and checks against the trusted
catalog. For upstream pairs it compares the entire parsed manifest, resource
table, exact file sizes and hashes. For published ECS packages it checks the
whole-package size/hash and profile ID. Cache contents never supply trusted URLs
or execute in the server process.

After a complete verified download, catalog and package files are staged with
exclusive creation and published as complete files without overwriting existing
names. A cache write lock serializes quota admission across instances/processes;
reads do not wait on it. A busy lock, read-only disk or failed cache write allows
the verified online install to proceed without retaining new bytes. The cache
does not make an unverified or unavailable upstream download acceptable.

Retention is bounded to 512 MiB and 2,048 files, including receipts and abandoned
staging files. A catalog receipt is at most 1 MiB; packages retain the existing
package/resource bounds. At capacity the server skips caching new bytes and
preserves older entries. There is no automatic eviction or background updater.

Removing a managed player leaves its verified cache intact. Reinstalling the
same catalog identity works offline after a restart, even when upstream mutable
paths have changed or disappeared. A newer catalog entry uses a different key;
an older application/catalog snapshot can still reuse its exact retained pair.
The current manager still rejects installing over an existing profile ID. Cache
reuse is not an installed-version rollback API and does not migrate user firmware.

For optional cache recovery, stop the server before manually clearing cache
files. Invalid cache bytes are ignored, never served or overwritten; online
downloads can still install verified bytes. Remove an invalid entry to allow
retention again. After an interrupted writer, an orphan `.write-lock` directory
disables retention until removed while the server is stopped. Abandoned
`.staging-*` files count against the quota and can also be cleared then. Clearing
this directory loses offline reinstall ability but does not remove installed
players, library files, settings, firmware or saves.

The upstream exception audit is [recorded separately](./upstream-core-exceptions-2026-11-02.md).
No custom package or core publication was changed by adding this cache. The
snapshot retains available upstream metadata; it does not assert an exact
source-build mapping where upstream has not supplied one. Remote channels,
source/notice distribution completion and explicit installed-version activation
and rollback remain follow-up work for #29.
