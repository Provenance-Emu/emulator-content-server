# Active context

## Current focus

The ZIP virtual format provider, the first entry in `docs/workstreams/virtual-formats.md`. Before this change `VirtualProviderRegistry` shipped with no providers, `features.virtualFormats` was `[]`, and `GET /api/v1/files/{assetId}/entries` always answered `supported: false`.

## Recent changes

- The foundation landed as a single commit: contract, storage, access control, reference server, CLI, and generated clients.
- This Memory Bank was seeded from `AGENTS.md`, `README.md`, `docs/architecture/`, and `docs/workstreams/`. Those documents remain authoritative; this directory is a reading aid, not a second source of truth.

## Active decisions

- The entries response grows additively. `entries` stays an array of path strings so no existing client breaks; richer per-entry detail and the archive `format` arrive as new optional fields.
- Ranged reads of an archive entry get their own operation rather than overloading the existing content route.
- Stored (uncompressed) ZIP entries are read directly from the source blob at an offset. Deflated entries materialize once into `virtual-cache` as an immutable blob, and later range reads come from that blob.
- Quotas are checked from central-directory metadata before any bytes are written, so an archive bomb is rejected without the cache growing.
- Nested archives are rejected in this first provider. CHD, RVZ, and the other Dolphin containers are separate providers in separate pull requests, and no Dolphin reader source is imported.

## Next steps

The remaining briefs in `docs/workstreams/`, each its own pull request: scanning and metadata, WebDAV compatibility, adversarial validation, desktop UI, and the remote-access documentation pass. App adapters belong to the Provenance, iCube, and iFly repositories.
