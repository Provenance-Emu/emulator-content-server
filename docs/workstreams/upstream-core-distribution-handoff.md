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
the affected TypeScript build, Biome and whitespace checks pass. The new push
gets normal CI; do not treat the previous failed run as a core-distribution
regression or claim the new full CI run has already passed.

## Remaining #29 acceptance work

The main remaining evidence gap is completeness of corresponding-source/build
and license-notice records across retained custom artifacts and upstream pairs.
Current upstream profiles retain exact artifact pins and pinned core-info
metadata/license/firmware facts. The official web host does not supply an exact
source-to-binary build mapping in the inspected receipts. Preserve that unknown;
do not invent a source revision or claim that a repository link proves an exact
binary build. Review actual existing release source/notice assets before adding
new publication or mirroring.

An automatic channel and in-place installed-version switching are still
unimplemented. #29 permits a channel; it does not require building one. Current
catalog rollback uses an older reviewed file/pin and an explicit reinstall from
its verified cache. A future in-place replacement feature must preserve owner
firmware/settings and the working version on failure, and needs its own bounded
implementation scope. None is a reason to rebuild every core or create per-core
application tags. Direct upstream download plus verified local retention remains
the documented approach; a dedicated artifact repository is not justified yet.

## Ownership and completion eligibility

Publication of this bounded follow-up is pending: the configured 1Password SSH
signer returned `failed to fill whole buffer`, so Git did not create the commit.
The test fix and this document remain staged in the primary checkout; main and
origin/main still point at `b7c86ad`. Signing was not disabled. Finish the signed
commit and authorized push before marking this follow-up done or archiving it
as a finished task.

This checkout remains on `main`. No second ECS worktree or agent lane was
started. `codex/ai-library-cleanup` and its remote at `99cf326` retain two unique
unmerged commits for #27/#28. Their recovery/retention work and review remain
unfinished; preserve that branch rather than archiving it to reduce sessions.

The bounded CI-fixture follow-up and this handoff can be considered complete
after publication. #29 itself remains open for the provenance/notice acceptance
audit above. A session may be paused or archived only with this handoff retained;
that would not mean the epic or the separate cleanup branch has been completed.
