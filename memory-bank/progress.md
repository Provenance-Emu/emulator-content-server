# Progress

## What works

- Versioned `/api/v1` contract with generated TypeScript and Swift models and a drift check.
- Content-addressed blob storage with idempotent placement, staging writes that truncate back to the committed offset on failure, and path containment that survives symlink escape.
- Single-range reads with strong ETags, `If-None-Match`, `If-Range`, 206, and 416. Multiple ranges are rejected.
- Resumable uploads with `baseRevision` completion and `Idempotency-Key` replay.
- Library roles, per-item grants, guest grants, and device tokens, all through one pure `authorize` function.
- Monotonic change cursor, mDNS advertisement, audit log without raw tokens, backup and restore.
- `pnpm verify` and `swift test --package-path clients/swift` both green.

## In progress

ZIP virtual format provider: entry listing, direct offset reads for stored entries, one-time materialization for deflated entries, and quota enforcement before cache growth.

## What is left

| Brief | State |
| --- | --- |
| Virtual formats | ZIP in progress; disc formats not started |
| Scanning and metadata | Not started; needs a new `packages/scanner` |
| WebDAV compatibility | Not started; needs a new `packages/webdav` |
| Adversarial validation | Partially covered by existing storage and auth tests |
| Desktop and menu-bar UI | Not started |
| Remote access | Documentation pass not started; relay needs ADR 0005 first |
| App adapters | Belongs to the app repositories |
| Sideload and JIT | Deliberately excluded from this repository |

## Known issues and deferred work

- Unreferenced blob garbage collection is a later storage job. Deletion only removes catalog references.
- Multi-range responses are unimplemented by choice; `features.multiRange` reports `false`.
- No relay or NAT traversal. `features.natTraversal` reports `false` and no UPnP is shipped.
