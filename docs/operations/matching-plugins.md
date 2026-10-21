# Matching providers and managers

## Bulk library matching

Open a library and choose **Match library** → **Start library matching**. The run
collects every Games page before saving anything, then processes server-folder
games one at a time through the same selected provider and manager plugins as
individual matching. Library search, system and folder filters do not restrict
the run. Managed uploads and offline source files are listed under **Skipped**.

For local single ROMs up to 64 MiB, a lookup verifies the checksum. A unique
checksum candidate per unsaved category is saved automatically. Multiple exact
candidates, conflicting system IDs (including an existing selected system),
provider failures, and filename-only suggestions require review. Existing saved
categories are never replaced by a bulk run. Patch and cheat selections remain
associations; nothing is applied to a game. Artwork without checksum evidence
also needs review, even when its game's metadata was verified.

**Needs review** opens the shared matching panel with fresh suggestions and the
same provider options, avoiding expired proposal IDs. Save the choices you want,
then choose **Done reviewing this game**. Results are paginated, with separate
filters for failures, unmatched games and skipped files. **Retry failed games**
loads current selections again; revision conflicts never trigger an automatic
overwrite. Partial provider failures appear in both **Needs review** and **Failed**
and can be retried without repeating healthy games. **Done reviewing this game**
also removes that game from the retry list. Online cheat indexes are optional in
bulk runs because anonymous GitHub API limits are small; local cheat matching
remains selected by default.

**Pause matching** cancels the active request; **Resume matching** continues
remaining games. Closing the panel keeps the run going while you browse this
library. Keep the app open: reloading, signing out, changing servers or leaving
the library clears the in-memory run and review queue. All selections already
saved remain in the catalog, and a new run preserves them. The run is limited to
50,000 entries and uses existing authenticated, revision-checked matching APIs;
providers never run in the browser.

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
No patch is ever applied by matching. Archive and disc-container hashes are not
used as if they identified an inner ROM; those entries use filename suggestions.

The Libretro provider downloads public no-intro/redump DAT catalogs from the
[Libretro database](https://github.com/libretro/libretro-database). Its initial
system mapping covers Jaguar/Jaguar CD, NES, SNES, Game Boy/Color/Advance, N64,
Genesis, Master System, Game Gear, PlayStation, Saturn, and Dreamcast. Missing
catalogs yield no suggestions. It compares checksum plus size first, then exact
edition filenames. Thumbnail candidates use the
[Libretro thumbnails](https://github.com/libretro-thumbnails/libretro-thumbnails)
box-art names, offering both the original filename and matched catalog title when they differ. Artwork remains a filename suggestion even when the ROM itself matches a checksum. Existence is checked only when Preview is requested, so some art
may be unavailable. Lookup sends no ROM bytes, local paths, or server credentials
to Libretro. A thumbnail request reveals the selected public title to its host.

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
system identifier (or null), optional size/MD5/CRC, an explicit `online` boolean,
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
