# Storage

Blobs live at `blobs/sha256/<2-hex>/<64-hex>` under the data directory, or under another directory the operator has registered. A digest lives in exactly one of those directories. Uploads still land in `data/staging/<upload-id>` and are truncated to the committed received offset before hashing. Placement copies to a temporary sibling, fsyncs, renames, and fsyncs the directory on platforms that allow it. The virtual cache stays in the data directory, so an entry that has already been expanded can be read after the drive that holds the container is unplugged.

The database row is inserted after the blob file exists. Repeating placement for the same bytes is idempotent, so a crash between rename and the SQL commit can be retried. A `*.partial` file is not a blob address.

Range responses support one `bytes` range, including a suffix range. Multiple ranges are rejected. `ETag` is the strong quoted SHA-256. `If-None-Match` returns 304. `If-Range` uses strong comparison; a weak tag or date falls back to the full representation.

`MaterializeQuota` records the limits an archive provider must enforce: expanded size, compression ratio, entry count, nesting, and time. The ZIP provider reads the central directory and refuses a hostile archive before it writes anything, then re-checks the expanded byte count, the declared size, and the CRC while inflating, because every size in the central directory is a claim the archive makes about itself.

A stored entry is served from the container blob at its data offset, so no copy exists. A deflated entry expands once into `data/virtual-cache/<2-hex>/<64-hex>`, addressed by the SHA-256 of the container address and the entry id, written to a temporary sibling and renamed. Later range reads come from that cache blob.

## Nested containers

ROM sets ship as an archive of per-game archives, so a container is addressed by a dotted index path: `3.7` is entry 7 of the archive at entry 3. A nested archive is recognised structurally, by finding a local-header or end-record signature at the entry data, not by its file name. An entry that merely looks like an archive by extension is an ordinary opaque entry.

A stored nested archive is a window into the same blob, so its central directory is read in place. That yields every inner entry with its CRC-32 and uncompressed size without inflating anything, which is all a DAT matcher needs. Listing descends stored containers automatically because the cost is a four-byte probe and one directory read per container. Listing never expands a compressed container; descending one requires `GET /api/v1/files/{assetId}/entries?entry={entryId}`, so a cheap request never triggers expensive work.

Nesting cannot amplify a bomb. A stored container expands at a ratio of exactly one, so the per-entry ratio limit over an automatically enumerated tree is already the cumulative limit, and entry count and expanded bytes are budgeted across the whole tree rather than per level. A compressed container is bounded by the same ratio and expanded-size limits as any other entry before it is expanded at all, and container depth is hard-capped at `maxNesting`.

Deletion removes catalog references. Unreferenced blob garbage collection is a later storage job.
