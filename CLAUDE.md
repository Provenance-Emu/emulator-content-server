# Emulation Server — Claude guide

@AGENTS.md

`AGENTS.md` above is the shared rulebook for every agent (ownership, dependency direction, migrations, generated files, validation, pre-release policy). This file adds what Claude needs on top of it. When the two disagree, `AGENTS.md` wins; fix this file.

## What this is, and what it is for

One household keeps one game library. A phone, a TV, and a desktop all see the same catalog, artwork, saves, and BIOS without copying whole libraries around. Provenance, iCube, and iFly are thin adapters over one versioned HTTP contract that this repository owns.

The person using it is an owner at home, not an operator in a data centre. Judge every change by that:

- **A library, not a file server.** People look for a game by its cover and name. A list of filenames is a failure state, in the web interface and in what the API lets an app render.
- **Works without being configured.** Scanning, matching, and artwork should happen on their own after a folder is added. A feature that needs a flag, a plugin, or a second screen to start working is unfinished.
- **Never lose anything.** Saves, the catalog, and files on disk outrank every feature. Prefer reversible actions; a destructive one needs an undo or an explicit confirmation.
- **Safe by default.** Loopback until the owner is bootstrapped. Access is decided before any byte is opened. Tokens and passwords never reach a log, an audit row, a URL, or chat.
- **Honest.** `GET /api/v1/capabilities` reports what the running server really does. Status indicators in the interface must mean what they show.
- **Plain language.** Interface copy says "games", "folders", "details", "artwork". Identifiers, hashes, and provenance sit behind a disclosure.
- **Compact and calm.** The interface is a utility. See `docs/ui/design-language.md` before touching `apps/web`.

## How to work here

- Pre-release, fast iteration, one batch on the current branch, direct to `main` only when the user has authorized it in this session. Commit or push only when asked.
- Read before you build: the map below tells you which document is authoritative for an area. Do not rediscover it by grepping.
- Change the contract first. `packages/protocol/openapi/openapi.yaml`, then `pnpm generate`, then server, then clients. Additive only on v1.
- Regression test first for a bug. Focused checks for the package you touched; `pnpm verify` only for cross-package work or when asked.
- Other agents (Codex, Cursor) work in this checkout too. If `git status` shows changes you did not make, leave them alone, do not stage them, and say so.
- App changes for Provenance, iCube, and iFly belong in their repositories. From here you may change `clients/swift` and the OpenAPI document they consume.
- `content-data/`, `bootstrap.token`, `.superpowers/.last-token`, and serve logs hold secrets or the owner's library. Never read them into chat or a commit.

## Where to look

| Need | Read |
| --- | --- |
| Rules, ownership, validation | `AGENTS.md` |
| System shape | `docs/architecture/overview.md`, `docs/architecture/storage.md`, ADRs in `docs/architecture/decisions/` |
| The wire contract | `packages/protocol/openapi/openapi.yaml`, `docs/protocol/versioning.md` |
| How an app talks to the server | `docs/protocol/client-integration.md` |
| Web interface tokens, components, density | `docs/ui/design-language.md` |
| An area's brief and allowed paths | `docs/workstreams/README.md` and the brief it links |
| Why a feature is shaped the way it is | `docs/superpowers/specs/` (designs), `docs/superpowers/plans/` (plans) |
| How to run, install, operate, accept | `docs/operations/` (`install.md`, `first-version.md`, `plugins.md`, `chd.md`, `browser-playback.md`) |
| WebDAV | `docs/webdav.md` |
| Security boundaries | `docs/security/`, `SECURITY.md`, ADR 0004 |

`memory-bank/` is a dated reading aid written by earlier agents. Check the date on anything you take from it; the documents above are the source of truth. Do not extend it.

Dated files in `docs/operations/` (`*-2026-10-30.md`, `.json`) are acceptance evidence for one day. They are history, not instructions.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm dev -- --data ./content-data --port 7878   # server + web, restarts on change
pnpm build                                      # tsc -b, all packages
node --test apps/server/dist/test/<name>.test.js    # one compiled test file, after pnpm build
pnpm --filter @ecs/web test                     # web unit tests
pnpm --filter @ecs/web check                    # svelte-check + web unit tests
pnpm ui                                         # production web build
pnpm lint                                       # biome check; pnpm format to fix
pnpm generate && pnpm update-surface            # after an intentional contract change
node scripts/check-boundaries.mjs               # package import rules
pnpm verify                                     # everything on Linux/macOS; not for routine work
```

Tests are `node:test`, compiled to `<package>/dist/test/`. Run `pnpm build` before running a single file.

## Keeping context small

- Large files: `apps/server/src/routes.ts`, `packages/database/src/catalog.ts`, `apps/web/src/app.css`, the OpenAPI document, `docs/protocol/v1-surface.json`. Search for the symbol and read the range; do not read them whole.
- Never read generated output: `packages/client-ts/src/generated.ts`, `GeneratedModels.swift`, `dist/`, `dist-release/`, the `.json` evidence in `docs/operations/`.
- Subagents: `ecs-scout` (haiku) to locate code and summarise a document, `ecs-reviewer` (sonnet) for one proportionate review of auth, storage, protocol, or concurrency changes. Keep the main session for design and synthesis.
- Skills in `.claude/skills/`: `contract-change`, `add-migration`, `quiet-web-check`. Path-scoped rules in `.claude/rules/` load when you open matching files.
- A feature that spans sessions gets a design in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` and, if it needs one, a plan in `docs/superpowers/plans/`. Status lives in the plan's checkboxes, not in a new handoff file.
