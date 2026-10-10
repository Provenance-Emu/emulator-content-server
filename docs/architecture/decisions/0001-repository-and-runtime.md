# ADR 0001: Separate TypeScript repository

The content server lives in its own repository. Provenance and the iCube submodule are application codebases with Apple-specific storage, UI, and a large dirty worktree. A headless multi-user service needs a different runtime and security boundary.

The implementation uses strict TypeScript on Node.js 22, Fastify, pnpm workspaces, and the built-in `node:sqlite` driver. Swift clients are generated from OpenAPI instead of sharing server source. Python was not selected because the contract, generated clients, and a future web UI want one type system. Server-side Swift was not selected because the portable deployment target includes Linux containers and Windows without an Apple toolchain in the image.

## Consequences

- App adapters stay in their own repositories.
- Protocol concepts are reimplemented from behavior, not copied from existing app servers.
- Node 22 is required because the process uses built-in SQLite.
