# Upstream core distribution (#29)

Updated 2026-11-05. The current distribution uses official compatible runtime
pairs, immutable catalog snapshots and a bounded verified local package cache.

## Published implementation

- `ae323de` adds immutable version-1 catalog identities and verified local
  retention, bounded to 512 MiB and 2,048 files.
- `978ddca` and `820bb22` keep owner mutations responsive during downloads and
  bound package preparation through activation.
- `98017ab` adds atomic catalog export and operator-selected local catalogs with
  an independently supplied expected snapshot ID. Installed versions remain pinned.
- `b7c86ad` switches new PCSX ReARMed installs to a pinned official pair, following
  generated EXE/ISO/Mode 2 CHD acceptance. Existing installs retain their versions.
- `3b98207` retains source, notice and published build-receipt pins for eight custom
  packages. `202076b` verifies offline reuse across provenance-only catalog changes.
- `e640012` retains the full source/package inspection and exact legacy runtime
  reconstruction evidence, and fixes the two legacy rebuild helpers.

The scanner fixture follow-up `373fa2a` passed Linux CI. The later `202076b`
[Linux verification](https://github.com/Provenance-Emu/emulator-content-server/actions/runs/42130016876)
also passed. The [cache operations guide](../operations/browser-core-cache.md)
records catalog trust, retention, explicit reinstall and cache recovery behavior.

## Provenance evidence completed in this batch

The [source audit](../operations/core-source-audit-2026-11-05.md) and its
[machine-readable inventory](../operations/core-source-audit-2026-11-05.json)
record all ten retained custom packages.

FCEUmm and Virtual Jaguar loader/WASM bytes were independently reproduced exactly
from published source. The earlier Jaguar audit missed its media release's link
to the preceding CD source archive. Both packages reuse that runtime pair. Its
four boot-ROM source files contain zero initializers, with individual pins kept
in the inventory. The reconstruction scope covers runtime resources; published
wrapper manifests retain their separate package hashes.

All eight newer source archives matched their release size/hash. Embedded build
manifests matched the downloaded package and published receipt. Core/frontend
revisions, compiler pins, patches and named notice-file inventories are retained.
Independent rebuild status for those eight remains publisher-reported.

The catalog links legacy entries to the immutable audit commit and exact audit
file hash using its existing receipt schema. All ten custom entries also retain
six SDK/component notice pins at the exact compiler source revision. These
metadata changes create new descriptor/cache identities. Keep older catalog files
and their independent expected IDs for offline reuse of older cache entries.

## Remaining #29 gaps

1. Exact source/build mappings remain unverified for 50 official upstream pairs.
   Their existing core-info hashes and license facts remain retained. The audit
   enumerates every affected profile. Closing this requires a receipt tying the
   pinned resource hashes to complete core/frontend/SDK revisions, flags, patches,
   source and applicable notice records. A range-based nightly header inspection
   records 100 runtime pairs and 59 asset indexes. Named source/build receipt
   files were absent from its search results. Embedded/zipped metadata and payload
   identity remain inspection gaps. A current repository head cannot supply
   historical build proof.
2. Named notice inventories preserve available files. Inline copyright headers,
   exact linked-dependency applicability and notice-completeness review remain
   open. The archived source and pinned SDK notice files are the evidence base.
3. Gameplay qualification remains separate from factory startup and source
   reconstruction. PCSX's generated content acceptance covers EXE, ISO and Mode 2
   CHD. Other formats, commercial compatibility, audio/input and save behavior
   retain their individual qualification scopes.

Direct upstream distribution plus verified local retention continues to supply
compatible pairs. Existing custom exceptions have individual documented runtime
or patch requirements. A dedicated artifact repository, automatic channel and
in-place installed-version switching remain separate decisions. Catalog rollback
uses an older reviewed file/pin and explicit reinstall. Preserving firmware and
a working version during future in-place replacement needs its own scoped work.

## Workspace and related work

The native cleanup checkpoint and #28 retention/recovery work were merged as
`7ab22ac`. Both cleanup branch names were retired and the redundant worktree was
archived. Inbound MCP remains tracked independently in #27.

This #29 batch used an isolated worktree because the primary checkout has
concurrent server-update edits. Preserve those edits while publishing the batch,
fast-forwarding primary main and archiving the redundant provenance worktree.
Source archives, downloaded core packages and compiled runtime output stay
outside Git. Generated-fixture tests cover rebuild hash rejection and catalog
snapshot/cache behavior.

## Batch verification

All 97 focused source-helper, catalog, export, cache, download, manager and CLI
tests passed on Node 22.22.2. Server/CLI TypeScript builds, affected Biome checks,
client drift, secret/fixture scan, package boundaries and whitespace checks passed.
The independent source/provenance review found no actionable issues. Legacy
reconstruction hashes were compared against actual downloaded published resources.
