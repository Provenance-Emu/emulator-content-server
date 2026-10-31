# Artwork system coverage — 2026-10-30

Artwork lookup now maps 66 canonical Provenance system identifiers to public
Libretro thumbnail collections, up from 20. This includes GameCube, Wii, Jaguar,
Jaguar CD, Dreamcast, Naomi, Naomi 2, Atomiswave, Atari 2600/5200/7800, Game Boy,
Game Boy Color, Game Boy Advance, NES, SNES, Game Gear and Virtual Boy. It also adds
Sega CD/32X/SG-1000, PC Engine/CD/SuperGrafx/PC-FX, Lynx, Neo Geo variants,
WonderSwan variants, FDS, DS/3DS, PS2/3DO, CPS/MAME and other mapped home systems.

The mappings were checked against the upstream thumbnail submodule inventory.
Every configured No-Intro/Redump DAT path was also checked against the pinned
Libretro database directory listings. Systems without a configured bounded DAT
can still find filename/artwork suggestions; this is not a claim of a complete
metadata database, playable WASM core or installed player for every system.
The hosted catalog remains independently pinned; supported supplemental DATs use
the existing bounded/cached provider fallback. No new game files leave the host.

## Saved identity and release safeguards

An exact cover remains preferred. When no exact cover exists, a saved metadata
identity can associate a unique front despite article/punctuation, region aliases,
optional language labels, equivalent complete alternate-title separators or a
matching declared GD-ROM serial. This remains saved-choice evidence, never a new
claim of ROM checksum or embedded-serial verification.

Explicit region, language, revision and date disagreements remain blocked. Mixed
tags such as `(Japan, Rev A)` now expose their revision instead of hiding it from
the comparison. Unknown edition tags, including disc number, alternate dumps,
reissues and translation markers, must agree. A compilation cannot collapse to a
single overlapping title. Unmatched serial suffixes remain distinct. Multiple
different cover scans stay reviewable, and the Jaguar CD source's unverified
regional/reissue scans retain their mandatory review flag.

Common Atari and handheld extensions now participate in content-name matching.
Metadata and artwork choices already saved by the operator remain authoritative;
the shared queue fills missing slots rather than replacing selections.

## Validation

Generated-data regressions cover saved serial associations, stale/changed saved
identity, conflicting release tags, compilation boundaries, multiple scans,
exact-cover preference and the added system/extension routing. Matching/provider,
hosted-catalog, saved-selection, disc and artwork-role server regressions pass.
All current local saved choices were backed up before the live acceptance pass.
