# System patterns

## Shape

A single-node household library. SQLite in WAL mode holds metadata. The filesystem holds immutable blobs addressed by SHA-256. Fastify exposes `/api/v1`. The CLI is the supported process entry.

```text
CLI / Docker
    |
    v
Fastify routes ---- auth decision ---- catalog repository ---- SQLite
        |                                      |
        +----------- storage ------------------+
                    blobs, staging, range reads
```

## Request pattern

Every request authenticates a bearer token in the `onRequest` hook, decides access with the pure `authorize` function, and only then opens a blob. The order matters: no filesystem work happens before the access decision. `requireVisibleAsset` in `apps/server/src/routes.ts` is the single gate for asset routes, and it distinguishes 404 from 403 so a caller cannot probe for hidden items.

## Dependency direction

One way only. `protocol` has no internal dependencies. `domain` may depend on `protocol`. Infrastructure (`database`, `storage`, `auth`, `discovery`) may depend on `domain`. `apps/server` and `apps/cli` may depend on infrastructure. Fastify, SQLite, and filesystem code never appear in `protocol` or `domain`. `scripts/check-boundaries.mjs` enforces this from each `package.json`.

## Ports and adapters

`domain` declares the ports: `ContentReader`, `VirtualContentProvider`, `MaterializeQuota`. `storage` implements them. Virtual disc formats plug into `VirtualContentProvider` through `VirtualProviderRegistry`, so adding a format never touches a route.

## Change feed

Catalog mutations append a monotonic cursor. Clients poll `GET /api/v1/changes`. Events carry a `sensitive` flag so a restricted asset does not leak through the feed.

## Identity

SHA-256 is blob identity. MD5 and CRC are compatibility fields only. Provenance system identifiers are an open dotted vocabulary, not a closed enum, so iCube and iFly can send their own.

## Concurrency

Item and asset writes use `If-Match: "rev-N"`; upload completion sends `baseRevision`. Mutating requests accept `Idempotency-Key`, and reusing a key with a different body is a 409.
