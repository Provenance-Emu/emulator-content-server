# Fixtures

Tests create their own bytes in temporary directories. Do not add commercial ROMs, BIOS files, disc images, or save files to the repository, issues, or logs.

`scripts/secret-scan.mjs` rejects common copyrighted fixture extensions anywhere outside dependencies and build output. A regression test that needs structured bytes should write them at runtime, as the range and sparse-file tests do.

Metadata samples may use invented titles and the public system identifiers documented in `docs/compatibility/provenance.md`.
