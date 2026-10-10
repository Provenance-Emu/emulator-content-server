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

A request authenticates a bearer token, decides access with the pure ACL function, and only then opens a blob. Catalog changes append a monotonic cursor. Clients poll `GET /api/v1/changes`.

Virtual disc formats plug into `VirtualContentProvider`. ZIP is the only registered provider; disc containers follow one provider at a time. A ZIP stored inside another ZIP is a window into the same blob, so a ROM set shipped as an archive of per-game archives is listed and served without extraction. Original-file range reads are the supported streaming path.

Provenance system identifiers are a vocabulary, not a closed enum. iCube and iFly can send their own dotted identifiers. MD5 and CRC remain compatibility fields. SHA-256 is the blob identity.
