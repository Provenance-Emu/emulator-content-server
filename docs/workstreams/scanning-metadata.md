# Scanning and metadata

Add an opt-in, read-only scanner that proposes catalog items. It does not move or rename the operator's source directories.

## Owned paths

- `packages/scanner` (new)
- `apps/cli` scan command
- `apps/server` job routes
- tests and `docs/operations`

## Behavior

- `ecs scan --root <path>` reads only configured roots. Registering and persisting those roots belongs to [Content roots](content-roots.md).
- Hash with the existing storage hasher. Use SHA-256 for identity and MD5/CRC for compatibility.
- System inference may use extension and path hints. Unknown systems remain valid dotted identifiers.
- Results are proposals until the operator accepts an import into the content-addressed store.
- Artwork and metadata lookups are a second step and must record their source.

## Acceptance

- A temporary directory of generated files produces proposals and does not alter the source.
- A path outside the configured root is rejected.
- No copyrighted ROM fixture is committed.

## Non-goals

Automatic resorting, deletion of originals, and RetroAchievements password storage.
