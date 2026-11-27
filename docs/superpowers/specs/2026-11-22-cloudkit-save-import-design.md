# Bringing saves from iCloud to the server

Status: first version built (connect, preview, import of save states from Provenance). The first live sign-in was refused by Apple; see "Live check". Dates: proposed 2026-11-22, revised 2026-11-25 after reading the apps' sync code and Apple's web service reference.

## The situation

The computer that runs the server holds the original game files. The owner copied those games to phones, tablets and TVs over the years and played them there, so the saves live on the devices. Provenance has been syncing those saves to the owner's iCloud. The server sees every game and almost no saves.

Two-way sync from the apps to this server is the long-term answer and is built in the app repositories. This design is the backfill: read what is already in iCloud, attach it to the games the server already has, and keep doing so until every app syncs here on its own.

## What is in iCloud

Read from the Provenance checkout (`PVLibrary/Sources/PVLibrary/Cloud Sync/iCloud/CloudKit`):

- Container `iCloud.org.provenance-emu.provenance`; development builds use `iCloud.org.provenance-emu.provenance.dev`. The app uses the **private** database and the **default zone**.
- Record types written: `ROM`, `SaveState`, `BIOS`, `File`.
- `SaveState`: record name `savestate_<gameID>_<filename with dots as underscores>`. Fields `filename`, `directory`, `systemIdentifier`, `gameID`, `coreIdentifier`, `coreVersion`, `fileData` (the save file, an asset), `fileSize`, `imageAsset` (its screenshot), `lastUploadedDate`, `lastModifiedDevice`, `metadataJSON`. One record is one save state.
- `gameID` is the game's MD5 in upper case. Records written by very old versions may carry an internal identifier instead; those cannot be matched and are listed, not guessed at.
- `File`: battery saves, screenshots and cheats, told apart by `directory`. A battery save is filed under `Battery States/<game file name>/…` and carries no MD5, so it has to be matched through the `ROM` record with the same file name.
- `ROM`: record name `rom_<MD5>`, with `md5`, `systemIdentifier`, `originalFilename`, `crc`, play statistics and an optional custom cover.
- `lastModifiedDevice` is the device's vendor identifier, not a name a person would recognise.

The app lists save states in production with a match-everything query, so the index that query needs is deployed. Zone changes cannot be used: Apple offers them for custom zones only.

iFly keeps `FlycastSaveFile` records in zone `FlycastSaves` of `iCloud.com.joemattiello.iFly`. iCube keeps `iCubeUserFile` records in zone `iCubeUserData` of `iCloud.com.joemattiello.iCube`. Both apps are already entitled to Provenance's container and do not use it.

## What the owner does

Settings gets one entry, **iCloud saves**, owner only:

1. **Connect iCloud.** Opens Apple's sign-in in its own window. The owner signs in with the Apple account their devices use.
2. **Look for saves** shows what is there before copying anything: how many saves, for how many games, how many of those games are in this library, and how much space they take.
3. **Bring them in.** Saves for games the server has are copied in and appear with each game's files. Saves for games it does not have are counted and listed, not copied.
4. **Disconnect** forgets the sign-in at once. Saves already copied stay.

Nothing here needs a flag or a second screen to start working, and nothing is deleted.

## Rules

- **Read only.** The server never writes, changes or deletes a record in iCloud. The reader has no write call at all.
- **Never lose a save.** An imported save is added beside what is there. It never replaces the live save for a game: where a save already sits at the same path, the imported one is kept beside it as a conflict copy for a person to choose between.
- **Same save, once.** The record name and change tag of each imported record are remembered, so a second import copies only what is new. Bytes the server already holds are stored once.
- **Owner only, their own account.** This reads the iCloud of whoever signs in. It is never available to a member, a trusted-network device, or a guest link.
- **Honest.** `GET /api/v1/capabilities` reports `icloudSaves` only when the server has an API token for the container.

## How the server reads iCloud

Apple's CloudKit web service lets a private database be read on behalf of a person who signed in with their Apple account. A server key cannot do this; it reaches the public database only. Two values are involved:

- An **API token** for the container, created once in the CloudKit Console by whoever owns the container, with the sign-in callback left at its default (a message to the opening window) and any origin allowed. It identifies the application, not a person, and is the same kind of value Apple expects to be embedded in a web page. The server carries the one for Provenance's production container (`apps/server/src/icloud-defaults.ts`), so a household configures nothing. `ECS_ICLOUD_API_TOKEN` replaces it, and `off` removes the feature. Because any page can present a public token to Apple's sign-in, the protection for a person's data is that sign-in and Apple naming the app on it, not the token.
- A **web auth token** for the person, handed back by Apple after sign-in. Apple replaces it on every call, and it lasts 30 minutes, or two weeks if the person asks to stay signed in.

### The sign-in token

- Apple's sign-in window hands the token to the window that opened it with a message. The Settings page checks the message came from an Apple address, posts the token to this server in a request body, and keeps no copy. No token appears in an address on this server, and the flow works at whatever address the household uses.
- The server holds the token **in memory only**. It is never written to the catalog, a file, a log or an audit row, and no endpoint returns it. Restarting the server means signing in again.
- Apple's service accepts both tokens only as query parameters of the request to Apple. That is Apple's protocol; the addresses are built in one module and are never logged or included in an error.
- Calls to Apple are made one at a time, because each answer invalidates the token used to ask. A call is never cut short for the same reason; stopping an import takes effect between calls.
- The Settings page accepts the token only from the sign-in window it opened, and only from an Apple address.

The server makes the calls itself. No Apple script is loaded into the web interface, which keeps the page's content policy as it is. A save file is downloaded only from an `https` address under Apple's own domains, without following redirects.

## Matching a save to a game

A save's `gameID` is looked for, in order, in: the MD5 of an uploaded game, the MD5 of a game file among an uploaded game's files, and the MD5 recorded for a scanned game file. A scanned file that has no game entry yet gets one, the same way it does when someone first saves from the web player. A scanned file whose MD5 has not been worked out yet cannot be found; the preview says how many saves found no game.

## Where the work lives

- `apps/server/src/cloudkit.ts`: the reader. No write call, and the network call is passed in, so it is tested against a stand-in for Apple's service. It runs in the server process: it is first-party code that talks to one fixed service, not an operator-installed module, and the sign-in it holds must not leave that process.
- `apps/server/src/icloud.ts`: owner-only endpoints under `/api/v1/icloud` (status, start, finish, disconnect, preview, import, cancel). The import runs in the background and reports progress through the status endpoint. It does not use the library job table, whose rows are keyed by scanned file.
- Migration 28: one row per imported record (container, record name, change tag, the file it became, device, date), and the MD5 indexes matching needs.
- `apps/web`: the Settings entry.

## One place for every app

All three apps are entitled to `iCloud.org.provenance-emu.provenance`. A zone there that every app writes to, say `Household`, would give:

- **One sign-in for the server.** One API token and one Apple sign-in reads every app's saves, instead of a token and a sign-in per container.
- **Changes instead of queries.** A custom zone can be read by change token, so a check transfers only what is new and needs no index.
- **The same person everywhere.** A small `Profile` record (display name, chosen picture) and a `Device` record per device (a name a person recognises, in place of a vendor identifier) that each app reads and writes.
- **The server's address.** A `Server` record holding where this household's server answers, so a newly installed app finds it without typing.

The record layout belongs in this repository beside the HTTP contract, and writing it belongs in each app's repository. The reader here takes a list of places to look (container, zone, record type, field names), so the shared zone, iFly's zone and iCube's zone are each one more entry.

## Order

1. Done: reader, preview, import of Provenance save states, tests against a stand-in.
2. **Live check** with a real API token and sign-in. Started 2026-11-26; blocked at sign-in, see "Live check".
3. Save-state screenshots, then battery saves through `ROM` records.
4. iFly and iCube, or the shared zone if the apps move to it.
5. Checking for new saves on a schedule. This needs the sign-in kept between restarts and so a reviewed way to store it; it is also bounded by Apple's two weeks.

## Live check, 2026-11-26

Run with the built-in API token and a real Apple Account.

- Apple accepts the API token and serves its sign-in page, which names the app.
- After sign-in Apple sends the window to `https://cdn.apple-cloudkit.com/ck-auth/`. That page asks `setup.apple-cloudkit.com/setup/ws/1/oauth/validateToken` to confirm, then posts its whole answer to the opening window. The message therefore comes from `cdn.apple-cloudkit.com`, not from the sign-in address, and the token is the `ckSession` field. The first build expected an `apple.com` sender and a `ckWebAuthToken` field and would have ignored a success. Fixed.
- The page posts to any origin unless the token names an `https` origin, so a page on a home address can receive it.
- The page's outcomes: status 0 is success, 7 asks for the iCloud terms, 11 waits for keys, 12 shows "iCloud Data Web Access is Off". Anything else shows "Authentication Error" and posts `{ errorMessage: 'unknownError' }`.
- **The owner's account got status 13**, in two browsers. The only other report of status 13 ties it to Advanced Data Protection (brightdigit/MistKit issue 486). The owner's account has Advanced Data Protection on, which fits. Not checked against an account without it. If that holds, an account with Advanced Data Protection cannot be read through Apple's web service at all, and this design does not work for it.

### If the web service stays closed

Reading the private database with Apple's own framework on a Mac that is signed in to iCloud is not affected by Advanced Data Protection. That means a small signed helper with the container's entitlement on the computer that runs the server, handing records to the same import code. It was built on 2026-11-26 and read the owner's saves; see `2026-11-26-native-icloud-reader-design.md`. The apps syncing to this server directly remains the long-term answer.

## Unverified

- Whether status 13 is Advanced Data Protection, and whether an account without it completes sign-in.
- Where Apple returns the replacement token on later calls (this build reads `ckWebAuthToken` from the answer body).
- The host names save files are downloaded from, and how long a download address stays valid.
- Rate limits. The reader stops and reports when Apple asks it to wait.

## Not in this design

- Writing saves back to iCloud. The apps do that.
- Importing games or BIOS files from iCloud. The server has the originals, and BIOS files are restricted content.
