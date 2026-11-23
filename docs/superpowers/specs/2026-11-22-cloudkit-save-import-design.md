# Bringing saves from iCloud to the server

Status: proposed, nothing built. Date: 2026-11-22. Needs one spike against Apple's service before any of it is trusted (see "Unverified").

## The situation

The computer that runs the server holds the original game files. The owner copied those games to phones, tablets and TVs over the years and played them there, so the saves live on the devices. Provenance has been syncing those saves to the owner's iCloud. The server sees every game and almost no saves.

Two-way sync from the apps to this server is the long-term answer and is built in the app repositories. This design is the backfill: read what is already in iCloud once, attach it to the games the server already has, and keep doing so until every app syncs here on its own.

## What is in iCloud

Read from the Provenance checkout (`PVLibrary/Sources/PVLibrary/Cloud Sync/iCloud`), not from Apple:

- Container `iCloud.org.provenance-emu.provenance`; development builds use `iCloud.org.provenance-emu.provenance.dev`. The app reads and writes the **private** database.
- Record types: `ROM`, `SaveState`, `BIOS`, `File`, `Metadata`.
- `SaveState`: `filename`, `directory`, `systemIdentifier`, `gameID` (the game's primary key, which is its MD5), `coreIdentifier`, `coreVersion`, `fileData` (the save file), `fileSize`, `imageAsset` (its screenshot), `lastUploadedDate`, `lastModifiedDevice`, `metadataJSON`.
- `File`: everything that is not a database row, filtered by `directory`: battery saves, screenshots, cheats.
- `ROM`: `md5`, `systemIdentifier`, `originalFilename`, `crc`, play statistics (`lastPlayed`, `playCount`, `timeSpentInGame`, `rating`, `isFavorite`), and an optional custom cover (`customArtworkAsset`).

The server already keeps MD5 and CRC for a game, so `SaveState.gameID` and `ROM.md5` are enough to find the matching game without guessing from names.

## What the owner does

Settings gets one entry, **iCloud saves**, owner only:

1. **Connect iCloud.** Opens Apple's sign-in. The owner signs in with the Apple account their devices use.
2. The page shows what it found before copying anything: how many saves, for how many games, how many of those games are in this library, and how much space they take.
3. **Bring them in.** Saves for games the server has are copied in and appear on each game's page with the device they came from and their date. Saves for games it does not have are listed, not copied.
4. A switch, off until the first import succeeds: **Keep checking for new saves**. A quiet check a few times a day.
5. **Disconnect** forgets the sign-in at once. Saves already copied stay.

Nothing here needs a flag or a second screen to start working, and nothing is deleted.

## Rules

- **Read only.** The server never writes, changes or deletes a record in iCloud. The apps depend on that data; a bug here must not be able to damage it. The integration is built with no write call at all.
- **Never lose a save.** An imported save is added beside what is there. It never replaces a save already on the server, even an older one for the same game and slot; both are kept and the game page shows both.
- **Same save, once.** Saves are stored by SHA-256 like every other file, and the record name and change tag of each imported record are remembered, so a second import copies only what is new.
- **Owner only, their own account.** This reads the iCloud of whoever signs in. It is offered to the owner and is never available to a member or a guest link.
- **Honest.** `GET /api/v1/capabilities` reports the feature only when the server has been given an API token for the container.

## How the server reads iCloud

Apple's CloudKit web service allows a private database to be read on behalf of a person who signed in with their Apple account in a browser. Two values are involved:

- An **API token** for the container, created once in the CloudKit dashboard by whoever owns the container. It identifies the application, not a person. The operator supplies it in the server's configuration; without it the feature is absent.
- A **web auth token** for the person, handed back by Apple after sign-in. It is short-lived and Apple replaces it on every call.

The server makes the calls itself (list changes in the zone, look up records, download each asset from the address the record gives). No Apple script is loaded into the web interface, which keeps the page's content policy as it is.

### The sign-in token

Apple returns the web auth token to a redirect address as a query parameter. This project's rule is that no credential travels in a query string, so the design fences that one hop:

- The redirect lands on a single-purpose page served by this server with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Its only script (a file, not inline) reads the parameter, replaces the address with one that has no query, and posts the token to the server in a request body.
- The route is exempt from request logging of the address, and the audit row records "iCloud connected" with the owner's id and nothing else.
- The server keeps the token encrypted at rest beside the catalog, never returns it from any endpoint, and replaces it with the fresh one Apple sends on each call.
- If the dashboard allows the token to be delivered by message between windows instead of a redirect, use that and drop the redirect page.

This is an authentication and storage change and gets one `ecs-reviewer` pass before it merges.

## Where the work goes

- `packages/plugins` gains a connector port for "an outside source of saves", and the CloudKit reader lives in the plugin host (`apps/plugins`), not in the HTTP process. It reaches Apple; the content server does not.
- The content server gets additive v1 endpoints: start a connection, finish it, preview, import as a library job, status, disconnect. Import runs as a library job so progress, cancel and results use the screen that exists.
- A migration records, per imported record: container, record name, change tag, the save it became, and when.
- `apps/web`: the Settings entry and the preview list. Plain words; record names and container ids sit under Details.

## Order

1. **Spike** (throwaway, outside the repository's shipped code): sign in against the development container, list `SaveState` records, download one asset. This settles every item under "Unverified".
2. Contract and migration; preview only (counts, no copying).
3. Import as a job, with the matching by MD5 and the "both are kept" rule under test with generated bytes.
4. Periodic checks.
5. Later, if wanted: play statistics and custom covers from `ROM` records; battery saves and screenshots from `File` records.

## Unverified

Written from memory of Apple's documentation and from reading the app's source. None of it has been run:

- That a web auth token can read this container's private database with the API token type the dashboard offers today, and how long a token lasts with and without "stay signed in".
- Whether the redirect address may be a loopback or home-network address, which decides whether sign-in can finish on the server's own page or needs the owner's public address.
- Whether the saves sit in the default zone or a custom one, and whether assets over a certain size need a different download call.
- Whether `gameID` is always the MD5 in records written by older app versions.
- Whether the production container's schema is deployed with the indexes the queries need (`gameID`, `md5`), or whether the import has to walk zone changes instead of querying.

## Not in this design

- Writing saves back to iCloud. The apps do that.
- Importing games or BIOS files from iCloud. The server has the originals, and BIOS files are restricted content.
- iCube, iFly or any other app's container. Each would be another entry behind the same connector port.
