# Architecture

The content server is a single-node household library. SQLite in WAL mode stores metadata. The filesystem stores immutable blobs addressed by SHA-256. Fastify exposes `/api/v1`. The CLI is the supported process entry.

```text
CLI / Docker
    |
    v
Fastify routes ---- auth decision ---- catalog repository ---- SQLite
        |                                      |
        +----------- storage ------------------+
                    blobs, staging, range reads
```

A request authenticates a bearer token, decides access with the pure ACL function, and only then opens a blob. Catalog changes append a monotonic cursor. Clients poll `GET /api/v1/changes`, and `@ecs/client` walks that cursor until a page stops advancing it. A write made with a device token records that device, and `?excludeOwnDevice=1` omits those rows, so a device that uploads does not turn around and download its own write. The device is taken from the token rather than the query, and a change with no device, such as the one bootstrap writes, stays visible to everyone.

Virtual disc formats plug into `VirtualContentProvider`. ZIP is the only registered provider; disc containers follow one provider at a time. A ZIP stored inside another ZIP is a window into the same blob, so a ROM set shipped as an archive of per-game archives is listed and served without extraction. Original-file range reads are the supported streaming path.

Provenance system identifiers are a vocabulary, not a closed enum. iCube and iFly can send their own dotted identifiers. MD5 and CRC remain compatibility fields. SHA-256 is the blob identity.

Connectors, a wasm player, AltStore sources, and JIT or signing plans are plugins in a second process. That process calls this API. It does not open the database or the blob directory, and `/api/v1/capabilities` does not mention it. See [ADR 0007](decisions/0007-plugin-host.md).
