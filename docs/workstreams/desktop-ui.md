# Desktop and menu-bar UI

Build a client of the existing API. Do not add a second storage path.

## Owned paths

- `apps/web` (new)
- `apps/tray` (new, Tauri)
- `apps/server` static mount of the built web assets
- `packages/client-ts`

## Behavior

- Login uses bearer tokens. If cookies are introduced, add CSRF protection in the same change.
- Show libraries, items, upload progress, guest grants, and audit for the owner.
- Menu-bar status reflects `ecs serve` health and discovery. It does not embed the server.
- The web UI is static assets the server mounts under `/ui`. Sharing an origin with `/api/v1` keeps CORS out of the design.
- Manage content roots and storage locations from the UI. A folder is submitted through the API, so the browser never reads the filesystem and the server stays the only component that resolves a path.
- Owner-only controls are absent for a reader or editor rather than disabled, because the API refuses them anyway and a visible control invites a confusing error.
- The tray is one Tauri application for macOS, Windows, and Linux. Its dropdown shows serve status and port, the library list, an item that opens the web UI, and start or stop of the registration from [Service lifecycle](service-lifecycle.md).
- The tray is an API client with no storage path of its own.

## Acceptance

- The UI can upload a generated file and download a byte range through `ContentClient`.
- No game bytes are committed as fixtures.
- The tray dropdown renders from a live health and capability response and degrades to an offline state when the server is unreachable.
- Adding and removing a folder round-trips through the API with no filesystem access in the UI process.

## Non-goals

Emulation, JIT, and a custom sync protocol.
