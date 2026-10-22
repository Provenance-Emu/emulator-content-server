# Matching review and optional organization

User direction: faster review with Save and next, visible progress, automatic
metadata sorting/artwork, optional iTunes-style organization supporting both copy
and move with a preview, and stable records when users move files. Work on main,
isolated generated test data, focused checks, direct push; no release hardening.

## Behavior and boundaries

- Review advances through unsaved suggestion categories before advancing to the
  next unresolved game. A failed save stays on the current choice. Explicitly
  finishing a game resolves it; skipping ahead leaves it unresolved. Show checked,
  unresolved, reviewed and exact-auto-save counts separately.
- Saved metadata updates existing library sort/search projections; selected artwork
  updates cards. Exercise both with real local provider fixtures and no network.
- Organization defaults off. An owner chooses copy/move and a registered same-library
  destination, previews a server-derived System/Title/original-name path, and
  explicitly applies it. Reject collisions, stale plans and unsafe paths. Initial
  support is local single-file ROMs, excluding disc sets requiring descriptor edits.
- Move preserves source ID, selected metadata/artwork snapshots and matching revision.
  Copy leaves the original in place and gives the indexed copy its own record.
- Scans retain IDs for uniquely identifiable moves within the same registered root,
  using filesystem identity without opening ROM/cloud placeholder bytes. Ambiguous
  identity, cross-volume manual moves and missing identity never imply a merge.
  Detection happens on rescan; this does not introduce a filesystem watcher.

## Execution

1. Add failing review-flow browser/controller tests, implement progress and category/game
   advancement, prove selected metadata sorts and artwork renders on collection return.
2. Add migration and stat identity, test move/replacement/ambiguity and reopening catalogs.
3. Add owner-only organization preview/apply contract, constrained storage operations,
   client and shared UI; test generated copy/move/stale/collision/access cases.
4. Integrate, run affected checks and drift/boundaries/secrets, one focused risk review,
   commit/push the batch on main and confirm a clean synced checkout.

The scanner/database and organizer work have separate file ownership; the parent owns
review UI integration. No operator catalog or persistent service is used for acceptance.

## Delivery evidence

- Review-flow browser regression demonstrated RED before progress/advancement;
  integrated local-provider checks exercise metadata and artwork, failed-save
  retention, unresolved-game skipping, keyboard focus, ascending/descending sort
  and search using matched titles.
- Identity, migration and scan regressions demonstrated RED/GREEN for real moves,
  replacement/hardlink ambiguity, inferred-category changes, aliases and cycles.
- Organization API/storage tests cover both modes, owner/access boundaries,
  previews, stale/replaced files, extension retention, scan exclusion, catalog
  compensation and preservation of unexpected original bytes during finalization.
- An existing same-origin stale-session callback test exposed a disposed controller
  clearing a newer token; it failed before the inert-callback fix and now passes.
- Final focused server/database/storage/migration/matching suite: 47 passed.
  Web suite: 194 passed. Swift client: 7 passed via the Xcode toolchain. Web and
  desktop Svelte checks and UI builds pass; generated drift, boundaries and
  secret/fixture scan pass. Two final integrated browser checks passed for review
  and real copy/move completion. One focused risk review and follow-up approved.

Initial scope deliberately requires preview and explicit application, with no
unattended organizer. Passive move tracking is within a registered root on rescan;
manual cross-root/volume moves are not automatically reassociated. Single local
cartridge ROMs up to 512 MiB are eligible; copy can cross volumes, move cannot.
