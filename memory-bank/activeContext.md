# Active context

## Current focus

Saved folders, a web interface, a login-time daemon, and a tray widget. ZIP virtual formats landed first and are described below.

The catalog could not be upgraded before this work: `migrate()` applied one monolithic schema and otherwise hard-failed when the recorded version did not equal `SCHEMA_VERSION`, so adding any table would have broken every database on disk. It now applies ordered numbered migrations, which unblocks every feature that has to persist new rows.

## Recent changes

- The foundation landed as a single commit: contract, storage, access control, reference server, CLI, and generated clients.
- This Memory Bank was seeded from `AGENTS.md`, `README.md`, `docs/architecture/`, and `docs/workstreams/`. Those documents remain authoritative; this directory is a reading aid, not a second source of truth.
- ZIP support added `packages/storage/src/zip.ts` and `virtual-cache.ts`, two additive operations for entry content, and optional `format` and `items` fields on the entries response.
- A root `pnpm ecs` script wraps the CLI, because the documented `pnpm --filter ... exec ecs` start path never worked; pnpm does not link a workspace package's own bin.
- Three new briefs: `content-roots.md`, `storage-locations.md`, and `service-lifecycle.md`. `desktop-ui.md` gained the `/ui` mount and the Tauri tray.
- `packages/database` now runs ordered migrations from a `MIGRATIONS` list, with `pendingMigrations` as the pure selection function.

## Active decisions

- The entries response grows additively. `entries` stays an array of path strings so no existing client breaks; richer per-entry detail and the archive `format` arrive as new optional fields.
- Ranged reads of an archive entry get their own operation rather than overloading the existing content route.
- Stored (uncompressed) ZIP entries are read directly from the source blob at an offset. Deflated entries materialize once into `virtual-cache` as an immutable blob, and later range reads come from that blob.
- Quotas are checked from central-directory metadata before any bytes are written, so an archive bomb is rejected without the cache growing. Every path that can reach an entry applies the per-entry limits, because a client may ask for an entry by id without ever listing the archive.
- Nesting is supported because ROM sets ship as archives of per-game archives. A container is addressed by a dotted index path, recognised structurally rather than by file extension, and capped at `maxNesting`. A stored nested archive is a window into the same blob, so its entries and their CRCs are read without inflating anything.
- Listing descends stored containers automatically but never expands a compressed one; that needs `?entry=` on the entries route, which keeps a cheap request from triggering expensive work.
- CHD, RVZ, and the other Dolphin containers are separate providers in separate changes, and no Dolphin reader source is imported.
- Migration 1 keeps its exact shipped SQL. The runner recognises a new database by the absence of the `schema_migrations` table, which is why migration 1 can still create that table itself.
- A ledger holding anything other than a contiguous prefix of the known versions is a hard error. That covers a newer build's database, a gap, and an emptied ledger, because guessing which statements are missing would risk the operator's rows.
- "Multiple folders" is two features. Content roots are read-only source directories to import from; storage locations are additional writable blob stores. They touch different packages and ship separately.
- Staging and the virtual cache stay in the primary data directory even once storage locations exist, so an unplugged drive cannot hold a half-finished upload.
- The web UI is static assets mounted under `/ui` on the same origin as the API, which keeps CORS out of the design. The tray is one Tauri application and holds no storage path.
- Auto-start installs a per-user agent, never a root service, because the data directory and `bootstrap.token` are user-owned at mode `0600`.
- The maintainer works on branches or worktrees and does not use pull requests here. `CONTRIBUTING.md` still describes the fork-and-pull path for outside contributors.

## Next steps

In order, each its own commit: content roots, storage locations, the `roots` and `locations` CLI commands, the web UI under `/ui`, the service registrations, then the Tauri tray.

Still unstarted elsewhere in `docs/workstreams/`: scanning and metadata, WebDAV compatibility, adversarial validation, and the remote-access documentation pass. App adapters belong to the Provenance, iCube, and iFly repositories.
