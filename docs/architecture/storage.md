# Storage

Blobs live at `data/blobs/sha256/<2-hex>/<64-hex>`. Uploads land in `data/staging/<upload-id>` and are truncated to the committed received offset before hashing. Placement copies to a temporary sibling, fsyncs, renames, and fsyncs the directory on platforms that allow it.

The database row is inserted after the blob file exists. Repeating placement for the same bytes is idempotent, so a crash between rename and the SQL commit can be retried. A `*.partial` file is not a blob address.

Range responses support one `bytes` range, including a suffix range. Multiple ranges are rejected. `ETag` is the strong quoted SHA-256. `If-None-Match` returns 304. `If-Range` uses strong comparison; a weak tag or date falls back to the full representation.

`MaterializeQuota` records the limits an archive provider must enforce: expanded size, compression ratio, entry count, nesting, and time. The ZIP provider reads the central directory and refuses a hostile archive before it writes anything, then re-checks the expanded byte count, the declared size, and the CRC while inflating, because every size in the central directory is a claim the archive makes about itself. A nested archive is refused.

A stored entry is served from the container blob at its data offset, so no copy exists. A deflated entry expands once into `data/virtual-cache/<2-hex>/<64-hex>`, addressed by the SHA-256 of the container address and the entry index, written to a temporary sibling and renamed. Later range reads come from that cache blob.

Deletion removes catalog references. Unreferenced blob garbage collection is a later storage job.
