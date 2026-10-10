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

Virtual disc formats plug into `VirtualContentProvider`. The registry ships empty. Original-file range reads are the supported streaming path.

Provenance system identifiers are a vocabulary, not a closed enum. iCube and iFly can send their own dotted identifiers. MD5 and CRC remain compatibility fields. SHA-256 is the blob identity.
