# Trash and undo

Status: approved 2026-11-16 and built. Batch "Trash and undo" in `docs/workstreams/library-experience.md`.

## Problem

Deleting a game or a file already sets `deleted_at` and hides the row, but nothing can bring it back, nothing shows what was deleted, and nothing ever removes the row or its bytes. The web page has no delete action at all, so the only callers today are apps and the API. "Never lose anything" needs an undo; disk space needs an end to the retention.

## What is in the trash

- **Games** (`items`) and **files** (`assets`) that were uploaded to the server and deleted through `DELETE /api/v1/items/{id}` or `DELETE /api/v1/files/{id}`.
- Not games that live in a watched folder (`source_files`). The server never deletes those bytes; removing a folder only forgets catalog rows, and adding it again finds them. Not libraries, storage locations, or accounts.

Deleting a game deletes its files in the same transaction with the same timestamp. The trash shows that as one entry, the game. A file deleted on its own is its own entry.

## Decisions

### Retention: 30 days, fixed

`purge_after` is written on the row at delete time as `deleted_at + 30 days`. Storing it on the row means a later change to the default never shortens a promise already shown to the owner. No setting in this batch: it works without being configured. `GET /api/v1/capabilities` gains `trash: { retentionDays: 30 }` so apps can say the same thing.

Rows already soft-deleted before the migration get `purge_after = migration time + 30 days`, not `deleted_at + 30 days`, so nothing disappears the moment the server is upgraded. Their `deleted_by` stays null.

Bytes in the trash do not count toward the library quota (already true: `librarySize` counts live rows only).

### Who may see and restore

The same rule as deleting: a signed-in account with write access to the game. The server owner sees everything. The trash list returns only entries the caller could restore. Guest grants cannot list or restore; a grant is a narrow, expiring link and should not be able to browse deleted content.

`deleted_by` stores the actor id (user id, or grant id when a guest grant deleted). It is plain text without a foreign key because grants and users are different tables. The list resolves it to a display name when it is a user.

### Restore

- **Game.** Clears `deleted_at`, `deleted_by`, `purge_after` on the item and on the files whose `deleted_at` equals the item's, the ones that went with it. A file deleted on its own before the game stays in the trash as its own entry.
- **File.** Requires its game to be live; otherwise `409` "Restore the game first". If a live file now has the same path, the restored file comes back as a conflict copy of it (the existing `conflict_of` flow), so neither is overwritten.
- Restoring past the library quota is `413`, same as an upload.
- Restore is idempotent: restoring something that is already live returns it.
- Sync: restore writes ordinary `upsert` changes for the game and each returned file. No new change operation; a client that saw the delete sees the row again.
- Audit: `restore-item`, `restore-asset`.

### Purge

A retention job in `apps/server` runs once after start and then hourly (unref'd timer, same shape as workflow artifact collection). In bounded batches, in one transaction per batch, it:

1. Deletes file rows with `deleted_at IS NOT NULL AND purge_after <= now`.
2. Deletes game rows with the same condition that have no file rows left, along with their per-game access rows, the guest grants that name the game, and those grants' upload rows (a grant must not be widened to the library by clearing its game). Staging files of uploads that were still open are removed. Conflict references to a purged file are cleared.
3. Writes one `purge` audit row per game or file, with no names or hashes in the details.

A purge is the only step that cannot be undone. Nothing else in this batch deletes a row. There is no "empty trash" or "delete forever" button in this batch (see open questions).

### Blob garbage collection

Runs only after the purge step, and only looks at blobs.

- **Candidate rule.** A blob is collectable only when no `assets` row references it at all, live or in the trash. A trashed file therefore always keeps its bytes, and restore never depends on luck.
- **No interleaving with uploads.** Completing an upload places the bytes and then inserts the rows; a collection between those two steps would leave a file row pointing at nothing. Upload completion and blob collection share one in-process gate: collection waits for in-flight completions and completions wait for the current small batch. The server is the only writer of a data directory.
- **Order.** Under the gate: re-check zero references, unlink the file, then delete the `blobs` row. A crash between the two leaves a row with no file and no references; the next run sees `ENOENT` and removes the row. A re-upload of the same content in that window re-places the bytes. If the unlink fails (Windows with an open handle, read-only disk) the row stays and the next run retries.
- **Offline locations.** Blobs in a storage location that is not reachable are skipped, not forgotten.
- **Not touched.** Staging files, CHD and virtual caches, artwork, watched folders, backups. A backup that finished before a purge still holds the bytes. `ecs backup` copies bytes before it snapshots the catalog, then copies anything uploaded in between, so a purge during a backup cannot leave a saved row without its bytes.
- Path containment: the unlink path comes from `blobPath(root, sha256)` for a digest read from the catalog, never from a request.

Access is decided before any storage call on every route; the job has no request and acts only on rows already past `purge_after`.

## Database

Migration 23:

```sql
ALTER TABLE items ADD COLUMN deleted_by TEXT;
ALTER TABLE items ADD COLUMN purge_after TEXT;
ALTER TABLE assets ADD COLUMN deleted_by TEXT;
ALTER TABLE assets ADD COLUMN purge_after TEXT;
UPDATE items SET purge_after = <now + 30d> WHERE deleted_at IS NOT NULL;
UPDATE assets SET purge_after = <now + 30d> WHERE deleted_at IS NOT NULL;
CREATE INDEX items_trash ON items(deleted_at, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX assets_trash ON assets(deleted_at, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX assets_blob ON assets(sha256);
```

Repository methods in `packages/database` (`trash.ts`): `listTrash`, `restoreItem`, `restoreAsset`, `purgeExpired`, `unreferencedBlobs`, `blobReferenced`, `forgetBlob`. Deleting a game stamps it strictly later than any file of it deleted earlier, because the shared timestamp is what ties a game to the files that went with it. `deleteItem` and `deleteAsset` start writing the two new columns.

## Contract (additive, v1)

| Operation | Result |
| --- | --- |
| `GET /api/v1/trash?libraryId=&cursor=&limit=` | `{ entries: TrashEntry[], nextCursor }`, newest first |
| `POST /api/v1/items/{itemId}/restore` | the `Item` |
| `POST /api/v1/files/{assetId}/restore` | the `File` |

`TrashEntry`: `kind` (`item` or `file`), `id`, `name`, `libraryId`, `itemId`, `itemTitle`, `systemIdentifier`, `size` (bytes that come back), `fileCount`, `deletedAt`, optional `deletedBy` (`{ id, name? }`), `purgeAfter`, `itemDeleted`.

`Capabilities` gains optional `trash.retentionDays`.

## Web

- **Delete actions** (new, there are none today): "Move to trash" on an uploaded game's detail page and on each of its files. No confirmation dialog, because it is reversible.
- **Undo toast**: "Moved *Name* to trash." with an **Undo** button, shown for about 8 seconds, `role="status"`. Undo calls restore. One small shared toast component; none exists yet.
- **Settings → Trash**: a panelled page. "Deleted games and files are kept for 30 days, then removed for good." Each row: cover or icon, name, "game" or "file", who deleted it, "12 days left", **Restore**. Empty state: "Nothing in the trash." Identifiers stay behind the existing details disclosure pattern.

## Tests (written first, generated bytes only)

- Database: migrate a version-22 catalog with live and soft-deleted rows; rows survive, soft-deleted rows get `purge_after`; second open changes nothing.
- Database: restore a game returns only the files deleted with it; restore a file under a deleted game is refused; path collision yields a conflict copy; purge removes only rows past `purge_after`.
- Server: restore requires write access and a user (reader `403`, guest grant `403`, anonymous `401`); restored file bytes read back identical; after purge the blob shared with a live file stays, the unshared blob file is gone; a blob still referenced from the trash is never collected; a crash-shaped state (row, no file) heals.
- Web: toast store and trash list unit tests; `svelte-check`.

## Out of scope

Deleting watched-folder games from disk, restoring removed folders or libraries, a retention setting, sweeping orphan files that have no `blobs` row, app screens in Provenance, iCube, and iFly.

## Open questions

1. **"Delete forever" / "Empty trash".** Left out: it is the one irreversible action and the batch does not ask for it. An owner short on disk waits up to 30 days. Add it later behind an explicit confirmation if wanted.
2. **Retention length.** 30 days is a guess at a household default. 7 or 14 frees disk sooner; 30 matches what phones and desktops do.
