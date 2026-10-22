# Automatic organization and cross-folder move detection

User direction: opt-in automatic Copy/Move organization and move detection across
registered folders, preserving IDs and saved matches; isolated test data, focused
checks, direct main push, unreleased and no PR.

## Delivered design

- Folder policies default off and require an owner-confirmed file preview. Enabling
  does not process existing files. Future saved metadata/artwork/system matches
  trigger the existing validated organizer; settings can disable even empty roots.
- Copy owns one validated destination record and synchronizes later snapshots.
  Switching destinations/mode discards mappings, never files; disable/re-enable
  at the same destination retains ownership. Failures do not undo a saved match.
- Move defers while suggested local metadata/artwork are unsaved. Matching refreshes
  proposals after moves and uncertain committed saves, blocking stale writes.
- Migrations 13/14 retain missing sources internally and persist policies/copy
  ownership. Live source projections exclude missing records everywhere. Scans
  prove old-path absence on an online same-library root, lock sibling roots,
  reject ambiguous identities and preserve ID, snapshots and revision in either
  scan order. Root assignment/deletion uses the same exclusion.
- Detection remains rescan-based and requires a previously indexed filesystem
  identity. No cross-library or passive cross-volume guesses. Organizer keeps
  the existing local single-cartridge-ROM, <=512 MiB initial support boundary.

## Validation approach

Failing behavior tests precede implementation: both scan orders, matching proposal
refresh, default-off/explicit consent, owned-copy synchronization, and folder disable
UI. Regressions cover missing-path restoration, replacement/hardlink ambiguity,
offline roots, reopen/migrations, policy destination changes and unchanged ACLs.
Use focused server/database/storage and shared controller suites, browser acceptance,
Svelte checks/UI builds, generated drift, Swift client checks, boundaries/secrets,
and one proportionate risk review. No operator data or persistent service involved.

## Validation recorded

- New scan-order, proposal-refresh and folder-policy UI regressions demonstrated
  failures before their fixes. Cross-folder tests use real filesystem moves and
  isolated catalogs, with migration/reopen and snapshot/revision assertions.
- Final server/database focused suite: 70 passed. Shared web suite: 197 passed.
- Browser acceptance: automatic Copy opt-in/no-backlog/copy-snapshots/settings-off,
  and automatic Move metadata/artwork deferral/preserved identity/settings-off: 2 passed.
- Web/desktop Svelte checks and UI builds passed; Swift client 7 tests passed.
- Generated-client drift, package boundaries, secret/fixture scan, changed-file
  lint and diff checks passed. One risk review approved after fixes for missing
  path restoration and copy ownership across policy disable/destination changes.
