# Emulation Server

Headless library server for sharing emulator ROMs, saves, screenshots, artwork, BIOS, and system files between Provenance, iCube, iFly, and future clients.

The server is a separate repository from the emulator apps. Apps stay adapters. This repository owns the versioned HTTP contract, storage, access control, and reference clients.

## Run locally

Use Node.js 22.22.2 and pnpm 10.30.1:

```sh
pnpm install --frozen-lockfile
pnpm bundle
node dist/server/dist/src/main.js serve --data ./content-data
```

Open [the interface](http://127.0.0.1:8473/ui/). The first run prints a one-time bootstrap token; paste it into setup to create your owner account. Add a library, then add a server folder to scan existing files in place, or upload files from your device. Keep the data directory outside the application bundle when upgrading.

The `dist/server` directory includes production dependencies and the interface. Copy the entire directory to another Node.js host; no pnpm or source checkout is needed there:

```sh
node /path/to/server/dist/src/main.js serve --data /path/to/content-data
```

See [installation](docs/operations/install.md) for Docker, LAN access and upgrades. Early builds are available on the [releases page](https://github.com/Provenance-Emu/emulator-content-server/releases).

For the desktop companion, see [desktop installers](docs/operations/desktop-install.md). Its installed name is **Emulation Server**; it connects to the server above or another server on your network.

## Run in Docker

```sh
docker compose up --build
```

Compose publishes the server on host loopback and sets `ECS_ALLOW_LAN=1` so the container can bind `0.0.0.0` before setup finishes. The bootstrap token is still required before any library data is exposed. Read [docs/operations/install.md](docs/operations/install.md) before changing the published port.

For access away from home, follow [Remote access](docs/operations/remote-access.md)
for VPN-interface binding, bearer authentication, or an HTTPS proxy with a private
backend.

## Interface

`pnpm dev -- --data ./content-data --port 7878` compiles, serves, and stays running. A change to the server or a package restarts the process. A change to the page rebuilds it and the browser loads the new one. Add `--tray` to run the menu-bar app in the same session; `pnpm tray-dev` runs that app on its own, and it reloads when the shared client or the shared components change.

`pnpm ui` builds the web client and `ecs serve` mounts it at `/ui/` on the same origin as the API, which keeps CORS out of the design. The page stores its bearer token so a reload stays signed in, and the assets carry a content policy that allows no other origin, no inline script, and no outbound connection, which is what keeps that token out of reach of injected script. Pass `--ui none` to serve the API alone, or `--ui <dir>` to serve a build from elsewhere.

From the page you can sign in, read status, manage content folders, and move files: opening an item lists the files in its manifest, an upload goes in 4 MB pieces with progress, and a download that is cut short resumes from the bytes that arrived instead of starting over.

**Settings → Access** manages accounts, passwords, library roles, guest grants and which networks need a login. Guests can choose **Use an access token** on the sign-in page. Signed-in accounts can create and revoke Finder/WebDAV app credentials in **Settings → WebDAV** when the server starts with `--webdav`.

Owners can open **Settings → Folder watching** for a registered server folder and enable automatic index updates. Watching starts off and the preference survives a server restart. It detects changes inside nested folders without moving files. For reliable detection of moves in either direction, enable watching on both registered folders in the same library (or both unassigned); verified moves retain the source ID and saved matches. Cross-volume copies remain separate files. Recovery scans every 30 seconds catch missed events, recover offline folders, and provide a fallback when native notifications are unavailable. The dialog shows current status and can turn watching off at any time.

`apps/tray` is a menu-bar companion for macOS, Windows, and Linux. It reports whether the server answers and opens the interface, and it is an API client with no data directory of its own. It needs a Rust toolchain: `pnpm tray-dev` to run it, `pnpm tray` to bundle it. Nothing else in the repository needs Rust.

## WebDAV

`ecs serve --webdav` enables authenticated, read-only browsing and ranged downloads at `/dav/`. Finder uses revocable Digest app credentials; existing bearer credentials also work. See [WebDAV setup](docs/webdav.md) for enablement, credential management, and client configuration.

## Verify

```sh
pnpm verify
swift test --package-path clients/swift
```

`pnpm verify` typechecks, lints, runs unit and contract tests, checks generated-client drift, scans for secrets and copyrighted fixture types, and checks package boundaries.

## Layout

- `packages/protocol` is the OpenAPI contract and shared wire helpers.
- `packages/domain` holds entities and storage ports.
- `packages/database`, `packages/storage`, `packages/auth`, and `packages/discovery` are infrastructure.
- `apps/server` composes Fastify routes.
- `apps/cli` is the `ecs` command.
- `packages/plugins` and `apps/plugins` are the plugin host (`ecs-plugins`). Connectors, AltStore feeds, player descriptors, and JIT or signing plans live there and talk to this server only through `/api/v1`. See [docs/operations/plugins.md](docs/operations/plugins.md).
- `packages/client-ts` and `clients/swift` are generated from the contract, with hand-written resume logic beside the generated models.

Dependency direction is one-way: protocol and domain, then infrastructure, then server and CLI. App-specific Realm, Dolphin, CloudKit, and UIKit code does not belong here.

## Scope of this foundation

The early version serves original bytes with single-range reads, resumable uploads, library roles, guest grants, device tokens, a change cursor, mDNS advertisement, and backup. Folder scanning, matching review, optional watching and organization, ZIP access, save-conflict preservation, the web library and desktop companion are implemented.

Opt-in CHD v5 decoding supports DVD ISO and a CD CUE/BIN subset; see [CHD operations](docs/operations/chd.md). Browser playback supports multiple [Emscripten/WASM player plugins](docs/operations/web-emulation-plugins.md), with validated manifests, compatible game selection and an isolated runtime. The pinned NES/FCEUmm core passed [real rendering, input, audio and save restoration through the plugin launcher](docs/operations/browser-playback-plugin-acceptance.md); its legacy adapter remains supported. Cores and decoders are operator-supplied; each build needs its own rendering, controls, audio and save validation.

Provenance, iCube and iFly integrations stay in their app repositories. Remote relays, signing execution and JIT activation remain follow-on work. IPA feeds and NAS/cloud connectors use the separate plugin host; they never run inside the content server. See the [first-version status](docs/operations/first-version.md) for tested scope and follow-ups.
