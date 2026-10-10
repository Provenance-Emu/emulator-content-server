# ADR 0002: MIT license and clean reimplementation

This repository is MIT licensed. iCube continuity and web-server sources are GPL-2.0-or-later. Those files are behavioral references only. Do not copy their source, comments, or tests into this repository.

The wire model keeps the ideas that matter to the apps: a versioned manifest, relative paths, sizes, checksums, bearer-scoped pulls, and ranged reads. The implementation, route names, and storage layout are new.

Generated clients are MIT so other emulators, including RetroArch frontends, can vendor them.

## Consequences

- A GPL app can depend on this MIT server and client.
- A future decision to vendor GPL code requires a new ADR and a license change before any copy lands.
