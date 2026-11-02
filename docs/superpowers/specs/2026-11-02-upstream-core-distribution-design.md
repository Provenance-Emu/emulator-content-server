# Upstream core distribution — first batch proposal

Status: approved 2026-11-02 and implemented. The curated catalog is frozen per
manager; verified packages and catalog receipts are retained under a 512 MiB
cache admission cap. Remote channels and installed-version switching remain
follow-ups.

## Intent and constraints

Advance [#29](https://github.com/Provenance-Emu/emulator-content-server/issues/29)
by retaining complete verified upstream pairs locally and describing coherent
versions independently of application releases. Preserve existing installations,
owner authorization, download allowlists, byte limits and package boundaries.
Keep generated test data and binaries outside committed fixtures. The
[fresh exception audit](../../operations/upstream-core-exceptions-2026-11-02.md)
governs which custom builds can be reconsidered; startup is not gameplay proof.

## Approaches

1. **Recommended: retain the curated catalog and add immutable snapshots plus a
   verified local cache.** Reuse the current downloader and package parser. This
   addresses offline reuse and matched versions without a new hosting service.
2. **Add a remotely updated channel immediately.** Requires channel trust,
   complete snapshot validation, network policy and version-selection behavior
   together. Useful later, but a larger first batch.
3. **Republish all cores into a new artifact repository.** Adds maintenance and
   source/notice retention work without resolving runtime compatibility. No
   present requirement justifies this approach.

## Proposed behavior

- Define a versioned catalog snapshot with a deterministic identity over the
  complete curated entries, exact sizes/hashes and runtime/provenance metadata.
  Preserve existing profiles when the catalog changes. Keep remote channels out
  of this first implementation; a future channel selects one complete snapshot.
- Add an optional server-owned cache under the data directory. Cache a complete
  validated package using an identity derived from its full trusted descriptor;
  never key by a mutable upstream URL alone or accept a client-supplied URL.
- Re-read and validate bounded regular cache files before use. Match the entire
  expected manifest and resource pins, including identity and runtime fields.
  Publish complete entries atomically only after verification. Failed downloads
  or changed bytes never create a usable entry or replace a working profile.
- Keep both old and new descriptor identities so a catalog update cannot overwrite
  the previous pair. Permit offline reuse only of an exact verified identity.
  Bound retained cache bytes to 512 MiB, including receipts and staged bytes.
  Skip new retention when full, without eviction or failing a verified online
  install. A 2,048-file cap also bounds cache directory scans.
- Use the existing owner install route. Do not enable automatic updates, change
  the API contract, rebuild cores or publish binaries in this batch.

## Validation and follow-up

Use generated packages to prove changed upstream bytes fail, missing downloads
fail without cache, a verified cache works offline, corrupt cache is rejected,
two descriptor revisions remain coherent, and an older descriptor can reuse its
old cached pair. Exercise failed writes and symlink handling proportionately.
Run affected server tests and TypeScript build, plus one focused storage review.

Explicit installed-version switching and rollback remain a follow-up: the
current manager rejects an already-installed ID. A later change must preserve
owner system files, disabled/default settings and the working version on every
activation failure. Keep that distinct from cache-level version reuse.
