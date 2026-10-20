# Emulator Content Server

Headless library server for sharing emulator ROMs, saves, screenshots, artwork, BIOS, and system files between Provenance, iCube, iFly, and future clients.

The server is a separate repository from the emulator apps. Apps stay adapters. This repository owns the versioned HTTP contract, storage, access control, and reference clients.

## Run locally

```sh
pnpm install
pnpm ecs init --data ./content-data
pnpm ecs serve --data ./content-data
```

The first run prints a one-time bootstrap token and listens on `127.0.0.1:8473`. Create the owner with `POST /api/v1/auth/bootstrap`, then use the returned bearer token.

After the package is published, the same command is:

```sh
npx --yes @provenance-content/server serve --data ./content-data
```

## Run in Docker

```sh
docker compose up --build
```

Compose publishes the server on host loopback and sets `ECS_ALLOW_LAN=1` so the container can bind `0.0.0.0` before setup finishes. The bootstrap token is still required before any library data is exposed. Read [docs/operations/install.md](docs/operations/install.md) before changing the published port.

## Interface

`pnpm dev -- --data ./content-data --port 7878` compiles, serves, and stays running. A change to the server or a package restarts the process. A change to the page rebuilds it and the browser loads the new one. Add `--tray` to run the menu-bar app in the same session; `pnpm tray-dev` runs that app on its own, and it reloads when the shared client or the shared components change.

`pnpm ui` builds the web client and `ecs serve` mounts it at `/ui/` on the same origin as the API, which keeps CORS out of the design. The page stores its bearer token so a reload stays signed in, and the assets carry a content policy that allows no other origin, no inline script, and no outbound connection, which is what keeps that token out of reach of injected script. Pass `--ui none` to serve the API alone, or `--ui <dir>` to serve a build from elsewhere.

From the page you can sign in, read status, manage content folders, and move files: opening an item lists the files in its manifest, an upload goes in 4 MB pieces with progress, and a download that is cut short resumes from the bytes that arrived instead of starting over.

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
- `packages/plugins` and `apps/plugins` are the plugin host (`ecs-plugins`). Connectors, AltStore feeds, the wasm player, and JIT or signing plans live there and talk to this server only through `/api/v1`. See [docs/operations/plugins.md](docs/operations/plugins.md).
- `packages/client-ts` and `clients/swift` are generated from the contract, with hand-written resume logic beside the generated models.

Dependency direction is one-way: protocol and domain, then infrastructure, then server and CLI. App-specific Realm, Dolphin, CloudKit, and UIKit code does not belong here.

## Scope of this foundation

The foundation serves original bytes with single-range reads, resumable uploads, library roles, guest grants, device tokens, a change cursor, mDNS advertisement, and backup. Format-specific virtual discs and remote relays are documented as follow-on work in [docs/workstreams](docs/workstreams/README.md). Signing, JIT activation, IPA feeds, and NAS or cloud connectors stay out of the content server process and database. They are plugins.
