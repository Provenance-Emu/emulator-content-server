# Active context

## Current focus

Complete the included 1.0 work and record acceptance. Saved folders, the web/tray
interfaces, login-service registration and tray controls (#11), owner storage UI
(#12), and opt-in authenticated read-only WebDAV (#13) are implemented. Disc
containers now have an opt-in CHD v5 provider for DVD ISO and supported CD CUE/BIN,
and the browser player is implemented separately. Real browser-core compilation,
emulation, rendering, audio, input, and save acceptance remain unverified.

The catalog could not be upgraded before this work: `migrate()` applied one monolithic schema and otherwise hard-failed when the recorded version did not equal `SCHEMA_VERSION`, so adding any table would have broken every database on disk. It now applies ordered numbered migrations, which unblocks every feature that has to persist new rows.

## Recent changes

- Remote-access guidance now covers Tailscale/WireGuard, `token` mode, binding to
  a VPN interface, and a private reverse-proxy backend using
  `--public --tls-terminated`. Forwarded headers do not grant trust. No relay or
  CORS change was introduced. See [Remote access](../docs/operations/remote-access.md).
- Adversarial tests now cover upload Content-Range bounds, rejected-chunk
  integrity, guest-grant revocation escalation, idempotency body mismatch, and
  HTTP multi-range/unsatisfiable requests in addition to prior hostile cases.
- The tray can start/stop the local user's registered service. The owner web UI
  can register storage locations and select a write target. WebDAV now serves
  read-only catalog/source listings and ranges with bearer or Digest credentials.
- The menu bar edits accounts, guest links, and who may connect. Local networks are trusted by default. This Mac can change accounts without a password. Other devices on the LAN can sync, and they cannot change accounts. `token` mode requires a login everywhere. A server started with `--public` never trusts the socket address.
- The foundation landed as a single commit: contract, storage, access control, reference server, CLI, and generated clients.
- This Memory Bank was seeded from `AGENTS.md`, `README.md`, `docs/architecture/`, and `docs/workstreams/`. Those documents remain authoritative; this directory is a reading aid, not a second source of truth.
- ZIP support added `packages/storage/src/zip.ts` and `virtual-cache.ts`, two additive operations for entry content, and optional `format` and `items` fields on the entries response.
- A root `pnpm ecs` script wraps the CLI, because the documented `pnpm --filter ... exec ecs` start path never worked; pnpm does not link a workspace package's own bin.
- Three new briefs: `content-roots.md`, `storage-locations.md`, and `service-lifecycle.md`. `desktop-ui.md` gained the `/ui` mount and the Tauri tray.
- `packages/database` now runs ordered migrations from a `MIGRATIONS` list, with `pendingMigrations` as the pure selection function.

## Active decisions

- The entries response grows additively. `entries` stays an array of path strings so no existing client breaks; richer per-entry detail and the archive `format` arrive as new optional fields.
- Ranged reads of an archive entry get their own operation rather than overloading the existing content route.
- Stored (uncompressed) ZIP entries are read directly from the source blob at an offset. Deflated entries materialize once into `virtual-cache` as an immutable blob, and later range reads come from that blob.
- Quotas are checked from central-directory metadata before any bytes are written, so an archive bomb is rejected without the cache growing. Every path that can reach an entry applies the per-entry limits, because a client may ask for an entry by id without ever listing the archive.
- Nesting is supported because ROM sets ship as archives of per-game archives. A container is addressed by a dotted index path, recognised structurally rather than by file extension, and capped at `maxNesting`. A stored nested archive is a window into the same blob, so its entries and their CRCs are read without inflating anything.
- Listing descends stored containers automatically but never expands a compressed one; that needs `?entry=` on the entries route, which keeps a cheap request from triggering expensive work.
- Disc support is opt-in through an explicitly configured operator-owned chdman.
  CHD v5 DVD ISO and the bounded modern CHT2 CD CUE/BIN subset are implemented;
  ZIP remains the default. Native macOS 0.289 generated round trips are verified.
  Linux/Windows native and browser disc-core acceptance remain unverified. See
  [CHD operations](../docs/operations/chd.md) for supported layouts and limits.
- Migration 1 keeps its exact shipped SQL. The runner recognises a new database by the absence of the `schema_migrations` table, which is why migration 1 can still create that table itself.
- A ledger holding anything other than a contiguous prefix of the known versions is a hard error. That covers a newer build's database, a gap, and an emptied ledger, because guessing which statements are missing would risk the operator's rows.
- "Multiple folders" is two features. Content roots are read-only source directories to import from; storage locations are additional writable blob stores. They touch different packages and ship separately.
- Staging and the virtual cache stay in the primary data directory even once storage locations exist, so an unplugged drive cannot hold a half-finished upload.
- The web UI is static assets mounted under `/ui` on the same origin as the API, which keeps CORS out of the design. The tray is one Tauri application and holds no storage path.
- Auto-start installs a per-user agent, never a root service, because the data directory and `bootstrap.token` are user-owned at mode `0600`.
- A content root is owner-only in both directions: the path describes the operator's filesystem, so a reader or editor cannot even list roots.
- Roots are not written to `change_log`. They are server configuration rather than synced content, so they stay out of the client change feed and are recorded in the audit log instead.
- `resolveContentRoot` holds every path rule in one place and takes the saved paths as plain strings, which keeps `packages/storage` free of the catalog while the server and the CLI share the same validation.
- The CLI attributes local changes to a `cli` actor rather than to the owner account, because whoever can read the data directory ran them, and it also works before bootstrap when no owner exists.
- `apps/cli` deliberately does not depend on `@ecs/domain`. `scripts/check-boundaries.mjs` matches the dependency list exactly, and widening the boundary for a type annotation was not worth it, so the CLI infers record types and throws plain errors.
- Signing and JIT may live in this repository after all, because another repository costs more to maintain than the repository boundary was buying. What protects the operator is the process, database, and credential split, which the boundary check can enforce. ADR 0006 records the reversal and `SECURITY.md` now promises the narrower, true thing.
- The echo filter derives the device from the authenticated token, never from a query parameter, so one device cannot ask the server to hide another device's changes. The device id is not returned in the feed either, because peers do not need to know which device wrote what.
- The tray builds its menu in TypeScript, so the dropdown and status window read
  the same client and component. Rust provides the shell and a restricted local
  service-control bridge; it holds no API credential and opens no catalog.
- A folder is chosen by browsing the server, not with a file input. The folder lives on the server, which is often not the machine holding the browser, and a file input cannot report an absolute path anyway. The listing returns directory names only, to the owner only, and typing a path still works for a server reached over a terminal.
- The web page stores its bearer token rather than using a cookie, because a cookie would be attached to every request automatically and that is what makes CSRF possible. A content policy that forbids other origins, inline script, and outbound connections is what makes storing it acceptable.
- Save sync keeps both writes, because discarding a save is the one failure a sync must not have. The live asset is left alone and the arriving write becomes the conflict copy. That is the opposite of promoting the newer arrival: arrival order is not play order, and rewriting a live asset would change the manifest under a device that is mid-download. ROM, BIOS, and disc assets keep strict optimistic concurrency.
- A conflict is a collision at a relative path, not merely a stale revision. A stale write to a path where nothing is live is accepted where it was asked for.
- Transfers from the page go through the engine in `@ecs/client`, not through code written for the browser. `upload` gained piece-sized sends so progress exists and a break costs one piece, and `collect` assembles a download in memory and resumes from the bytes that arrived. Both are tested against the real routes in `apps/server/test/engine.test.ts` with a fetch that cuts a body short.
- A file input is right for an upload and wrong for a content folder: the first is bytes to send, the second a path the server has to resolve on a machine that may not be the one holding the browser.
- The static mount uses a wildcard route. With one route per file discovered at startup, a rebuilt bundle 404s with its new hashed name until the server restarts.
- The secret scan walks what git would commit rather than the whole tree, because the Rust target directory is full of `.bin` incremental output that the fixture rule rejects.
- Choosing a save is a metadata swap. A current-revision save upload becomes the live file and the previous bytes are renamed beside it. `POST /api/v1/files/{id}/adopt` does the same for a conflict copy already on the server, so the page does not re-upload the bytes. The manifest carries `conflictOf` so a client can pair them.
- The web page groups an item's files by kind and polls the change feed, so a save that arrived from a phone shows up. The Swift package now has the same feed, resume, and adopt calls the TypeScript engine has. App screens that render them stay in the app repositories.
- JIT, when sideload resumes, splits by OS. iOS 26 and later blesses each 16 KB page with a debugger write, the protocol RetroArch's `lldb_jit_bless.py` and StikDebug share. Older iOS and tvOS attach `debugserver` the way SideStore and AltStore do.

## Next steps

Record acceptance for the implemented CHD provider and
[browser player](../docs/workstreams/web-playback.md). Native CHD on Linux/Windows,
browser disc cores, and real browser-core compilation, emulation, rendering,
audio, input, and saves remain unverified. The browser ABI harness records only
its tested integration behavior. Connectors,
AltStore feeds, and signing/JIT plans stay in `ecs-plugins`, outside the content
server process. App adapters stay in Provenance, iCube, and iFly.

Keep operator references current: [Service](../docs/operations/service.md),
[Storage locations](../docs/operations/storage-locations.md),
[WebDAV](../docs/webdav.md), and [Remote access](../docs/operations/remote-access.md).
The new documentation was source-checked; no real VPN, proxy, access-policy, or
service registration was changed as part of that pass.

Record manual acceptance separately from implemented features: native Finder
mounting, tray/service behavior on supported platforms, live VPN/proxy access,
and broader end-to-end workflows. Protocol tests alone do not establish native
Finder acceptance. Complete release/tag/package publication work explicitly;
the included 1.0 work is still in progress and no publication is claimed.
