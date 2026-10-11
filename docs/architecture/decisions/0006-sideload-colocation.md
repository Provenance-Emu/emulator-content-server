# ADR 0006: Sideload and JIT live in this repository, outside this process

ADR 0004 said signing, JIT activation, and IPA installation were out of process and out of repository. The repository split is reversed. The process split is not.

Another repository costs review attention, release coordination, and a second CI setup for a household-scale project. The property that protects an operator was never the repository boundary. It is that a compromise of the content server yields no Apple credential, and a compromise of the signing service yields no content library.

A signing app therefore lives beside the content server with its own entry point, data directory, SQLite database, and credential store. It does not import `@ecs/storage` or `@ecs/database`, does not mount routes into `apps/server`, does not read the blob directory, and does not accept content-server bearer tokens. `scripts/check-boundaries.mjs` keeps those edges out, so the separation is enforced by the build rather than by discipline.

## Consequences

- `SECURITY.md` now promises that the content server process and database hold no Apple credential. It no longer promises the repository contains no signing code.
- Extracting the signing app into its own repository later needs no schema change, because it never shared a database.
- A content-server data directory must keep working with the signing app absent, and `/api/v1/capabilities` must not grow a sideload flag.
- One compromised checkout now exposes both codebases. Credentials remain separate and neither service can read the other's store, so the blast radius of a running host is unchanged.
