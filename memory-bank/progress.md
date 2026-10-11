# Progress

## What works

- Versioned `/api/v1` contract with generated TypeScript and Swift models and a drift check.
- Content-addressed blob storage with idempotent placement, staging writes that truncate back to the committed offset on failure, and path containment that survives symlink escape.
- Single-range reads with strong ETags, `If-None-Match`, `If-Range`, 206, and 416. Multiple ranges are rejected.
- Resumable uploads with `baseRevision` completion and `Idempotency-Key` replay.
- Library roles, per-item grants, guest grants, and device tokens, all through one pure `authorize` function.
- Monotonic change cursor, mDNS advertisement, audit log without raw tokens, backup and restore.
- ZIP archives list their entries and serve single byte ranges per entry. Stored entries read from the container at an offset, deflated entries expand once into `virtual-cache`, and hostile entry counts, ratios, depth, forged sizes, and bad CRCs are refused.
- A ZIP inside a ZIP works, which is how ROM sets ship. Stored nested archives are read in place, so every inner entry is listed with its CRC-32 and size without inflating anything, and a nested entry is served as a byte range.
- Ordered numbered schema migrations. An existing catalog gains new tables without losing rows, and a database from a newer build is refused rather than opened.
- `pnpm ecs <command>` runs the CLI from a clean clone.
- Saved content roots. The owner registers absolute source folders through `/api/v1/roots`; the real path is recorded, a folder inside the data directory or overlapping a saved root is refused, and nothing is copied or written.
- `pnpm verify` and `swift test --package-path clients/swift` both green.

## What is left

| Brief | State |
| --- | --- |
| Virtual formats | ZIP done; disc containers not started |
| Scanning and metadata | Not started; needs a new `packages/scanner` |
| WebDAV compatibility | Not started; needs a new `packages/webdav` |
| Adversarial validation | Partially covered by existing storage and auth tests |
| Content roots | API and storage rules done; `ecs roots` CLI next |
| Storage locations | Briefed; not started |
| Service lifecycle | Briefed; not started |
| Desktop and menu-bar UI | Briefed with a `/ui` mount and a Tauri tray; not started |
| Remote access | Documentation pass not started; relay needs ADR 0005 first |
| App adapters | Belongs to the app repositories |
| Sideload and JIT | Deliberately excluded from this repository |

## Known issues and deferred work

- Unreferenced blob garbage collection is a later storage job. Deletion only removes catalog references.
- Multi-range responses are unimplemented by choice; `features.multiRange` reports `false`.
- No relay or NAT traversal. `features.natTraversal` reports `false` and no UPnP is shipped.
- Blobs live in one directory. Until storage locations land, the data directory is the only place content can go.
- A content root can be saved but nothing reads from one yet. Scanning and import belong to the scanner brief.
