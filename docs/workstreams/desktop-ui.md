# Desktop and menu-bar UI

Build a client of the existing API. Do not add a second storage path.

## Owned paths

- `apps/web`
- `apps/tray` (Tauri)
- `apps/server` static mount of the built web assets
- `packages/client-ts`

## Behavior

- Login uses bearer tokens. If cookies are introduced, add CSRF protection in the same change.
- The page stores the token rather than setting a cookie, so a reload stays signed in without adding a credential the browser attaches to every request on its own. A strict content policy on the assets is what pays for that: no other origin, no inline script, and no outbound connection.
- A stored token is tried against the API before the page claims to be signed in, because it may have been revoked or the server may have been rebuilt. A 401 clears it.
- Show libraries, items, upload progress, guest grants, and audit for the owner.
- Menu-bar status reflects `ecs serve` health and discovery. It does not embed the server.
- The web UI is static assets the server mounts under `/ui`. Sharing an origin with `/api/v1` keeps CORS out of the design.
- Svelte with Vite builds those assets. The tray renders the same components, so the two clients do not drift.
- Manage content roots and storage locations from the UI. A folder is submitted through the API, so the browser never reads the filesystem and the server stays the only component that resolves a path.
- Choosing a folder browses the server through `GET /api/v1/folders`, not a file input. A file input offers the browser's own disk, which is the wrong machine whenever the server is a NAS, and it returns names relative to a sandbox rather than the absolute path the server needs. The listing is owner-only and returns directory names only.
- Owner-only controls are absent for a reader or editor rather than disabled, because the API refuses them anyway and a visible control invites a confusing error.
- The tray is one Tauri application for macOS, Windows, and Linux. Its dropdown shows serve status and port, the library list, an item that opens the web UI, and start or stop of the registration from [Service lifecycle](service-lifecycle.md).
- The tray is an API client with no storage path of its own.

## Status

The web client exists. It signs in, shows server status from `/api/v1/capabilities`, lists libraries and items, and manages content folders by browsing the server. `pnpm ui` builds it and `ecs serve` mounts the result at `/ui/`, or serves nothing when the build is absent.

Opening an item lists the files in its manifest and uploads a chosen file into it, or creates an item when none is open. A file picked here is bytes to send, not a path to resolve, which is why a file input is right for an upload and wrong for a content folder. Both directions go through the engine in `@ecs/client`: `upload` sends pieces of at most 4 MB so progress has something to report and a break costs one piece, and `collect` assembles a download in memory, asking for only the bytes a broken stream left behind. Those bytes are handed to the browser's own download, so the page still never names a path on disk.

The tray exists as one Tauri application. Its dropdown reports whether the server answers and where, opens the shared interface in a separate bundled library window, offers Open in browser, opens the status window, and quits. It also reports and starts/stops the current user's local login service through a restricted native bridge (merged in #11). These controls operate on this computer even when the watched API address is remote. An absent registration shows CLI installation instructions. The window renders the same `Status` component as the web client, imported from `apps/web`, so the two cannot drift. The selected server profile is editable, remembered, and shared by both bundled windows. Sessions are scoped to the server origin, separate from browser storage; changing profiles retires old clients and ignores late responses. Closing either window hides it for reopening from the menu. Remote server HTML never loads in a privileged webview.

The owner page lists guest grants and the audit log. Creating a grant shows the token in that visit only; a reload asks the list endpoint, which returns the grant without the token or its hash. A reader or editor never sees those panels, because `GET /api/v1/roots` is what decides the account is the owner.

Owner-only storage locations are implemented in the page and API (merged in #12).
The owner can register a server directory, choose Primary or an online location
for new uploads, see offline status, and remove a location when the server's
guards allow it. See [Storage locations](../operations/storage-locations.md).
The tray and library windows coordinate sign-in and sign-out for the selected
server. A library list in the dropdown remains a follow-on UI improvement.
See [Desktop library](../operations/library-browser.md#desktop-library) for session,
player, download and native acceptance limits.

The browser player is implemented under its
[separate workstream](web-playback.md). Real-core compilation, emulation,
rendering, audio, input, and save acceptance remain unverified.
Cross-platform native UI and service acceptance is distinct from automated tests.

A download is held whole in memory before it is saved, which suits a save file and not a disc image. Writing as it arrives needs the File System Access API, which is Chromium only, so a large transfer belongs in a native client for now.

## Acceptance

- The UI can upload a generated file and download a byte range through `ContentClient`.
- No game bytes are committed as fixtures.
- The tray dropdown renders from a live health and capability response and degrades to an offline state when the server is unreachable.
- Adding and removing a folder round-trips through the API with no filesystem access in the UI process.

## Non-goals

Emulator app adapters, JIT, and a custom sync protocol remain outside this UI
workstream. Browser playback is included in 1.0 under its separate workstream;
operator-supplied cores are not vendored into the repository. See
[Plugins](../operations/plugins.md) for the existing player descriptors and plans.
