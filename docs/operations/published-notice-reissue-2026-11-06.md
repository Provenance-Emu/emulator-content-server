# Published recovered notices, 2026-11-06

The consolidated notice revision supplies ten custom player packages and their
corresponding-source archives. The companion JSON binds every revised artifact,
its original verification receipt, the retained runtime hashes and each carried
notice file. Existing installations retain their pinned version until explicitly
reinstalled through the existing catalog flow.

All ten packages include the matching author-published SHA1 FPL grant and recovery
provenance. PCFX additionally carries the complete historical IJG release 4 README,
required attribution and documentation of the compared Mednafen modifications.
The corresponding-source archives carry the same materials under `notices/`.

Every original package resource was compared directly after repacking. Every
original source member, file hash, link target, mode and size was checked through
a complete reread of the newly compressed archive. Each revised archive includes
`REPACKAGE-NOTICES.mjs` and a hash-bound file table to reproduce the entire revised
package after rebuilding the original runtime with its existing recipe.

The release notice bundle also preserves previous release notice sidecars and
original catalog provenance. Future manual buildbot runs add the same scoped
materials to packages, source archives and release assets, and verify the complete
notice-bearing package when source-rebuild verification is requested.

The original runtime reconstruction evidence remains applicable through exact
resource identity and original-source member preservation. The independent SDK
source reconstruction and component-specific final-code notice scope remain open.
The IJG recovery retains its historical mirror provenance and signature limitation.

[Consolidated notice release](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/browser-core-notices-2026.11.06.1)
