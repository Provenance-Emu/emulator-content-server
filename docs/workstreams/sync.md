# Sync

Several devices converge on the same library without losing a save. The server stays the source of truth and clients poll the existing change cursor. No new wire protocol.

## Owned paths

- `packages/database` migration and change-feed queries
- `packages/protocol` additive change fields
- `apps/server` change and upload routes
- `packages/client-ts` sync engine
- tests, `docs/operations`, `docs/compatibility`

## Behavior

- Every change records the device that caused it, and a client can ask the feed to omit its own. A device that re-downloads what it just uploaded never settles, so the echo filter is what makes polling usable.
- Device identity comes from the device token already issued. A plain session is attributed to no device and sees the whole feed, which keeps the web UI and the tray unaffected.
- ROM, BIOS, and disc assets keep strict optimistic concurrency. A stale `baseRevision` is still a conflict and the client refetches.
- A save state or battery save never loses a write. When one arrives against a stale revision, the asset already at that path stays live and untouched, and the arriving write lands beside it as a conflict copy carrying a `conflictOf` pointer. Neither digest is lost and a person chooses.
- The live asset is not demoted in favour of the newer arrival. Arrival order is not play order, so promoting either one would be a guess, and rewriting a live asset would change the manifest under a device that is already downloading it.
- A stale write to a path where nothing is live is accepted exactly where it was asked for, because a stale revision alone is not a conflict. The collision at a path is.
- A conflict copy is an ordinary asset with its own id, digest, and revision, so range reads, resume, ACL evaluation, and quotas are unchanged.
- Deletes stay tombstones so a device that was offline learns about them rather than resurrecting content.
- The client engine pages the feed by cursor, resumes a partial download with `planResume`, and retries an upload with the existing `Idempotency-Key` replay. It holds no emulator knowledge and parses no save format.
- A resumed download sends `If-Range` with the ETag the local bytes came from, so content that changed underneath restarts instead of appending bytes from a different asset onto a half-finished file.
- An interrupted upload reads its committed offset from `GET /api/v1/uploads/{uploadId}` rather than assuming the failed attempt wrote nothing. A client that guesses either re-sends bytes the server already has, which the gap check refuses, or skips bytes it never sent.
- The engine stores nothing itself. It hands back the response body and takes bytes in, so the same code serves a phone, a desktop, and the web UI.

## Acceptance

- A device that uploads and then polls does not receive its own change.
- Two concurrent writes to one save leave two retrievable assets and neither digest is lost.
- A stale write to a ROM asset is still refused.
- A client resumes a half-downloaded asset with one ranged request instead of restarting.
- The feed stays monotonic, and replaying a cursor returns the same page.
- A guest credential sees no change it could not already read.

## Non-goals

Real-time push, a custom sync wire protocol, merging the contents of two saves, parsing emulator save formats, and resolving conflicts without telling the operator.
