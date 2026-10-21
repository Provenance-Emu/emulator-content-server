# Handoff

## Current checkpoint — 2026-10-20

The sections below this checkpoint are historical. Scanning, the library browser,
folder/upload flows, and the shared desktop library have since landed. Do not
restart those features from the old “Next” list or treat its uncommitted-work
description as current. Consult the source and operations guides for implemented
behavior.

The current user direction is to continue library and matching improvements,
batch changes directly on `main`, and commit/push completed work. The project is
still unreleased; use focused checks and create PRs only when requested or needed
to isolate colliding parallel work. The branch audit found only local/remote
`main`, one checkout, and no open PRs.

Recent work includes saved metadata/artwork/patch/cheat selections, library-wide
checksum matching and its review queue. Partial provider failures now remain
reviewable and also appear under Failed, where they can retry without repeating
healthy games or replacing saved choices. Completing review clears retry status.
See [Matching operations](../docs/operations/matching-plugins.md).

Validation for this checkpoint: 162 web controller tests, Svelte check with zero
errors/warnings, the focused browser retry regression, TypeScript and production
web builds, changed-file lint, and package boundaries. This does not establish
native platform or real browser-core acceptance. Runtime notes below describe an
earlier operator setup; verify current configuration before restarting anything.

## Historical handoff

Read `AGENTS.md` before changing code. This file is the current gap, not a second architecture.

The page can register a ROM folder and then shows nothing from it. Registration is done. Scanning is not. That is the next feature. A visual pass on the existing forms will not make those folders useful.

## What the operator has running

`pnpm dev --tray -- --data ./content-data --port 7878` watches the tree, restarts the server when compiled server code changes, and opens the menu bar. The data directory is `content-data` in this checkout. If that directory has no owner yet, the token is `content-data/bootstrap.token` and the status window asks for it. Do not print that token.

Older demo processes used `/tmp/ecs-ui-demo` on 7879 and `/tmp/ecs-choice` on 7880. They are not the library.

## Done, and not all of it is committed

Committed on `main` through the sync and signing work: the v1 API, blob storage, ZIP reads, content roots (the path is saved, nothing is copied, nothing is scanned), keep-both saves, adopt, the web page at `/ui`, the menu bar shell, and the TypeScript and Swift sync engines.

Uncommitted in this working tree, and required by the running server:

- Local-network access. Default mode `lan`: this machine may manage accounts with no token, other private addresses may sync and may not manage accounts, and a public address needs a login. `subnets` adds named CIDRs. `token` requires a login everywhere. `--public` ignores the socket address because it is the proxy. The menu bar is the only cross-origin caller allowed to read responses.
- Menu bar forms for the owner account, other accounts, guest links, and that access rule. `apps/tray/src/Access.svelte`.
- `pnpm dev` in `scripts/dev.mjs`. A development web build overwrites `apps/web/dist`. Run `pnpm ui` before treating that directory as the production page.
- `docs/workstreams/media-availability.md` is a brief only. No probe, migration, or route exists.

Do not commit ROMs, BIOS, discs, or saves. The folders added from the page are rows in `content-data`, not files in git.

## Next, in this order

1. **Show the folders.** Implement the scan in `docs/workstreams/scanning-metadata.md` together with `docs/workstreams/media-availability.md`. A root stays a path. Files stay where they are until a client asks for bytes. Each file is `local`, `evicted`, or `offline`. An evicted file is `stat`ed and never opened, because opening it starts an iCloud download. Readers see availability, not the absolute path. Unplugged disks stay registered. This is not the storage-locations brief, which is about copies the server already owns.

2. **Replace the page.** `apps/web` is a stack of forms: status, upload, and a path field. After a scan exists, the page should be the libraries and the folders, with files grouped by system and kind, and conflict copies keeping the "Use this one" action already wired to `adopt`. The menu bar stays a status and access panel. It does not become the library, and it does not read the database. Rust stays the shell.

3. **Leave these until the library is visible.** Audit log page. Storage locations. Start-at-login. Disc containers after ZIP. WebDAV. Remote access and any relay. Sideload and JIT, which are specified in `docs/workstreams/sideload-installer.md` and stay out of the content-server process. App screens stay in the Provenance, iCube, and iFly repositories. In-browser play is [Web playback](../docs/workstreams/web-playback.md): libretro Emscripten cores the operator supplies, same accounts, same files, after a local file can be streamed. A container for a VM or cloud host is [Container install](../docs/workstreams/container-install.md). `compose.yaml` publishes loopback. A public port needs `token` mode and `--public --tls-terminated`, because the Docker bridge would otherwise look like the LAN.

## Rules that are easy to break

- New schema is a new numbered migration. Do not edit a migration that has already been applied. The catalog must open twice and keep its rows.
- OpenAPI changes are additive. Removing an operation or a property, or adding a newly required field, is a new major path. Regenerate with `pnpm generate` and update the surface only when the contract change is intentional.
- `packages/protocol` and `packages/domain` do not import Fastify, SQLite, or the filesystem. The tray and the web page depend only on `@ecs/client`. The tray may also use the web package for shared components.
- Never log a bootstrap token, bearer token, password, or authorization header. Audit details must not contain a raw token. Guest tokens are shown once in the menu bar and are not stored there.
- `pnpm verify` is the check. `swift test --package-path clients/swift` when the Swift client changes. The tray's Rust shell is `pnpm tray`, and it is not part of `pnpm verify`.
- The maintainer uses branches and worktrees and does not want a pull request unless they ask.
