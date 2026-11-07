# November 7 component notice publication

Release [`browser-core-notices-2026.11.07.1`](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/browser-core-notices-2026.11.07.1)
contains revised Atari800 and Potator packages and corresponding-source archives.
Atari800 adds the complete incorporated Caprice32 banner. Potator adds the three
complete M65C02 banners. Existing FPL grant materials remain included. The component
scope and final-code witnesses are recorded in `notice-closure-2026-11-07.json`.

Both original loader/WASM pairs were compared directly and remain unchanged. All
28,798 original archive members passed a full independent reread with their content,
mode, type, size and link targets preserved. Standalone recipes extracted from the
new source archives reproduced the complete revised packages using the retained
rebuilt runtimes. This publication did not recompile any runtime.

The new aggregate catalog explicitly inherits the other eight November 6 packages,
sources and verification. Their package/source URLs and pins are unchanged. The
aggregate notice ZIP preserves the prior materials and adds the four banners and
component evidence. `published-notice-reissue-2026-11-07.json` distinguishes the two
fresh reissues from the eight inherited profiles and binds the previous receipt.

All eight uploaded assets matched GitHub's server-reported SHA-256 digests and
sizes before publication. Fresh public downloads of both packages, the aggregate
catalog and the notice ZIP then matched their local bytes directly. Source archives
were verified completely locally and against their uploaded server digests.

This closes the identified Caprice32 distribution-material gap and carries the
complete Potator banners conservatively. Broader component consolidation remains
open, including the additional live components and inlining scopes enumerated in
the component evidence. SDK reconstruction and the two upstream byte mismatches
remain separate scopes in issue #29.
