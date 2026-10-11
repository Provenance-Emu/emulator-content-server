# Content roots

Record the operator's existing collection folders in the catalog so a scan has somewhere to read from. Registration copies nothing and the server never writes inside a root.

## Owned paths

- `packages/database` migration and root repository
- `packages/storage` containment helper for a root
- `packages/protocol` additive root operations
- `apps/server` root routes
- `apps/cli` `roots` command
- tests and `docs/operations`

## Behavior

- A root is an absolute existing directory with a label and an optional library binding. Several roots may be registered at once.
- Resolve the real path on registration and again on every use, because a directory can be replaced by a symlink after it is recorded.
- Reject a root that resolves inside the data directory, and reject one that contains or is contained by an existing root. Overlapping roots double-count the same file during a scan.
- Every path derived from a root is checked for containment against the resolved root. A symlink that escapes is refused at read time, not only at registration.
- Roots are read-only. No write, move, rename, or delete inside a root, including cleanup of files the scanner has already imported.
- Only the owner may list, add, or remove a root. A root path describes the operator's filesystem, so it stays hidden from guest credentials.
- Removing a root forgets the registration and leaves imported blobs alone, because those are already content-addressed copies.
- Requires the ordered migration runner. The catalog must open twice and keep existing rows.

## Acceptance

- A root is registered, listed, and removed, and the source directory is byte-identical afterward.
- A root inside the data directory is rejected, and so is one that overlaps an existing root.
- A symlink inside a root that points outside it is refused on read.
- A guest credential cannot list roots.
- An existing database gains the roots table without losing rows.

## Non-goals

Scanning and metadata inference, which belong to [Scanning and metadata](scanning-metadata.md). Writing into a root, watching for changes, and deleting originals after import.
