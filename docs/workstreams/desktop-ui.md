# Desktop and menu-bar UI

Build a client of the existing API. Do not add a second storage path.

## Owned paths

- `apps/web` (new)
- `apps/tray` (new, Tauri)
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

The tray exists as one Tauri application. Its dropdown reports whether the server answers and where, opens the interface in the real browser, opens a status window, and quits. The window renders the same `Status` component as the web client, imported from `apps/web`, so the two cannot drift. The address it watches is editable and remembered.

Still to do: storage locations, guest grants, audit, the library list in the dropdown, which needs the tray to hold a token, and the service start and stop controls, which need [Service lifecycle](service-lifecycle.md) first.

A download is held whole in memory before it is saved, which suits a save file and not a disc image. Writing as it arrives needs the File System Access API, which is Chromium only, so a large transfer belongs in a native client for now.

## Acceptance

- The UI can upload a generated file and download a byte range through `ContentClient`.
- No game bytes are committed as fixtures.
- The tray dropdown renders from a live health and capability response and degrades to an offline state when the server is unreachable.
- Adding and removing a folder round-trips through the API with no filesystem access in the UI process.

## Non-goals

Emulation, JIT, and a custom sync protocol.
