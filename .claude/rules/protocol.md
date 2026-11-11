---
paths:
  - "packages/protocol/**"
  - "packages/client-ts/**"
  - "clients/swift/**"
  - "docs/protocol/**"
---

# Contract and clients

- `packages/protocol/openapi/openapi.yaml` is the contract. Edit it first, then `pnpm generate`. Never hand-edit `packages/client-ts/src/generated.ts`, `GeneratedModels.swift`, or `docs/protocol/v1-surface.json`.
- v1 is additive only. Removing an operation, removing a property, or adding a required field is breaking and needs a new major path. New response fields are optional.
- `pnpm check-drift` must pass. Run `pnpm update-surface` only when the contract change is intended, and say so in the commit.
- `packages/protocol` imports nothing internal. No Fastify, SQLite, or filesystem code here or in `packages/domain`.
- The hand-written parts of the clients (resume planning, change-cursor walking, sync engine) are app-neutral. No Realm, CloudKit, UIKit, or app-specific types.
- Swift changes: `swift test --package-path clients/swift` (macOS only).
- Think about the app on the other end: a list response should carry what a grid needs (title, system, artwork reference) so a client never makes one request per game.
