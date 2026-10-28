# Matching providers and managers

## Bulk library matching

Open a library and choose **Library tools → Library activity → Find missing artwork and details**. Choose **Matching providers** to include online catalogs or adjust providers. The server owns the work: closing the panel, reloading, signing out or switching devices does not cancel it. Any signed-in owner session can inspect progress, cancel a job, resume remaining work or retry failed/unmatched outcomes. Folder scans and watchers use the same queue.

Equivalent active jobs reuse their work. Overlapping scopes with different options are rejected with a clear conflict rather than starting another disk pass. One worker processes bounded pages; the browser loads aggregate progress and 20 results at a time, not the whole collection. Jobs and review acknowledgements persist in SQLite. A running job interrupted by restart becomes **interrupted** and can be resumed; pending queued jobs start normally. Cancellation checks precede file work and catalog publication, preserving the last good folder index.

For local single ROMs or eligible single-ROM ZIPs up to 64 MiB, matching verifies checksums in 64 KiB chunks, with cancellation and file-change checks. Cached hashes are reused only for the same source identity/timestamps. Container hashes do not stand in for inner ROMs. Unique checksum candidates per unsaved category can save automatically. Conflicting systems, ambiguous exact matches, provider failures and filename-only suggestions remain reviewable. Existing saved categories are never replaced. A single box cover can also inherit the ROM's verified game identity when its complete canonical title and system agree with a checksum identity and the provider is healthy. Compatible legacy/regional aliases of the same verified ROM do not count as different games; conflicting game/edition facts still require review. This verifies which game the cover belongs to; it does not compare an image hash to the ROM. Other regional/revision suggestions do not prevent one exact canonical cover from being corroborated. Duplicate exact canonical covers, title screens, screenshots and filename-only evidence remain reviewable. Matching covers indexed server-folder games; managed uploads are not currently included.

**Results** filters review, failed, unmatched, saved and skipped outcomes. **Review** refreshes proposals before a save. **Save and next category** advances through unsaved categories; **Save and next game** or **Done reviewing this game** persists the review acknowledgement for other sessions. Failed saves stay pending. **Next unresolved game** leaves the current game unresolved. Retry actions reuse the durable job and recheck current selections rather than overwriting choices made elsewhere.

The former 50,000-entry lookup/run limit is removed. Companion lookup uses indexed normalized folder/stem/extension facts, backfilled for older catalogs without reading ROM bytes. See [shared library jobs](shared-library-jobs.md) for queue behavior, limits and the generated 100,000-file benchmark.

The owner can open a server-folder game and use **Metadata, artwork & patches**.
Click **Find matches** for local suggestions, or enable **Include online providers**
for Libretro. A lookup keeps the selected category when it has suggestions and
otherwise opens a category containing results. If loading saved choices fails
temporarily, use **Retry saved matches** inside the game; lookup suggestions are
kept while saved choices reload. Select **Save** on a candidate to keep one choice
per category. Saving metadata
publishes its title/details to people who can read the game; it does not grant
access to the original JSON sidecar. Saved titles participate in library search
and sorting, selected system IDs update system filters/counts, and selected artwork
appears on game cards. **Replace saved** changes that category; **Remove saved**
restores the inferred title/system or removes that association. Original files are
never renamed, rewritten, patched, or moved.

Use **Retry matching providers** if the provider list is temporarily unavailable.
Matching requires at least one selected provider that can run with the current
online setting. After an uncertain save/removal response, the panel reads saved
choices again before allowing another write. A confirmed commit is shown as
saved; a conflict keeps the current server choice and requires an explicit next
action. If that read also fails, **Retry saved matches** restores the current
revision without discarding lookup suggestions. Bulk matching rechecks category
and system choices after each save, preserving choices made during the run.

Local matching finds exact filename stems beside a game, or in its `artwork`,
`boxart`, `covers`, `patches`, and `metadata` subfolders. JSON sidecars may contain
string fields `title`, `description`, `developer`, `publisher`, `year`, `genre`,
and `region`. PNG, JPEG and WebP artwork is previewed through an authenticated,
size-limited endpoint. SVG is not accepted. A different region/edition remains a
different filename. Invalid sidecars do not prevent other providers from working.

BPS and UPS files supply base size and CRC only after the patch's own CRC passes.
IPS has no embedded base checksum and remains an unverified filename association.
A user can explicitly hash a local, single ROM up to 64 MiB; matching base CRC and
size upgrades the patch association. A different base CRC/size rejects the patch. A matching checksum can associate a differently named patch in the same folder or its `patches` subfolder.
No patch is ever applied by matching. Eligible ZIPs verify the single inner ROM without extracting it. Unsupported or ambiguous containers retain filename suggestions; their container hashes never stand in for inner-ROM identities. Identification plugins can supply verified hashes for an explicitly named extracted or normalized representation. The matching layer consumes those facts without reading the ROM itself.

The built-in **Game catalogs and artwork** provider keeps its stable `org.ecs.libretro` ID. It reads public No-Intro/Redump catalogs from the [Libretro database](https://github.com/libretro/libretro-database), supplements Jaguar with TOSEC, and supplements Atomiswave with Libretro’s arcade DAT. Naomi, Naomi2 and Atomiswave set IDs and GD-ROM serial aliases come from the public [Flycast game catalog](https://github.com/flyinghead/flycast/blob/master/core/hw/naomi/naomi_roms.cpp). Only scalar identity facts are parsed; upstream C++ is never evaluated. ROM bytes, local paths and server credentials are not sent to those hosts.

Filename suggestions recognize legacy years, language/scene tags, punctuation, leading/trailing articles and alternate localized names. Explicit conflicting regions, revisions and prototype dates remain separate. Compatible rows for the same game and release reconcile into one suggestion, with verified evidence preferred and complete original candidates retained in bounded `matchProvenance` metadata. Conflicting same-size hashes, serials, explicit regions/revisions/prototypes, or incompatible metadata remain separate. If complete provenance cannot fit the response bounds, the original suggestions stay separate. Short arcade set IDs (including duplicate-copy suffixes such as `beachspi-2.zip`) and documented disc serials remain **name** suggestions. Unknown source systems can receive explicit arcade suggestions; ambiguity never silently chooses a board. A name suggestion never becomes a checksum match or an automatic bulk save.

Artwork is looked up independently of metadata in complete public [Libretro thumbnail](https://github.com/libretro-thumbnails/libretro-thumbnails) Git trees, using the repository’s correct branch and a pinned tree revision. Only listed PNG files within size bounds are offered; tiny placeholders are skipped. Box art is preferred, with title screens/screenshots available where covers are missing. Jaguar CD uses the shared Jaguar artwork collection. Preview/save still fetches and validates the selected image through the authenticated server. This avoids guessed nonexistent URLs; a listed file can still be removed or invalid when fetched. Partial upstream failures preserve healthy results and show a provider failure for retry.

Public catalog text and indexes are cached for six hours in `cache/matching-catalogs` inside the data directory; missing files are cached for ten minutes. Atomic cache writes, bounded reads and body digests prevent an incomplete concurrent cache entry from becoming a match. A missing/unwritable cache falls back to a public fetch. Cancellation and size limits still apply. The HTTP process supplies the private cache location; matching/provider execution stays in the separate child process.

Coverage remains limited by the upstream catalogs. Legacy PD/homebrew filenames, unlisted prototypes, patched releases and regional arcade aliases may still have no suggestion. A scan does not fabricate metadata/artwork for those games. Existing saved choices remain preserved until explicitly replaced.

## Plugin contract

This extends the existing `ecs.plugin/1` engine with two app-independent kinds.
Providers declare capabilities: `rom`, `metadata`, `artwork`, `patch`, `cheats`.
Managers declare which provider IDs they coordinate. Built-in local and Libretro
providers use the same matching interface as installed JavaScript providers. The
current default manager ranks checksum matches before local associations and
filename hints, preserves provider attribution, and reports provider failures
without discarding healthy results. The fast scan-time system detector remains
available before a matching job; a provider's ROM/system suggestion is a preview.
Bundled `org.ecs.cheats.local` and `org.ecs.cheats.libretro` providers supply
RetroArch `.cht` associations. Local files can sit beside the game or in its
`cheats` subfolder, with optional known engine suffixes such as `(Game Genie)`.
The online provider reads the public Libretro cheat-directory index and selects
exact edition filenames within the detected system. Other regions/versions are
not silently substituted; cheat associations are filename hints, not checksum
verification. Anonymous GitHub API rate limits can temporarily stop this provider
without discarding results from healthy providers.

Saving a cheat selection downloads or reads the bounded file, validates its
RetroArch structure, and forces every code disabled. Download the saved `.cht`
for a compatible player and choose the codes there. Matching never applies cheats
to a running core. Malformed files or files above 256 KiB are refused. Cheat
content remains data, never an executable provider entry.

Install trusted provider/manager folders on the server, then run:

```sh
ecs serve --data /path/to/data --matching-plugins /path/to/plugins
ecs-plugins providers --plugins /path/to/plugins
ecs-plugins match --plugins /path/to/plugins --input /path/to/facts.json
# Explicitly allow providers that declare network access:
ecs-plugins match --plugins /path/to/plugins --input /path/to/facts.json --online
```

A provider's `plugin.json`:

```json
{
  "id": "example.metadata", "name": "Example metadata", "version": "1.0.0",
  "kind": "provider", "engine": "ecs.plugin/1", "entry": "provider.mjs",
  "provider": { "capabilities": ["metadata"], "network": false }
}
```

Its entry exports `{ search(input, signal) }`. The input contains a basename,
system identifier (or null), optional size/MD5/SHA1/CRC, optional bounded `RomFacts`, an explicit `online` boolean,
and bounded companion facts. It has no data-directory path or server token.
Return up to 100 candidates with `id`, `kind`, `title`, `confidence` (`checksum`,
`local`, `name`), and string-valued `metadata`. A candidate may reference a known
companion `fileId` or a credential-free HTTPS `url`. The web API refuses unknown
companion IDs. Generic remote artwork plugins can report URLs; the first web
preview implementation fetches remote pixels only from the built-in Libretro
thumbnail provider, plus authorized local companions.

A manager declares `"manager": {"providers": ["example.metadata"]}` and exports
`{ selectProviders(input, availableProviders) }`, returning its chosen provider
IDs. It can choose/order providers within that declared list. Request-level
provider selection and online opt-in still restrict the result. Manager plugins
are orchestration policies, not database or file managers.

Installed modules execute only in a separate Node child process, with a stripped
environment, a memory limit, bounded IPC, per-provider deadlines and a hard outer
deadline. Owner lookups and remote artwork share two active worker slots; closing
the request cancels the worker. Preview requests expire in fifteen minutes.
**This is process isolation, not an OS sandbox.** Installed JavaScript is trusted
operator code with that OS user's filesystem/network permissions. A manifest's
network declaration controls normal invocation, not a hostile module's syscalls.
Do not put secrets in manifests. Provider-specific credential configuration remains follow-up work.


## Evidence and artwork roles

`@ecs/plugins/matching` exports `reconcileCandidates(input, candidates)`,
`automaticEvidence(input, candidate)`, and `classifyArtwork(name, sourceType?)`.
The server must retain the private input facts and recheck automatic eligibility;
a provider's `confidence`, `hashVerified`, or other marker is never authority.
`checksum` describes bytes actually hashed in one explicit representation. A
byte-read serial can corroborate metadata and one exact canonical front cover
while retaining `name` confidence. Multiple distinct verified serials or verified
board systems keep all candidates for review; normalized punctuation aliases do
not create a conflict. A filename/set alias or declared container
header hash stays review evidence. No image checksum is compared with ROM bytes.

DAT records retain partial MD5/SHA1/CRC values, optional sizes, serial aliases,
and disk entries. Candidate string metadata includes available `md5`, `sha1`,
`crc32`, `hashSize`, `hashRepresentation`, `hashMedia`, `serials`/`setIds` (JSON
arrays), and `matchEvidence`. Same-representation checksum contradictions cannot
be hidden by a weaker matching checksum or serial. Distinct tracks may share a
game identity, but their original per-file evidence remains in provenance.
CHD disk catalog SHA1 is matched only to `chd-combined-sha1`, without comparing the
container or logical size to a missing disk size. The header is a declaration,
not verification: MAME itself compares disk entries against
[`chd_file::sha1()`](https://github.com/mamedev/mame/blob/master/src/emu/romload.cpp),
while [the CHD header](https://github.com/mamedev/mame/blob/master/src/lib/util/chd.h)
distinguishes combined and raw data SHA1. Redump track hashes are not assumed to
be CHD header hashes. Dreamcast serial fields come from the
[official Libretro Redump DAT](https://github.com/libretro/libretro-database/blob/master/metadat/redump/Sega%20-%20Dreamcast.dat).
Flycast set/GD-ROM aliases carry no invented ZIP checksum. A canonical arcade
cover may include a serial suffix, such as `Game (GDS-0001)`, only when that exact
normalized ID is both catalog-declared and verified from the selected content.
Unmatched suffixes and duplicate canonical cover aliases remain reviewable.

Artwork keeps the `artwork` capability and carries `metadata.artworkRole`:
`front`, `back`, `disc`, `manual`, `title`, `screenshot`, or `other`.
`classifyArtwork` returns `{ role, baseTitle, explicit }`, recognizes terminal
labels such as `[back]`, `CD label`, and `manual`, and recognized directories or
source tags. Plain images retain the existing front-cover convention.
`Named_Boxarts`, `Named_Titles`, and `Named_Snaps` retain front/title/screenshot
roles. Remote lookup offers only listed files from those existing upstream
indexes; it does not fabricate backs, disc labels or manuals that are absent.
Local explicitly labeled manuals can be PDFs (`imageKind: "pdf"`); other local
images use `imageKind: "image"`. Back/manual/disc assets never automatically
replace the primary front cover. Independent roles are independent selections,
not conflicting covers.

Patch candidates may carry `patchType: "translation" | "rom-hack" | "patch"`
from explicit filename tags. BPS/UPS base CRC and size can match a verified
normalized/extracted ROM representation, never an unverified archive declaration.
A future translation/hack provider should publish the expected base hash, size,
representation and release provenance plus an immutable asset URL/digest. These
remain ordinary matching providers in the isolated plugin process; discovery is
not permission to apply a patch.

A consolidated public catalog can be produced offline from pinned, attributed
source datasets and exposed through this same provider contract. A useful bundle
must retain source revisions/licenses, per-representation hashes, exact release
and serial aliases, artwork roles and immutable asset references. Publishing
that bundle and redistributing image/manual assets require separate source and
license review; the current runtime neither scrapes arbitrary artwork sites nor
claims missing catalog coverage.

## Persistence and access

Selections and immutable content snapshots are saved in additive SQLite migration
11. They survive server restarts and catalog backups. Artwork is capped at 2 MiB;
patches and cheats at 256 KiB. Saved binary companions keep their original source
kind's access rules, so an ordinary guest cannot acquire a restricted sidecar by
following its association with a public ROM. Saved metadata is deliberately game
metadata, as described above. Content is served only through authenticated,
source-authorized endpoints with private cache headers.

Each source has a matching revision across its selected categories. Writes use
that revision to reject stale edits; retrying the same selected candidate is
idempotent. Source and companion filesystem validators are checked before and
after materializing a selection. If either changes after lookup, run Find matches
again. Candidate proposals expire after fifteen minutes; saved selections do not.
Snapshots remain readable when a folder goes offline. Explicitly removing a
source/root removes its associated selections along with the catalog entry.

Owner-only PUT at `/api/v1/sources/{sourceId}/matches/selections` selects a match;
DELETE at that path plus `/{kind}` clears the choice. Authorized readers GET the saved state and the
`/{kind}/content` snapshot without rerunning online matching. Clearing a selection
does not remove or modify any original companion file.


With an enabled folder organization policy, successful metadata, artwork and system
saves also perform the opted-in Copy/Move. Automatic Move waits for pending local
metadata/artwork choices. After a move, review refreshes proposals before continuing;
if refresh fails, the choice stays saved but stale suggestions are blocked until
**Find matches** succeeds. Library auto-matching also refreshes proposals after a
move or a reconciled uncertain save. Organization warnings stay visible for review;
they do not roll back the saved match.
