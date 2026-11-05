# Upstream core distribution (#29) — bounded handoff, 2026-11-04

## Published implementation and evidence

- Immutable version-1 catalog identities and a bounded verified local package
  cache: `ae323de`; [cache and operator workflow](../operations/browser-core-cache.md).
- Management mutations remain responsive during downloads, with preparation
  bounded through activation: `978ddca`, `820bb22`.
- Operator-approved catalog files require an independent expected snapshot ID;
  export is atomic/non-overwriting, service registration retains both settings,
  and catalog changes preserve installed versions: `98017ab`.
- New PCSX ReARMed installs use one pinned official loader/WASM pair while
  historical installs remain unchanged: `b7c86ad`.
  [Original EXE/ISO/Mode 2 CHD acceptance and byte receipts](../operations/upstream-pcsx-acceptance-2026-11-04.md).
- [Custom-build exception audit](../operations/upstream-core-exceptions-2026-11-02.md)
  distinguishes compatible official final artifacts from link inputs and
  documents FCEUmm save-contract, Jaguar firmware-removal/HLE and other gaps.
  Dated catalog counts are not fresh gameplay/availability guarantees.
- Generated fixtures cover changed bytes, absent downloads, checksum failures,
  coherent revisions, offline older-catalog reuse, symlinks, quota behavior and
  installation races. No game/firmware fixtures or core binaries are committed.

## CI finding and bounded follow-up

The [Linux CI run for b7c86ad](https://github.com/Provenance-Emu/emulator-content-server/actions/runs/41934741342)
failed in one unrelated scanner rename-race regression: 1,053 tests passed,
one failed and nine skipped. Lint/build had succeeded; the subsequent audit step
did not run because `pnpm verify` stopped at that test.

The fixture expected `a-before.nes` to be visited before `z-nested`, despite
native directory iteration having no guaranteed order. Forcing directory-first
iteration locally reproduced the exact CI assertion. The test now explicitly
controls only that fixture root's enumeration order so it actually exercises
the old-name/new-name duplicate-identity race. Production scanning is unchanged.
The adverse-order reproduction and all 13 source-scan tests pass on Node 22.22.2;
the affected TypeScript build, Biome and whitespace checks pass. The signed
fix was published as `373fa2a`. Its [Linux CI verification](https://github.com/Provenance-Emu/emulator-content-server/actions/runs/41948499469)
passed, including the configured dependency audit.

## Remaining #29 acceptance work

Eight retained custom packages now have release-linked source, notice and build
receipt pins. Corresponding-source/build and license-notice completeness remain
open across legacy custom artifacts and upstream pairs.
Current upstream profiles retain exact artifact pins and pinned core-info
metadata/license/firmware facts. The official web host does not supply an exact
source-to-binary build mapping in the inspected receipts. Preserve that unknown;
do not invent a source revision or claim that a repository link proves an exact
binary build. The inspected existing release source/notice assets are linked
in the dated provenance audit below.

An automatic channel and in-place installed-version switching are still
unimplemented. #29 permits a channel; it does not require building one. Current
catalog rollback uses an older reviewed file/pin and an explicit reinstall from
its verified cache. A future in-place replacement feature must preserve owner
firmware/settings and the working version on failure, and needs its own bounded
implementation scope. None is a reason to rebuild every core or create per-core
application tags. Direct upstream download plus verified local retention remains
the documented approach; a dedicated artifact repository is not justified yet.

## Ownership and completion eligibility

The configured 1Password SSH signing retry succeeded. The CI-fixture fix and
initial handoff were signed and pushed to main in `373fa2a`. The corresponding
[Linux CI run](https://github.com/Provenance-Emu/emulator-content-server/actions/runs/41948499469)
passed.

The next bounded batch retains published source, notice and build-receipt pins
for eight custom packages and explicitly unverified metadata for FCEUmm/Jaguar.
The [dated provenance audit](../operations/custom-core-provenance-2026-11-04.md)
records verification scope and outstanding gaps. Source rebuilds and complete
license-notice audits remain outstanding, as do exact upstream build mappings.

This checkout remains on `main`. No second ECS worktree or agent lane was
started. `codex/ai-library-cleanup` and its remote at `99cf326` retain two unique
unmerged commits for #27/#28. Their recovery/retention work and review remain
unfinished; preserve that branch rather than archiving it to reduce sessions.

The bounded CI-fixture follow-up has been published. #29 itself remains open
for the provenance/notice acceptance audit above. A session may be paused or archived only with this handoff retained;
that would not mean the epic or the separate cleanup branch has been completed.

The provenance batch passed the focused server/CLI catalog, cache, download and
manager tests on Node 22.22.2. Server/CLI TypeScript builds, affected Biome checks,
client drift, secret/fixture scan, package boundaries and whitespace checks passed.
All eight static receipt/notice pins were compared with downloaded release bytes,
and source pins were compared with their published receipts.

## CI and native cleanup checkpoint — 2026-11-05

The `3b98207` [Linux CI run](https://github.com/Provenance-Emu/emulator-content-server/actions/runs/41949309098)
and [nightly distribution](https://github.com/Provenance-Emu/emulator-content-server/actions/runs/42048221930)
passed. The native cleanup branch's #28 retention/recovery work was finished before
starting another core-distribution implementation batch. Its
[updated handoff](./ai-library-cleanup-handoff.md) records scope and validation.
The earlier instruction to preserve `99cf326` applies until the unique native
cleanup history has been merged and published. #27 remains a separate MCP scope.

## Provenance-only snapshot regression — 2026-11-05

A generated-package cache regression now exercises adding source/notice/build
receipt pins while retaining identical package bytes. An older pinned catalog
reinstalls offline after restart. The enriched descriptor requires its own
verified cache entry; after that package is retained, both snapshots reinstall
offline and both receipt files parse under their independent expected IDs.
Only the package URL is fetched; provenance references remain metadata.
All 47 focused catalog/cache/selection/provenance tests passed on Node 22.22.2.

The native cleanup checkpoint and #28 retention/recovery follow-up were signed
and published to main as `7ab22ac`. The original cleanup branch's unique commits
are included, and its merged local and remote branch names were retired.
