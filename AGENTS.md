# Agent guide

This repository is the emulator content server. Keep changes inside the package you were assigned.

## PRE-RELEASE iteration policy — applies to every session

**PRE-RELEASE: NO EXTERNAL PRODUCTION; NOT SHIPPING.** Keep this policy in effect until the user explicitly requests release hardening.

- Default to fast iteration: focused tests and typechecks for affected code, with meaningful test-first bug regressions. Preserve user data, secrets, authentication guarantees, and package boundaries.
- Batch related changes on the existing branch/worktree. Do not create a PR per chunk or automatically dispatch multiple review seats. Use one proportionate review for authentication, storage, protocol, or concurrency risk; ordinary UI work does not need an exhaustive matrix.
- Run a relevant small local test/build, commit and push when authorized, then update from feedback. Keep optional checks asynchronous and nonblocking unless the risk requires them. Do not repeat full monorepo, browser, Swift, Rust, native, emulator, or multi-OS pipelines for routine web work.
- Merge/push directly to main when the user has authorized it. Create PRs only when requested or required. Honor actual branch protection and later explicit user instructions; queued optional checks are not merge gates.
- Automatic CI runs one Linux verification with the high-severity dependency audit on main pushes and PRs. The full OS/browser/Swift/Docker/Trivy matrix and native CHD acceptance remain available through manual workflow dispatch.

## Ownership

| Path | Owns |
| --- | --- |
| `packages/protocol` | OpenAPI, problem responses, cursors, ranges, system-identifier rules, client generation |
| `packages/domain` | Entities, errors, content-reader and virtual-provider ports |
| `packages/database` | SQLite schema, migrations, catalog repository |
| `packages/storage` | Content-addressed blobs, staging, range readers, path containment |
| `packages/auth` | Passwords, token hashes, ACL evaluation, rate limits, listen policy |
| `packages/discovery` | `_pvcontent._tcp` TXT records and advertisement |
| `apps/server` | Fastify composition and HTTP behavior |
| `apps/cli` | `init`, `serve`, `doctor`, `backup` |
| `packages/client-ts`, `clients/swift` | Generated models, app-neutral resume behavior, sync engine |
| `apps/web` | Svelte interface the server mounts at `/ui` |
| `packages/signing` | IPA inspection, profile reading, what a signed build may be called |
| `packages/plugins` | Plugin manifests, connector ports, AltStore feeds, player and signer plans |
| `apps/plugins` | `ecs-plugins` host. Separate process from the content server |
| `examples/plugins` | Sample feeds and connectors other developers copy |
| `apps/tray` | Tauri menu-bar status, one application for macOS, Windows, and Linux |
| `docs/workstreams` | Follow-on briefs. Do not implement those briefs in an unrelated PR |

## Dependency direction

`protocol` has no internal dependencies. `domain` may depend on `protocol`. Infrastructure packages may depend on `domain`. `apps/server` and `apps/cli` may depend on infrastructure. Do not import Fastify, SQLite, or filesystem code from `protocol` or `domain`. `apps/web` and `apps/tray` are API clients and may depend only on `@ecs/client`, plus `apps/tray` on `apps/web` for shared components. Neither may open a database or read a data directory. `packages/signing` has no internal dependencies and may not reach the catalog, the blob store, or the domain: it reasons about a bundle and a profile and nothing else. `packages/plugins` has no internal dependencies either. The content server may import its matching contracts, pure match-fact parsers, and the child-process matching bridge; operator-installed provider/manager modules run only in the separate plugin process, never in the HTTP process. `apps/plugins` may depend on `@ecs/plugins`, `@ecs/client`, `@ecs/protocol`, and `@ecs/signing`. It may not import the content server, the catalog, or the blob store. The boundary check reads imports in `src`, not just the manifest, because a dev dependency satisfies the resolver. `scripts/check-boundaries.mjs` enforces the internal edges.

## Migrations

Add a new numbered SQL migration. Do not edit a migration that has shipped. The catalog must open cleanly twice and preserve existing rows. Schema version mismatch is a hard error.

## Generated files

`packages/protocol/openapi/openapi.yaml` is the contract. Regenerate with `pnpm generate`. `pnpm check-drift` fails when `packages/client-ts/src/generated.ts`, `clients/swift/Sources/EmulatorContentClient/GeneratedModels.swift`, or `docs/protocol/v1-surface.json` drift. Update the surface snapshot with `pnpm update-surface` only when the contract change is intentional. Additive v1 fields are allowed. Removing an operation, removing a property, or adding a newly required field is a breaking change and needs a new major path.

## Validation

Browser acceptance must be quiet and headless. Disable game audio before launching
a test; do not open, focus, or drive the user's native browser unless they explicitly
request that interaction for the current test. Close test pages and terminate test
servers after acceptance so no emulator/audio loop is left running.

Choose checks for the changed behavior and package. For routine web changes, run the affected tests and the relevant Svelte/typecheck or build; add a browser check only when browser behavior needs it. Use meaningful regression tests for behavior changes. Broaden checks for cross-package impact or specific risks, without repeating successful checks on unchanged code.

Full validation remains available for release hardening, cross-cutting changes, or an explicit request:

```sh
pnpm verify
swift test --package-path clients/swift
```

`pnpm verify` covers the server, client, and both interfaces, including `svelte-check`. Swift tests require macOS. The full CI matrix is manual (`workflow_dispatch`) during pre-release. Build the tray with `pnpm tray` only when `apps/tray/src-tauri` changes and its Rust shell needs validation. A storage or protocol change does not require Provenance, iCube, or iFly to compile.

## Fixtures and secrets

Use generated bytes in tests. Do not commit ROM, BIOS, disc, or save files. `scripts/secret-scan.mjs` rejects common copyrighted fixture extensions and private-key material. Never log bootstrap tokens, bearer tokens, passwords, or authorization headers. Audit details must not contain raw tokens.

## App adapters

Provenance, iCube, and iFly changes belong in those repositories. Consume the generated Swift client or the OpenAPI document. Do not copy server code into an app, and do not copy app database code into this server.

## Cursor Cloud specific instructions

- Node is pinned in `.nvmrc` (`22.22.2`) and pnpm in `packageManager` (`10.30.1`). Put `/usr/local/bin` ahead of `/exec-daemon` on `PATH` before `node` or `pnpm`; the image can expose an older Node binary first, and `.npmrc` sets `engine-strict`.
- `pnpm verify` is the Linux check (lint, tests, `svelte-check`, client drift, secret scan, package boundaries). `swift test --package-path clients/swift` is macOS-only: `clients/swift/Package.swift` declares Apple platforms, and the manual CI matrix runs that job on `macos-latest`.
- The boot script listens on `http://127.0.0.1:8473` and keeps the catalog in `/var/tmp/ecs-content-data`. Until bootstrap, that directory contains `bootstrap.token`. Do not copy the data directory or the serve log into commits or chat. `pnpm dev` watches the server and the web build. The boot script serves the already built CLI with `node apps/cli/dist/src/main.js` after `pnpm build` and `pnpm ui`.
- `pnpm tray` needs a Rust toolchain and is outside `pnpm verify`. Skip it unless `apps/tray/src-tauri` changed.
- Do not commit `RetroArch.7z` or an extracted player. Web playback cores come from `https://buildbot.libretro.com/nightly/emscripten/RetroArch.7z`, unpacked to `/opt/libretro/emscripten/retroarch` when `index.html` is missing. That tree is about 1.2 GB and stays outside the repository.

When the user asks to consolidate, finish the active batch before starting another feature. After publishing, switch the primary checkout to main and archive redundant worktrees and delete merged or verified-equivalent branches, preserving unique work and ignored handoff/data artifacts first. Do not leave the primary checkout on a completed feature branch.
