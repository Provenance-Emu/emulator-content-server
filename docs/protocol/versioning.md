# Protocol versioning

The current contract is `/api/v1`, major 1, minor 0. `GET /api/v1/capabilities` reports the major, minor, feature flags, upload limit, and authentication modes. Unknown response fields must be ignored by clients.

Additive changes stay on v1: new optional fields, new endpoints, and new feature flags. `docs/protocol/v1-surface.json` is the committed snapshot. The contract test fails when an operation or property disappears, or when an existing schema gains a new required property.

A breaking change gets `/api/v2` and a new surface snapshot. Servers may keep serving v1.

Errors use `application/problem+json` with a `urn:ecs:problem:<code>` type and the request id. Mutating posts accept `Idempotency-Key`. Item pages use an opaque cursor. The change feed uses a decimal cursor that is exclusive.

Manifest files mirror the fields an app needs to pull a game: kind, relative path, size, SHA-256, MD5, CRC, required flag, and content path. ROM, BIOS, and system files are required. Screenshots, artwork, and saves are optional.
