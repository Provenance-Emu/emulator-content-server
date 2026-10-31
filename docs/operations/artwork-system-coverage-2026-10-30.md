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

Large MAME and CPS collections now fetch only the front-cover subtree. Both root
and child indexes must be complete, bounded and SHA-addressed; image URLs retain
the root revision, not the directory tree SHA. Unrelated screenshot trees are not
loaded. Real upstream acceptance indexed 6,060 MAME fronts and verified a pinned
PNG with HTTP 200. Other collections retain their existing title/snapshot lookup.

## Running-library acceptance

The loopback LaunchAgent now uses the detached `system-artwork-20261030/server`
snapshot. The existing committed UI snapshot was retained while another interface
workstream was active. Before activation, the SQLite catalog, LaunchAgent and 771
saved-choice digests were backed up privately.

Two independent owner sessions joined the same shared matching job. It processed
all 918 items in 7.7 seconds, with zero failures or skips, adding 34 front covers
(32 Naomi and two Naomi 2) and two metadata choices (one for each board family).
Every previous selection JSON and content byte remained identical. The library
now has 475 metadata choices and 332 fronts; review results fell from 234 to 198,
while 310 items remain unmatched. All 35 Jaguar CD groups retain metadata, with
17 fronts. Temporary acceptance sessions were revoked and no jobs remain active.

The new [Atari 7800 package](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/v0.1.6-prosystem.1)
was installed through the real owner-only catalog API, with the current default
emulator preserved. Its loader/WASM digests and parsed package match the published
pin. The package's original-program opaque-frame acceptance and remaining Safari,
commercial-game and synchronized-save limits are recorded in the
[browser system audit](browser-system-coverage-2026-10-30.md).

The changes passed focused matching, evidence, hosted-catalog, saved-choice, disc,
artwork-role, player-catalog and build-helper checks, plus TypeScript, Biome,
package boundaries and the secret/fixture scan. No protocol, migration, native
shell or desktop-installer rebuild was needed.
