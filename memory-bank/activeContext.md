# Active context

## Current focus

The ZIP virtual format provider has landed, the first entry in `docs/workstreams/virtual-formats.md`. Before it, `VirtualProviderRegistry` shipped with no providers, `features.virtualFormats` was `[]`, and `GET /api/v1/files/{assetId}/entries` always answered `supported: false`. The registry now carries `ZipProvider`, capabilities report `["zip"]`, and archive entries are listed and served as byte ranges.

## Recent changes

- The foundation landed as a single commit: contract, storage, access control, reference server, CLI, and generated clients.
- This Memory Bank was seeded from `AGENTS.md`, `README.md`, `docs/architecture/`, and `docs/workstreams/`. Those documents remain authoritative; this directory is a reading aid, not a second source of truth.
- ZIP support added `packages/storage/src/zip.ts` and `virtual-cache.ts`, two additive operations for entry content, and optional `format` and `items` fields on the entries response.

## Active decisions

- The entries response grows additively. `entries` stays an array of path strings so no existing client breaks; richer per-entry detail and the archive `format` arrive as new optional fields.
- Ranged reads of an archive entry get their own operation rather than overloading the existing content route.
- Stored (uncompressed) ZIP entries are read directly from the source blob at an offset. Deflated entries materialize once into `virtual-cache` as an immutable blob, and later range reads come from that blob.
- Quotas are checked from central-directory metadata before any bytes are written, so an archive bomb is rejected without the cache growing. Every path that can reach an entry applies the per-entry limits, because a client may ask for an entry by id without ever listing the archive.
- Nesting is supported because ROM sets ship as archives of per-game archives. A container is addressed by a dotted index path, recognised structurally rather than by file extension, and capped at `maxNesting`. A stored nested archive is a window into the same blob, so its entries and their CRCs are read without inflating anything.
- Listing descends stored containers automatically but never expands a compressed one; that needs `?entry=` on the entries route, which keeps a cheap request from triggering expensive work.
- CHD, RVZ, and the other Dolphin containers are separate providers in separate pull requests, and no Dolphin reader source is imported.

## Next steps

The remaining briefs in `docs/workstreams/`, each its own pull request: scanning and metadata, WebDAV compatibility, adversarial validation, desktop UI, and the remote-access documentation pass. App adapters belong to the Provenance, iCube, and iFly repositories.
