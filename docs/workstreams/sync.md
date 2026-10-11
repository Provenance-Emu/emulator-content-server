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
- A save state or battery save never loses a write. When two devices write the same save, the later write wins the asset and the earlier one is kept as a conflict copy recorded against the same item, so a person can choose. Discarding a save is the one failure a sync must not have.
- A conflict copy is an ordinary asset with its own id, digest, and revision, so range reads, resume, ACL evaluation, and quotas are unchanged.
- Deletes stay tombstones so a device that was offline learns about them rather than resurrecting content.
- The client engine pages the feed by cursor, resumes a partial download with `planResume`, and retries an upload with the existing `Idempotency-Key` replay. It holds no emulator knowledge and parses no save format.

## Acceptance

- A device that uploads and then polls does not receive its own change.
- Two concurrent writes to one save leave two retrievable assets and neither digest is lost.
- A stale write to a ROM asset is still refused.
- A client resumes a half-downloaded asset with one ranged request instead of restarting.
- The feed stays monotonic, and replaying a cursor returns the same page.
- A guest credential sees no change it could not already read.

## Non-goals

Real-time push, a custom sync wire protocol, merging the contents of two saves, parsing emulator save formats, and resolving conflicts without telling the operator.
