# Upstream core distribution (#29)

Updated 2026-11-06. The current distribution uses official compatible runtime
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
The [November 6 verification](../operations/custom-build-verification-2026-11-06.md)
reproduced all eight loader/WASM pairs and complete package hashes from fresh
source extractions. Compiler dependency traces and debug relinks retain exact
source/header and SDK archive evidence.

The catalog links legacy entries to the immutable audit commit and exact audit
file hash using its existing receipt schema. All ten custom entries also retain
nine SDK/component notice pins at the measured compiler/dependency revisions. These
metadata changes create new descriptor/cache identities. Keep older catalog files
and their independent expected IDs for offline reuse of older cache entries.

## Remaining #29 gaps

1. The [upstream binary inventory](../operations/upstream-binary-mapping-2026-11-06.md)
   now covers all 50 exact pinned pairs. Forty-nine match the dated October 31
   archive and PCSX matches its retained later pair. All 50 self-report resolved
   frontend commits and 39 self-report resolved core commits. Eleven core commits
   remain unresolved. Historical CI/Docker records document Emscripten 3.1.46 and
   all WASMs embed the same frontend Clang identity. Complete source/build mappings
   remain unverified for all 50 because exact SDK/container inputs, working-tree
   changes, flags, dependencies and applicable source/notices remain unbound.
   Public historical job trace requests returned HTTP 401.
2. The [component notice audit](../operations/component-notice-audit-2026-11-06.md)
   records 43 modern and 15 legacy component scopes, full bounded input scans and
   335 selected SDK archive members across all ten custom builds. New instrumented
   FCEUmm/Jaguar rebuilds matched published runtime bytes. Restrictive Caprice32 and
   M65C02 notices are exposed in catalog summaries. Full LGPL text and historical
   bcdec grant pointers supplement the source-specific notices. The [historical grant follow-up](../operations/sha1-ijg-resolution-2026-11-06.md)
   recovers the IJG README and author-published Paul E. Jones SHA1 grant, with
   full texts and IJG modification documentation retained in the repository.
   Carrying these materials into future published artifacts remains required. SDK archive reconstruction and final-code notice applicability
   remain open. Compiler input and archive selection precede code elimination.
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

The component/source mapping batch uses an isolated worktree. Publish the completed
batch, return the primary checkout to main and archive the redundant worktree.
Source archives, downloaded core packages and compiled runtime output stay
outside Git. Generated-fixture tests cover rebuild hash rejection and catalog
snapshot/cache behavior.

## November 6 batch verification

All 102 focused source-helper, notice collector, catalog, export, cache, download,
manager and CLI tests passed on Node 22.22.2. Server/CLI TypeScript builds, affected
Biome checks, client drift, secret/fixture scan, package boundaries and whitespace
checks passed. All eight complete package hashes and sixteen runtime resource
hashes matched their original pinned bytes. The focused review found a FIFO
blocking risk in the collector. A timeout-backed regression reproduced it, and
nonblocking opens now reject that input through the existing regular-file check.

## November 5 batch verification

All 97 focused source-helper, catalog, export, cache, download, manager and CLI
tests passed on Node 22.22.2. Server/CLI TypeScript builds, affected Biome checks,
client drift, secret/fixture scan, package boundaries and whitespace checks passed.
The independent source/provenance review found no actionable issues. Legacy
reconstruction hashes were compared against actual downloaded published resources.

## Component and upstream mapping follow-up verification

All 108 focused collector, source-helper, catalog, cache, export, download, manager
and CLI tests passed. Server/CLI TypeScript builds, changed Biome checks, client
drift, secret scan and package boundaries passed. Review checked component indexes,
legacy selectors, shared source identities, document hashes and SDK member references.
A generated 25,000-notice fixture reproduced quadratic line counting. Incremental
line tracking passes that timeout-backed regression. Supplementary grant references
resolve the earlier bcdec and PIC16C5x notice-text inspection questions.


## Historical build and grant follow-up

The [upstream CI/SDK follow-up](../operations/upstream-build-resolution-2026-11-06.md)
records fourteen successful historical jobs covering all eleven cores whose
embedded revision remains unresolved. All fourteen job artifact sets were erased.
The official Emscripten 3.1.46 dependency chain matches the compiler identity in
all fifty pinned pairs. PCE Fast source-literal evidence and Gearcoleco version/tag
evidence narrow candidates without establishing exact source identity.

The [VecX reconstruction](../operations/vecx-upstream-rebuild-2026-11-06.md)
independently reproduced both published files byte-for-byte from commit-pinned
core/frontend archives and SDK 3.1.46. All core/frontend compiler inputs match
those archives. One of fifty upstream pairs now has an independent exact runtime
reconstruction. All fifty complete source/build/notice mappings retain unverified
status. Remaining work includes the other forty-nine reconstructions, eleven
exact core identities, historical job/SDK/cache binding, independent SDK source
reconstruction and component-specific final-code notice scope.

All ten custom catalog entries retain a hash-pinned aggregate grant follow-up
within the sixteen-artifact bound. All fifty upstream entries retain the CI/SDK
follow-up, with the VecX receipt additionally attached to its own catalog entry.
Earlier immutable records are preserved as audit checkpoints.


The follow-up passed 61 focused collector, provenance and catalog tests, the
server TypeScript build, changed-file Biome checks, secret/fixture scan, package
boundaries and whitespace checks. Independent review verified the retained grant
Git blobs, all 972 source-archive compiler inputs, 339 successful compile records,
source archive hashes and direct runtime byte comparisons. The original SHA1
grant uses a path-specific Git text attribute to preserve its CRLF bytes.
