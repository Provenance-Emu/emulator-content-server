# Protocol versioning

The current contract is `/api/v1`, major 1, minor 0. `GET /api/v1/capabilities` reports the major, minor, feature flags, upload limit, and authentication modes. Unknown response fields must be ignored by clients.

Additive changes stay on v1: new optional fields, new endpoints, and new feature flags. `docs/protocol/v1-surface.json` is the committed snapshot. The contract test fails when an operation or property disappears, or when an existing schema gains a new required property.

A breaking change gets `/api/v2` and a new surface snapshot. Servers may keep serving v1.

Errors use `application/problem+json` with a `urn:ecs:problem:<code>` type and the request id. Mutating posts accept `Idempotency-Key`. Item pages use an opaque cursor. The change feed uses a decimal cursor that is exclusive.

Idempotency keys are scoped to the authenticated actor. A replay must match the original HTTP method, request URL (including resource IDs and query string), and JSON body. Reusing a key for a different request returns HTTP 409 with `urn:ecs:problem:idempotency-conflict`. Current authorization is checked before a cached response is returned.

Matching simultaneous requests in one server process share the in-progress operation and its result. A conflicting request returns 409 even while the first is running. Failed operations release their key so a client can retry. This coordination is local to one process; it does not provide cross-process locking or make the operation and receipt atomic across a crash.

Receipts written by older servers that fingerprinted only the body also return this conflict after upgrade: their original target cannot be verified. Clients should inspect the resource or upload status before choosing a new key, since the original operation may already have succeeded.

Manifest files mirror the fields an app needs to pull a game: kind, relative path, size, SHA-256, MD5, CRC, required flag, and content path. ROM, BIOS, and system files are required. Screenshots, artwork, and saves are optional.
