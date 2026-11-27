# Bringing game details and covers in from iCloud

Status: design only, nothing built. Date: 2026-11-27. Follows `2026-11-26-native-icloud-reader-design.md`, which already brings saves and play history through the reader on the Mac.

## The situation

Provenance keeps a record in iCloud for every game. Beside the play history that is now brought in, each record carries the game's title, description, developer, publisher, release date, genres, region and language, and sometimes a cover the person chose themselves (`customArtworkAsset`). The owner asked for their edits to come across.

Two facts shape the design:

- **Provenance does not say which values the person edited.** Most of those fields are filled from the same public game database this server matches against. Only two things are clearly the person's own: a custom cover, and a title that differs from what the database or the file name gives. So "bring my edits" cannot be done exactly; what can be done safely is "fill what this server does not know, and bring the cover I chose".
- **This server already has a place for a game's details, and rules about who may change them.** A scanned file's details are one saved record per file (`source_match_selections`, kind `metadata`), and its cover is another (kind `artwork`, role `front`). A record a person typed or chose on the server is marked `providerId: manual`, and automatic matching never replaces it.

## Rules

- **Fill, never override.** A value already on the server stays, whoever put it there. iCloud only supplies what is missing.
- **A choice made on the server always wins.** Nothing from iCloud replaces a `manual` record, a field in one, or a cover the owner chose here.
- **The person's own cover counts as a choice.** A cover they picked in Provenance replaces one this server fetched automatically, and is in turn replaced by one chosen here. It is kept so automatic matching does not swap it back.
- **Once per version.** Each game record is applied once per change in iCloud. If the owner clears a field on the server afterwards, it is not filled again until that record changes in iCloud.
- **Read only, owner only, nothing lost.** As with saves: nothing is written to iCloud, only the owner can run it, and every change it makes can be undone from the game's details screen.

## What is brought in

| From Provenance | To the server | Rule |
| --- | --- | --- |
| `title` | the details record's title | Only when the game has no details record yet, so its title is just the file name |
| `gameDescription` | `description` | Fill if empty |
| `developer`, `publisher` | the same | Fill if empty |
| `publishDate` | `year` | The four-digit year, fill if empty |
| `genres` | `genre` | Fill if empty; Provenance's comma-separated list as it is |
| `regionName` | `region` | Fill if empty |
| `language` | `language` | Fill if empty |
| `customArtworkAsset` | the front cover | When the current cover was not chosen on the server |

Not brought in: `originalArtworkURL` and `boxBackArtworkURL` (addresses, not the person's files; this server finds its own artwork), `rating` and `isFavorite` (the server has neither yet), `referenceURL`, `releaseID`, `regionID`.

## Where a value came from

A new provider name, `provenance`, beside `manual`:

- A details record written here because the game had none is saved with `providerId: provenance`, `confidence: local`.
- Automatic matching treats `provenance` as it treats `manual`: it does not replace the record. Otherwise the next matching run would undo the import. Whether that is the right trade is open question 1.
- When iCloud only fills blanks in a record that automatic matching wrote, the record keeps its provider. Which fields came from iCloud is not recorded; the fields are simply no longer empty.
- A cover from Provenance is saved with `providerId: provenance` and the identifier `provenance:artwork:<sha256>`, the way a hand-chosen one is `manual:artwork:<sha256>`.
- The owner editing details or choosing a cover on the server turns the record `manual`, as today. From then on iCloud leaves it alone.

In the interface the details screen already says where a record came from behind its disclosure; it would say "From Provenance" for these. No identifier or hash is shown.

## How it travels

Everything rides on what exists.

- **Details.** The reader already sends a description of every game with each listing. It gains the fields in the table above, the record's change tag, and one flag: whether a custom cover exists. No file is sent with the listing.
- **Covers.** The server asks for a cover the way it asks for a save: a `fetch` naming the record and, new, which file of the record it wants (`fileData` for a save, `customArtworkAsset` for a cover). The reader fetches that one field and uploads it to the same endpoint. The server checks it as it checks a hand-uploaded cover: PNG, JPEG or WebP by its first bytes, within the size limit for a chosen cover. Anything else is dropped and counted.
- **When.** With **Bring them in**. The preview says what would happen before anything is copied: "Details for N games and covers for M games can be brought in." The import result says what was done.

## Applying it

For each game record whose game the server can find (by MD5 or by the file, as for saves), and whose change tag has not been applied:

1. Read the file's current details record and its revision.
2. If there is none: write one from iCloud's values (`provenance`).
3. If there is one and it is `manual`: skip.
4. Otherwise: add only the fields that are empty; leave the title alone; keep the provider.
5. If a custom cover exists and the current front cover is not `manual`: ask the reader for it, check it, save it as the front cover (`provenance`).
6. Record the record name and change tag as applied.

Writes use the same function and the same revision check a hand edit uses, so a change made on the server at the same moment wins and the import skips that game until next time. Each write bumps the file's revision and appears in the change feed, so apps see it like any other edit.

The applied-once ledger is the table saves already use (`save_imports`, migration 28) under a second origin, `icloud:<container>:games`. No new table.

## What is not covered

- **Games that were uploaded rather than scanned.** An uploaded game has a title and nothing else; it has nowhere to keep a description or a developer. Their details are not brought in. Giving uploaded games details is its own piece of work.
- **Favourites and ratings.** The server would need the feature first.
- **Knowing an edit from a database value.** A description the owner rewrote in Provenance fills a blank here but does not replace a different description the server already matched. The owner can paste it in on the details screen, which makes it `manual`.
- **The web sign-in route.** It could carry the same fields later; it is untested against Apple and is not extended here.
- **Sending details back to iCloud.**

## Contract

Additive:

- `IcloudReaderGameDescription` gains `changeTag`, `description`, `developer`, `publisher`, `year`, `genre`, `region`, `language`, `hasCustomCover`.
- `IcloudReaderFetch` gains `file`: `save` or `cover`.
- `IcloudPreview` gains `detailsToBring` and `coversToBring`; `IcloudImport` gains `detailsUpdated`, `coversUpdated`.
- The details and cover answers already carry a provider name; `provenance` is a new value there.

## Work

1. Contract, `pnpm generate`, `pnpm update-surface`.
2. Reader: the extra fields on the listing; fetching one named file of a record.
3. Server: the mapping, the fill rules, the cover check, the ledger origin, counts in the preview and result. Automatic matching leaves `provenance` records alone.
4. Web: the preview and result sentences; "From Provenance" in the details disclosure.
5. Tests: fills blanks only; never touches `manual`; title only for a game with no record; a cleared field is not refilled until the record changes; a cover replaces an automatic one and not a chosen one; a file that is not an image is dropped; a stale revision skips the game; applied once.
6. One `ecs-reviewer` pass: it writes catalog records.
7. A live run on the laptop against a throwaway server, as for saves and play history.

## Open questions

1. **Should a details record from Provenance block automatic matching for that game, as proposed?** The alternative is to let matching replace it, on the grounds that both draw on the same database and the server's match is fresher. Blocking protects a title or description the owner did edit in Provenance; replacing gives more consistent details across the library. Proposed: block, because losing an edit is worse than a stale field, and the owner can re-match a game by hand.
2. **Should the owner's cover from Provenance replace an automatic cover without asking?** Proposed: yes, with the count shown in the preview first. A per-game choice would be safer and much slower for 685 games.
3. **How many custom covers are there, and how big?** Not measured. If it is hundreds, the import should bring them after the saves and show progress for them separately.
4. **Does a different title in Provenance mean an edit?** Not reliably. The design therefore only uses it where the server has nothing. If the owner wants their titles everywhere, that is a different rule ("Provenance's title wins unless changed here") and should be a setting chosen once, not a guess.
