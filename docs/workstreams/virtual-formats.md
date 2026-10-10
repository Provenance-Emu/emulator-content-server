# Virtual formats

Serve a logical uncompressed view for clients that need random access inside a compressed container. ZIP is the first provider. Disc formats come after it, one provider per pull request.

## Owned paths

- `packages/storage` virtual providers
- `GET /api/v1/files/{id}/entries` response, which already returns `supported: false`
- capability `features.virtualFormats`
- tests using generated archives only

## Behavior

- Implement `VirtualContentProvider` and `MaterializeQuota`.
- Stored ZIP entries may map to source offsets.
- Deflated entries materialize once into an immutable cache blob, then range reads come from that blob.
- Enforce expanded size, compression ratio, entry count, nesting, and time. Budget entry count and expanded bytes across a nested tree, not per level.
- A ZIP stored inside a ZIP is a window into the same blob. Descend it in place and report inner CRC-32 and sizes without inflating, because ROM sets ship as archives of per-game archives. Expanding a compressed container needs an explicit request so listing stays cheap.
- CHD, RVZ, and the other Dolphin containers are separate providers. Do not import Dolphin reader source.

## Acceptance

- A small generated ZIP lists entries and serves a byte range of a stored entry.
- A hostile compression ratio is rejected before cache growth, including a recursive archive.
- A zip of zips lists every inner entry with its CRC and serves a byte range from one of them.
- Capabilities list `zip` only after the provider is registered.

## Non-goals

Transcoding to a new container, or claiming every disc format in one change.
