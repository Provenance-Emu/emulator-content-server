# Media availability

Files on an external disk, a network share, or iCloud stay where they are until a client asks for those bytes. Clients can tell a file that is here from a placeholder and from a disk that is not connected.

This is not [Storage locations](storage-locations.md). That brief is about where copies the server already owns are kept. A content root remains a folder the server reads and does not write.

## Owned paths

- `packages/storage` volume probe
- `packages/database` migration for source files
- `packages/protocol` additive root fields, source files, and problem types
- `apps/server` root reporting and the source content route
- `packages/client-ts`, `clients/swift`, `apps/web`
- tests

## Behavior

- Each root is classified when it is listed and again when a file from it is read. The medium is `internal`, `removable`, `network`, or `icloud`. A path under `/Volumes` that is not the system disk, a Linux path under `/media` or `/run/media`, or a Windows drive that is not fixed, is removable. A mount that is not local is network. A path inside iCloud Drive or another file provider is `icloud`.
- The registration is kept when the volume is unplugged or the share is unmounted. The state becomes `offline`. Connecting it again makes the same files available.
- A file is `local` when its bytes are on this machine, `evicted` when it still has a name and a size but no allocated blocks, and `offline` when its volume is gone. Listing uses `stat` only. An evicted file is never opened, because opening it would start a provider download.
- Readers do not see the path. They see `availability` on a source file. Source files are an optional `sources` list on the manifest, separate from assets, because an asset's digest stays required and an unread file has no digest yet.
- A content read of a `local` source streams from the root and copies nothing into the blob store. `evicted` and `offline` are distinct errors, and neither one is a 404.
- A volume appearing or disappearing writes the affected files to the change feed.
- The sync engines download a `local` file when that game is opened. `evicted` and `offline` files stay names.

## Acceptance

- An unplugged root stays registered and is reported offline, and the primary data directory is unaffected.
- A file with a size and zero allocated blocks on a file-provider volume is `evicted`, and the probe does not open it.
- A local source file is readable as a byte stream. An evicted or offline one is refused with its own problem type.
- A guest credential still cannot list root paths.
- An existing database gains the new table without losing rows.

## Non-goals

Copying a drive into the data directory, background downloads, scanning for titles, and cloud object storage.
