# Matching and UI acceptance — 2026-10-29 UTC

The live library started with 918 games, 325 review outcomes, 334 unmatched,
420 metadata selections and 176 front covers. After the two focused passes it
has 250 review outcomes, 327 unmatched, 430 metadata selections and 261 front
covers. All 596 selections present before this batch retained their exact JSON
and content bytes. The final pass also preserved all 690 selections present at
its start. The matching jobs saved 93 and one additional selections respectively;
a concurrent user selection accounts for the remaining difference in totals.
Neither pass overwrote an existing category/role choice.

## Changes

- A private snapshot of saved metadata can identify a missing front cover. It
  binds the saved record ID, matching revision, title and system. Current verified
  hash/serial contradictions reject the anchor. The proposal is checked before
  and after download, with the existing database compare-and-swap protecting the
  final write. Metadata saved during a job triggers a new lookup so its front can
  be found in the same job.
- Artwork aliases include exact saved catalog ROM filenames and compatible source
  provenance. Edition, alternate-scan and patch tags remain significant. Multiple
  paths to the same Git blob/size deduplicate; different pictures remain separate.
- Explicit trailing Rev/Version/v-number forms reconcile with their parenthesized
  forms. Complete alternate-title sets may reconcile across Redump/Flycast when a
  verified shared serial corroborates them. One shared component of a compilation
  is insufficient. Every source original remains in provenance.
- A bounded CDI identification plugin reads the validated descriptor and first
  sectors of data tracks. It supports DiscJuggler v2/v3/v3.5 layouts and emits
  IP.BIN serials, with no whole-image checksum claim. Generated regressions cover
  corrupt/truncated descriptors, raw sector layouts, cancellation, conflicting
  IDs and byte-exact magic. Read-only local acceptance identified 32 of 77 CDI
  files; 15 were correctly rejected as another system and 30 lacked supported IDs.
- Job rows now explain ambiguous editions, front-cover review, verified-byte
  catalog misses and unavailable disc identification separately.

## Why unresolved games remain

The final unmatched set includes 237 files with verified hashes but no matching
catalog record, 80 without a supported game ID, and ten multi-file discs lacking
an identity reader. Of the original unmatched Jaguar set, 236 already had verified
hashes, and 219 filenames carried public-domain/homebrew tags. Strictly validated
JagServer/COFF/DRI payload hashes also failed to match the pinned catalog, so no
speculative header stripping or padding removal was introduced.

Missing authoritative homebrew records, bounded multi-ROM/disc archive readers,
large 7z handling and multi-file CUE/GDI identity readers remain follow-ups.
Different front-cover scans and genuinely different editions remain reviewable.
No generic filename guess is represented as verified ROM identification.

## UI defaults

Library activity now shows only Find and Scan as primary actions; maintenance is
secondary, progress precedes settings, and each matching screen has one Matching
options disclosure. Shared semantic CSS tokens and reusable layout patterns govern
control height, padding, alignment, cards, forms and action rows. MatchMetadata
shows readable game fields and puts identifiers/provenance behind Match evidence.

Skeleton provides a styled Svelte design system; shadcn-svelte provides owned
components based on Tailwind/Bits UI; Bits UI is mostly unstyled. This batch
consolidates the existing native Svelte/CSS layer rather than introducing a new
styling stack during the behavior fixes. Global defaults and usage examples are
in `docs/ui/design-language.md` and `apps/web/src/app.css`.

## Validation and operation

Focused matching suites passed (85 cases for the initial changes, 70 for final
alias guards). Server/source-selection/CDI suites passed 19 cases. Svelte checking
and 244 web unit tests passed; all 18 matching/bulk browser cases passed, including
390×844 layout, visible progress, 44px phone targets and evidence disclosure.
TypeScript, client drift, package boundaries and the secret/fixture scan passed.

The first live job was interrupted by a full data volume after 779 games. Only
reproducible task-owned source/download/build caches were removed; no game files,
private data or backups were deleted. The durable job resumed its remaining work
and completed with zero failed game outcomes. Its acceptance-only session was
revoked after space recovery. Graceful SQLite-full worker failure without a
service restart was subsequently fixed in the
[remount and queue recovery follow-up](library-remount-recovery-2026-10-29.md).
Backups and choice digests
are kept in the ignored private release directory.

Virtual Jaguar's separate playback profile correction is documented in
`jaguar-cd-hle-acceptance-2026-10-28.md`. The audited source was already 3.10.0;
the previous ECS wrapper had disabled CD. No claim of old upstream CD limitations
is made by the updated profile.
