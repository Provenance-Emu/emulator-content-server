# Library experience

Goal: an app or the web page shows a household's games as a library with covers and details, without downloading a ROM, and the owner can see and steer scanning, matching, storage, and deletion without reading documentation.

This brief records an audit made on 2026-11-10 and the batches that follow from it. Each batch names the paths it may change. Tick a batch when it lands.

## Landed

- [x] Browse rows carry `artworkPath` and `details` (publisher, developer, year, genre, region, language, description), so a grid needs one request per page. `packages/protocol`, `packages/database`, `apps/server`.
- [x] Saved artwork answers with an `ETag` and `Cache-Control: private, no-cache`; an unchanged cover is a `304`. `apps/server/src/source-selections.ts`.
- [x] Compact collection toolbar; filters open as a panel. `apps/web`.
- [x] Light and dark themes with a saved choice. `apps/web`, `apps/tray` entry points.
- [x] Status page says why WebDAV is off.

## Findings that drive the remaining batches

**Client API.** `GET /api/v1/browse` is the list (keyset cursor, 100 per page, name search and sort, per-system counts). What still costs clients:

- No compression is registered in Fastify. JSON pages go out uncompressed.
- Covers are served at stored size only. There is no thumbnail or `width` parameter.
- Authentication is the Authorization header only, so plain image loaders cannot fetch a cover.
- Every browse page probes the filesystem once per row and writes presence back, and recomputes `systemCounts` on every page. Slow on a sleeping or network drive.
- Uploaded `Item` rows have no details and use a different artwork path (`previewAsset`) from scanned `source` rows.
- `clients/swift` has models for browse but no calls. Each app writes its own.
- Sort is by name only. No recently added, year, or genre.

**Scanning and matching.** A scan only walks folders. Matching is a second job, queued automatically afterwards for owner-triggered scans of online folders (`apps/server/src/library-jobs.ts`, `fillMissingDetails`). It works with the built-in providers and no plugins. It looks broken because:

- The automatic job is silent. Nothing in the interface says it was queued, is running, or was skipped. A conflict with a running job is swallowed and retried later; an unchanged library is not re-queued for 15 minutes.
- A scan started by a non-owner, including a folder watcher enabled by one, queues no matching.
- Providers fetch from `raw.githubusercontent.com` with 8-second timeouts. A job where every provider failed still ends `completed`.
- Ambiguous results go to review by design, and the results view opens on "Needs review", which reads as failure.
- Only the front cover is saved automatically.
- Scan and match controls live in a modal reachable only from inside one library. Settings has no entry for them. There are two activity histories (library jobs and cleanup runs), three ways to start a scan, and organization appears in three places. `BulkMatching.svelte` appears unused.

**WebDAV.** `features.webdav` is true only when the process starts with `--webdav` or `ECS_WEBDAV=1`. `scripts/install-server.sh` installs the service without it and the tray has no control for it.

**Storage.** `ContentReader` (`packages/domain`) is already stat, full read, and range read, with one file-backed implementation. `packages/plugins` has an S3 connector, a cloud connector, and a replication planner used by `ecs-plugins sync`, not by the server's read path. A blob lives in exactly one location; there is no mirror or tiering, and `storage-locations.md` lists replication as a non-goal today.

**Deleting.** Items and files are already soft-deleted (`deleted_at`), with no restore route, no trash view, and no purge. Removing a folder or a storage location deletes catalog rows only. Organization in move mode is the one path that removes a file from disk. There is no blob garbage collection.

**Pairing.** The existing flow is device-initiated: the device shows a PIN, the owner approves it in Settings → Devices, the device redeems a read-only token. The server never shows a QR code, and no QR encoder is in the repository. The page's content policy means a code must be drawn locally as SVG.

## Remaining batches

Each is independent unless it says otherwise.

- [ ] **Transfer cost.** Register response compression; make presence probing and `systemCounts` opt-out or first-page-only on browse; add a `libraryRevision` or ETag so an unchanged library is one cheap request. `apps/server`, `packages/protocol`. Adds a dependency.
- [ ] **Thumbnails.** A bounded `width` on the artwork route with resized variants cached on disk and their own ETag. `apps/server`, `packages/storage`. Needs an image library decision.
- [ ] **Swift catalog calls.** `libraries()`, `browse(...)`, `artworkRequest(...)` beside `ContentSync`, built on the generated models. `clients/swift`. The app screens themselves belong in the Provenance, iCube, and iFly repositories.
- [ ] **Cover loading without a header.** A short-lived signed cover URL. Changes an authentication guarantee, so it needs a decision and one review. `packages/auth`, `apps/server`, `packages/protocol`.
- [x] **One "Scans and details" screen.** Settings → Scans & details shows library totals, scan and matching actions, and watch and organization controls for each folder. The activity section shows scans and matching jobs alongside cleanup history and review for the selected library or unassigned folders. `GET /api/v1/library-jobs/overview` backs the folder summary, and match jobs report `providerFailures`.
- [ ] **Retire the unused `BulkMatching.svelte` panel.** Preserve the checksum helper used by the current matching tools.
- [ ] **WebDAV as a setting.** A saved owner toggle instead of a start flag, or the installer and tray pass the flag. `apps/cli`, `apps/server`, `apps/tray`, `scripts/install-server.sh`.
- [ ] **Trash and undo.** New migration adding `deleted_by` and `purge_after`; restore routes for items and files; a trash list; a retention job that also collects unreferenced blobs; an Undo toast and a Trash section in the page. `packages/database`, `apps/server`, `packages/protocol`, `apps/web`.
- [ ] **Add a server by QR.** Owner-side invite: a one-time code with a short expiry, shown as a locally drawn QR that carries the server id, its addresses, and the code, never a token. The app redeems it for a revocable device token. `packages/auth`, `apps/server`, `packages/protocol`, `apps/web`, then the apps.
- [ ] **Remote sources and a cold mirror.** A design first: where remote reads run given that operator-installed code stays out of the HTTP process, how credentials are stored, a `blob_replicas` table, verify-by-hash, eviction policy, and restore on read. Dropbox and Google Drive need OAuth apps registered by the project.
- [ ] **Cheats, patches, and hacks.** Cheat and patch providers exist and save associations; cheats are saved disabled and patches are never applied. There is no browsing, discovery, or sync surface for them. Needs a product description before a design.
- [ ] **Web page look.** Tokens now exist for both themes. Still open: matching the apps' layouts and components beyond colour, icons, cover-first cards, and the player page, which keeps its own dark stylesheet.
