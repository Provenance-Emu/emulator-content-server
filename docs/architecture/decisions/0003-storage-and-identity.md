# ADR 0003: SQLite metadata and SHA-256 blobs

Metadata is SQLite. Bytes are content-addressed files. This is a single-node server, so PostgreSQL is unnecessary for the foundation.

SHA-256 identifies a blob and is the strong ETag. MD5 and CRC are optional compatibility fields because emulator databases and RetroAchievements still use them. They are not integrity credentials.

Item updates require `If-Match: "rev-N"`. Upload completion requires `baseRevision`. A stale writer gets 409 instead of a silent overwrite.

## Consequences

- Backup is `VACUUM INTO` plus a copy of the blob directory.
- Crash recovery retries blob placement and then commits metadata.
- A later garbage collector may delete unreferenced blobs. The foundation does not delete them automatically.
