# Tech context

## Stack

- Node >= 22.13, pnpm workspaces, TypeScript project references (`tsc -b`).
- Fastify for HTTP, SQLite in WAL mode for the catalog, Argon2id for passwords.
- Biome for lint and format.
- `node:test` for tests, run against compiled output in `dist/test` by `scripts/run-tests.mjs`.
- Swift package in `clients/swift` for the Apple client.

## Layout

| Path | Owns |
| --- | --- |
| `packages/protocol` | OpenAPI, problem responses, cursors, ranges, system identifiers, client generation |
| `packages/domain` | Entities, errors, content-reader and virtual-provider ports |
| `packages/database` | SQLite schema, migrations, catalog repository |
| `packages/storage` | Content-addressed blobs, staging, range readers, path containment |
| `packages/auth` | Passwords, token hashes, ACL evaluation, rate limits, listen policy |
| `packages/discovery` | `_pvcontent._tcp` TXT records and advertisement |
| `apps/server` | Fastify composition and HTTP behavior |
| `apps/cli` | `init`, `serve`, `doctor`, `backup` |
| `packages/client-ts`, `clients/swift` | Generated models and app-neutral resume behavior |

## Data directory

`ensureLayout` creates `blobs/sha256`, `staging`, `virtual-cache`, and `backups` under the data root. Blobs live at `blobs/sha256/<2-hex>/<64-hex>`. `resolveInside` is the only sanctioned way to turn operator input into a path; it resolves symlinks and rejects anything that escapes the root.

## Commands

```sh
pnpm verify                            # lint, test, drift, secret scan, boundaries
swift test --package-path clients/swift
pnpm generate                          # regenerate TS and Swift models from the contract
pnpm check-drift                       # fail when generated clients drift
pnpm update-surface                    # refresh docs/protocol/v1-surface.json
```

Prefer these over an emulator build. A storage or protocol change does not require Provenance, iCube, or iFly to compile.

## Generated files

`packages/client-ts/src/generated.ts`, `clients/swift/Sources/EmulatorContentClient/GeneratedModels.swift`, and `docs/protocol/v1-surface.json` are generated. Never hand-edit them. Additive v1 fields are allowed. Removing an operation, removing a property, or adding a newly required field is breaking and needs a new major path; `findBreakingChanges` in `packages/protocol/src/openapi.ts` encodes those three rules.

## Constraints

- Migrations are append-only numbered SQL. A shipped migration is never edited. Schema version mismatch is a hard error. The catalog must open cleanly twice and preserve rows.
- `scripts/secret-scan.mjs` rejects copyrighted fixture extensions and private-key material.
- Never log bootstrap tokens, bearer tokens, passwords, or authorization headers. Audit details must not contain raw tokens; Fastify redacts `authorization` and `cookie`.
