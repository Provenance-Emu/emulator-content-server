# Sideload and JIT isolation

AltStore and SideStore style signing, device registration, JIT activation, and IPA distribution are a different product that may live in this repository. It shares no process, database, or credential with the content server. See [ADR 0006](../architecture/decisions/0006-sideload-colocation.md).

## Owned paths

- `apps/sideload` (new) with its own entry point and data directory
- `packages/signing` (new)
- its own tests and `docs/operations`

## Rules

- Separate process, separate data directory, separate SQLite database. Extracting it into its own repository later must need no schema change.
- Do not reuse content-server bearer tokens. Signing credentials get their own store, lifetime, and revocation.
- Do not read the content blob directory.
- Do not import `@ecs/storage` or `@ecs/database`. Add the new packages to `scripts/check-boundaries.mjs` so the build refuses those edges.
- Do not mount a signing route into the Fastify app in `apps/server`.
- Do not advertise signing as a content-server capability.

## Acceptance

- The content server process and database hold no Apple ID, certificate, or provisioning-profile material.
- `features` in `/api/v1/capabilities` does not grow a sideload flag.
- A content-server data directory works with the signing app absent, and `doctor` does not report it missing.
- The boundary check fails if a signing package imports content storage or the catalog.
- No Apple credential appears in a log, an audit detail, or a discovery TXT record.

## Non-goals

Mounting any sideload or JIT endpoint on `/api/v1`, sharing a database or a credential with the content server, and distributing IPAs through the content blob store.
