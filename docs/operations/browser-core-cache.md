# Verified browser core cache

Catalog installs retain verified packages in `<data-directory>/player-cache`.
The owner installation route and public API response stay unchanged. Package
uploads and operator-managed player directories keep their existing behavior.

## Select a reviewed catalog independently of the application

Export the bundled catalog to a new file and keep the printed snapshot ID:

```sh
ecs player-catalog export --to /absolute/catalog-v1.json
ecs serve --data /absolute/content-data \
  --player-catalog /absolute/catalog-v1.json \
  --player-catalog-id <printed-snapshot-id>
```

The ID is SHA-256 over the canonical version-1 catalog payload, excluding the
embedded `id` field. It is not a hash of the JSON file's raw bytes. Export stages
and publishes a complete file without replacing an existing name. It captures
the bundled curated entries; it does not fetch or requalify upstream artifacts.

For a later reviewed catalog, retain a new file and its independently approved
ID, then restart with that pair. Both settings are required. Equivalent
environment variables are `ECS_PLAYER_CATALOG` and `ECS_PLAYER_CATALOG_ID`;
explicit flags override the corresponding environment values. `ecs service
install` accepts the same flags and saves both values in its registration.
Without either setting, the server uses its bundled catalog as before.

The operator-approved ID is the trust anchor. Merely copying the ID from an
untrusted file does not establish trust. The loader bounds files to 1 MiB and
64 catalog entries, rejects symlink files and malformed/unknown schema fields,
and validates every entry's source host, sizes, resource hashes, manifest,
runtime and metadata before initializing server data. It accepts version 1
only and fails closed instead of silently falling back to another catalog.
Resource downloads still use the existing HTTPS host allowlist. This option
does not accept a catalog URL or a URL from an HTTP client.

Selecting a new or older catalog never replaces an installed profile or its
firmware/settings. New installs use that selected catalog's exact descriptors.
An owner can explicitly remove a profile and reinstall using a retained older
catalog and its verified cached package, including offline. Removal retains the
package cache, but follows the existing removal behavior for that installation's
user-supplied firmware. This is catalog rollback and explicit reinstall, not an
in-place installed-version rollback feature. Keep older reviewed files and pins
alongside their packages; this does not introduce automatic remote channels.

## Cache and activation behavior

Catalog downloads and cache verification run outside the management mutation
queue, so a slow upstream request does not block owner configuration, package
uploads, firmware changes or removals. Initial checks and final activation stay
serialized. Activation checks the current installed IDs again: if another
request installs the same ID while the download is pending, the catalog install
returns a conflict and preserves that installation, its firmware and settings.
Catalog preparation has its own queue through activation, so downloaded packages
cannot accumulate in memory behind a slow settings write or installation. Up to
three catalog requests per manager prepare packages concurrently; each reservation
is held through serialized activation. Subsequent requests can retry after failures.
Preflight ordering with earlier removals is preserved.

Each manager captures a version-1 immutable catalog snapshot. Its SHA-256
identity covers canonical JSON for every entry, including matched resource
hashes/sizes, runtime manifest and retained upstream core-info/license/firmware
metadata. A package's primary cache key covers its complete entry. After a
metadata-only catalog change, the server can reuse another cached package only after its entire
manifest, resource sizes and hashes verify against the newly selected entry.
Receipts
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

## Published source and notice references

Retained custom entries can include pinned source, notice and build-receipt
references. Release-receipt linkage records publisher evidence. Incomplete
legacy and upstream mappings remain explicit in the audit. Optional metadata
participates in entry identity, so keep older snapshots for offline reuse of
their existing cache keys. The server validates these references without
downloading the referenced artifacts. The published evidence and remaining gaps
are recorded in the [2026-11-04 provenance audit](./custom-core-provenance-2026-11-04.md).

The [2026-11-05 source audit](./core-source-audit-2026-11-05.md) supplies exact
legacy runtime reconstruction records and named source/SDK notice inventories.
Its catalog linkage uses the existing version-1 receipt shape. Source and build
references retain their pinned bytes independently of the package URL.

## Recover pinned files after upstream nightly replacement

The upstream web host replaces its nightly files. A changed size or checksum
continues to fail verification. For available catalog entries with known resource
pins, the server can recover the same bytes from two reviewed official dated archives. The
[archive verification receipt](./upstream-archive-recovery-2026-11-07.json) records
full archive hashes and exact matches for all 100 pinned resource files.

Recovery downloads each required archive once and extracts its selected members
in one pass. The archives use a solid compression block. The initial fallback
can therefore download about 775 MB, or about 1.6 GB when PlayStation's separate
archive is also needed. The settings page displays this possibility. Later
installs reuse verified local resources.

The raw recovery cache has a separate 340 MiB bound. Existing package retention
keeps its 512 MiB bound. Recovery prunes obsolete managed raw generations while
preserving the package cache. Archive staging is removed after preparation.
Allow about 2 GiB of free disk space for a cold recovery. Preparation is
serialized across processes, and its lock is released if a process exits.

Extraction runs in a dedicated Node child with a 256 MiB WebAssembly heap cap,
64 MiB JavaScript old-generation limits per isolate and a three-minute deadline.
Archive downloads have
a ten-minute deadline. Every selected output must match its pinned name, size
and SHA-256 before package assembly. The same complete package verifier protects
installation, including recovery when optional package retention is full or busy.

The production dependency carries the extractor's License.txt. Its source and
build recipe are pinned to the npm release's Git revision.
[7z-wasm 1.2.0 source](https://github.com/use-strict/7z-wasm/tree/521d2cf93f5964f4e77b01049e19f1b29305c454),
[build recipe](https://github.com/use-strict/7z-wasm/blob/521d2cf93f5964f4e77b01049e19f1b29305c454/build_in_docker.sh).
