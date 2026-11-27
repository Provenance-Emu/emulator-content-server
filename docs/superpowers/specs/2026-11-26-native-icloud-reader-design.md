# Reading iCloud saves on the Mac itself

Status: design only, nothing built. The first experiment passed on 2026-11-26; see "What was tried". Date: 2026-11-26. Follows `2026-11-22-cloudkit-save-import-design.md`, sections "Live check" and "If the web service stays closed".

Statements about Apple's behaviour in this document come from Apple's documentation as remembered and from this repository's own signing scripts, except where "What was tried" says otherwise. Each untested one that the design depends on is listed under "Try on real hardware first" or "Open questions".

## What was tried, 2026-11-26

A throwaway probe (about 50 lines of Swift in an app-shaped bundle, kept outside the repository) was run on the owner's laptop, logged in, from a terminal.

- Signed with the Developer ID Application certificate already in the keychain, hardened runtime, the five entitlements listed under "Signing, profile and entitlement", and a **Developer ID profile that already existed on the laptop**: "Mac Catalyst Team Direct Provisioning Profile: org.provenance-emu.provenance.lite". The probe borrowed that bundle identifier for the test. Nothing was changed in the developer portal. Not notarized, not nested in another app.
- `accountStatus`: available.
- A match-everything query for `SaveState` in the private database, default zone: **258 records in 2 pages, 1.3 seconds**. Every record had a change tag. Declared size of all save files: about 1.24 GB.
- One record fetched with `fileData`: the asset arrived as a readable file (13,678 bytes) in 0.8 seconds.
- The change tag is a short alphanumeric string (8 characters), the same shape the web service uses. Not yet compared value for value.
- The probe ran to the end without waiting on anything; whether macOS showed a notice on screen was not observed.
- The existing profile was created 2024-08-14 and expires 2042-08-10, and provisions all devices. So a Developer ID profile lasts 18 years and is not tied to one Mac.

What this settles: a Developer ID program that is not the app that wrote the records can read them with the framework, on a Mac logged in to iCloud, with the query the design plans to use. What it does not settle: that this laptop's Apple Account is the one with Advanced Data Protection that was refused on the web (the owner should confirm it is the same account), the launchd shapes, nesting inside the desktop app, and notarization.

### Mac Studio standalone probe, 2026-11-27

The owner extracted a separate Swift probe signed with Developer ID using the reader’s App ID and embedded provisioning profile. In Terminal on the Studio, `codesign --verify --strict --verbose=2` reported that the bundle was valid on disk and satisfied its designated requirement.

The initial launch through `open` produced no captured probe output. The owner then invoked `"$probe_app/Contents/MacOS/icloud-reader" 2>&1` directly from Terminal in the Studio’s desktop login session:

```text
accountStatus=available
SaveState count=258
asset bytes=13678
exit status: 0
```

The Developer ID–signed probe completed a read-only CloudKit operation from the Studio’s logged-in session. It queried all 258 matching `SaveState` records in the production private database’s default zone, fetched one `fileData` asset, and measured its local file at 13,678 bytes. This passes the standalone Studio experiment with the reader’s own App ID and profile. The output does not independently identify the Apple Account or report its Advanced Data Protection setting. The owner’s later transcript showed the same three values in the log captured by `open`.

### Mac Studio launchd probe, 2026-11-27

An SSH inspection found the probe’s LaunchAgent in the owner’s `gui/<uid>` domain. `launchctl print` reported one run, exit code 0, and the stdout log path. That log recorded `accountStatus=available`, 258 production private `SaveState` records, and one 13,678-byte asset. This confirms that a LaunchAgent in the Studio’s GUI login session can read the production container using the signed probe.

The supplied transcript shows `Permission denied` during signature verification of the copy under `/Library/Application Support`. The SSH inspection found neither the probe’s system LaunchDaemon registration nor its plist, and no daemon output was available. The daemon’s iCloud access remains unverified both while a GUI session exists and before GUI login. The permission failure supplies no CloudKit result.

A follow-up SSH inspection found that the system copy’s embedded provisioning profile was owned by `root:wheel` with mode `0600`. The owner changed it to `0644`, verified the signature under the daemon’s configured user, and loaded the job in the system domain. The log recorded `jmattiello` as the console owner at probe start. The probe threw `CKErrorDomain` code 6 (`serviceUnavailable`) at `accountStatus()` and exited 5. This attempt reached CloudKit from the daemon while the owner was logged in. It produced no account status, query result, or asset. The error does not establish whether the daemon lacked an iCloud session or encountered another service failure.

The pre-login case still needs a boot run. The test job records the console owner at probe start alongside the CloudKit result.

## As built so far, 2026-11-26

Built and tested, not committed: the contract, the server side, the helper, starting it from the desktop app, the signing step, and the Settings screen. Not done: the helper's own App ID and Developer ID profile (made in the developer portal by the account holder; steps in `docs/operations/nightly-builds.md`), and a run of the real desktop app with the helper nested in it.

- **Contract:** `icloudReaderAttach`, `icloudReaderWork`, `icloudReaderAccount`, `icloudReaderListing`, `icloudReaderListingFailed`, `icloudReaderSave`, `icloudReaderSaveFailed`; `reader` on `icloudStatus`; optional `source` on preview and import and in their answers. All additive.
- **Server:** `apps/server/src/icloud-reader.ts` holds the ticket and what the reader has been asked for, in memory. `icloud.ts` feeds the existing preview and import from either source. One branch in the request hook in `app.ts` lets the reader routes check their own ticket; it admits the caller as nobody.
- **Helper:** `apps/icloud-reader`, a Swift package. `ICloudReaderCore` is the loop and the HTTP link, tested without iCloud; the executable adds the CloudKit reads. A test fails if a call that changes iCloud appears in its sources.
- **Desktop app:** `apps/tray/src-tauri/src/icloud_reader.rs`. A background loop in the native side, macOS only, with no command exposed to JavaScript: it verifies the managed local server and reads the key as local owner sign-in does, attaches, and runs the helper with the ticket on its standard input. A helper that cannot start is tried again after ten minutes, not in a loop. A build without the helper does nothing. The status window has no iCloud line yet.
- **Signing:** `scripts/embed-icloud-reader.sh`, called by `scripts/sign-nightly-macos.sh` when a profile is supplied. It checks the profile is for the helper's App ID and includes the container before building. Tried on a scratch bundle with the borrowed profile: the nested helper was signed and launched.
- **Settings screen:** when the Mac's reader can read, the screen skips the Apple sign-in and goes straight to **Look for saves**; otherwise it says what the Mac needs and still offers the sign-in.
- **Reviewed once** (`ecs-reviewer`): no high-severity finding. Fixed from it: an upload now stops when its request ends for any reason, arriving bytes count as a sign of life, an oversized upload answers 413, a record listed twice is taken once, a listing cannot hold a request open for ever.

Differences from the design below, decided while building:

- The server asks for **one save at a time**, and names each request with its own random identifier (`requestId`) instead of the record name. An upload for an identifier the server is not waiting on is refused.
- The helper **stays running** while the desktop app does, since "ready" has to mean a look would work now. It ends when its standard input closes or its ticket ends.
- The helper keeps asking for work **while a download is under way**; asking is the heartbeat.
- The change tag the server records is the one from the listing. A record that changes between listing and download is brought in again next time as a second copy.
- The reader routes exist only where iCloud saves are configured at all (`ECS_ICLOUD_API_TOKEN=off` removes them too). Decoupling the Mac route from the web token is small and not done.

### Live check through the real endpoints

A throwaway server in a scratch folder, the helper signed as in "What was tried" (borrowed Provenance Lite profile), real iCloud, on the owner's laptop:

- Attach with the local key, helper started with the ticket on standard input: `reader.state` went to `ready`.
- Preview by the Mac route: 258 saves, 71 games, about 1.24 GB, in about one second.
- Three of those games were given entries on the throwaway server (by MD5). Import: **84 of 84 saves copied in 31 seconds**, none failed. A second import copied nothing.
- **Unexplained:** on the first run of the same check, 19 saves were copied and 65 were reported unreadable by the helper, twice in a row; twenty minutes later all 84 read. The helper did not log reasons then. It does now, and it reads again after a pause when iCloud says it is busy or the network drops. Failed saves are tried again on the next import, so nothing is lost, but the cause is not known.

### Under the helper's own identity

The owner registered App ID `org.provenance.contentserver.icloud-reader` in the developer portal, gave it the iCloud capability and the team's containers, and made a Developer ID profile for it ("ECS iCloud Reader Direct", valid to 2044). `scripts/embed-icloud-reader.sh` accepted the profile, built and signed the nested helper, and the same live check passed: 258 saves listed, 84 of 84 copied, none failed, a second import copied nothing.

- **A new App ID is refused at first.** For about six minutes after it was created, every read failed with CloudKit error 10, "Invalid bundle ID for container", although the portal and the profile were already right. It then worked with no change. The helper reports this as `notAllowed`, and the server says it is a fault in the build, not in the account.
- The two App Store Connect API key files on the laptop were rejected by Apple, so the App ID could not be made by Xcode from the command line. The portal by hand took a few minutes.
- Still not done: a run of the real desktop app with the helper nested in it, and the launchd cases.

### On the Mac Studio

Checked over SSH after a restart with the owner logged in.

- The nightly's desktop app carries the helper, and the helper launches there, so the nightly's certificate matches the profile.
- The server is the **boot service**, running as the owner, started with `--host 0.0.0.0`. The desktop app runs in the owner's login session. This is the arrangement the design assumed: the server never needs an iCloud session of its own.
- **The desktop app never attached.** It verifies the local server before reading the key, and that check refused any server listening beyond loopback. Fixed with a loopback listener the server holds itself; see `2026-11-20-local-owner-access-design.md`, "Servers on the home network". Not yet re-run on the Studio with that fix.

### Matching, found on the Mac Studio

The first real look on the Studio found 258 saves for 71 games and matched none. Two causes:

- Provenance's identifier for a game is not always the file's MD5. It skips a cartridge header (NES, SNES `.smc`, Atari 7800, Lynx), reorders an N64 image, and hashes a disc's data track.
- The games were not in a library folder there. Most of the owner's games are in iCloud Drive, which the folder chooser could not reach; it now lists those folders, and the files have to be downloaded to the Mac before the server will read them.

Added: the reader also sends what Provenance's `ROM` records say about each game that has a save (file name, system, size, title; never the file). When the MD5 finds nothing, the server looks for exactly one file in the libraries with that system, name and size. On the laptop, with the iCloud Drive games folder added to a throwaway server, 12 of the 71 games matched and 36 saves were ready; the rest are games whose files are not in that folder. Unmatched games are now listed by title.

Not done: computing Provenance's own MD5 for headered and disc formats on the server, which would match a renamed file too. Play counts, time played, last played and favourites are on the same `ROM` records and are not read yet.

## Apple's other libraries, and why they do not help here

Apple offers CloudKit JS for web pages and a server-to-server key for servers; open-source Swift packages (MistKit is one) wrap the same thing for server-side Swift.

- **CloudKit JS** is a client for the CloudKit web service. It signs a person in through the same Apple window and gets the same token this server's reader already asks for. The refusal (status 13) comes from Apple's token check for the account, before any library is involved, so CloudKit JS meets the same refusal. The earlier design chose not to load Apple's script into the interface; that choice is not what blocks this.
- **A server-to-server key** reaches the public database only. Saves are in each person's private database.
- **Server-side Swift packages** speak the same web service with the same two kinds of credential, so they inherit both limits.

The only route found that reads an Advanced Data Protection account's private data is the CloudKit framework on one of that person's trusted Apple devices, which is this design. One thing on the web side is still untried: Apple's "Access iCloud Data on the Web" switch for such accounts. See open question 12.

## The situation

The first real sign-in to Apple's CloudKit web service was refused with status 13. The owner's Apple Account has Advanced Data Protection on, and Apple does not let such an account's private app data be read through the web service. The web route in `apps/server/src/cloudkit.ts` cannot work for this owner, and no change on our side will fix it.

Apple's CloudKit framework on a Mac that is signed in to the same Apple Account is a trusted device and reads the same records. So the saves can be read by a small signed program on a Mac, and handed to the import the server already has.

## Decision in brief

1. **A separate Swift helper**, `iCloud Reader`, its own small app bundle nested inside the desktop app (`Emulation Server.app/Contents/Helpers/`). Source in a new package, `apps/icloud-reader`.
2. **The helper is a client of the server**, like the desktop app. The server never starts it, never runs its code and never opens a file it names. It reads iCloud and uploads to a handful of new owner-only endpoints.
3. **The desktop app starts it** when the server says the owner asked for a look or an import. The desktop app runs in the owner's login session, which is where an iCloud session exists.
4. **The server keeps every decision**: which game a save belongs to, whether it was brought in before, where it is filed, and that it never replaces a live save. That is the existing code in `icloud.ts`, fed from a second source.
5. **Windows and Linux servers get no local reader.** They can later be fed by a Mac elsewhere in the house running the desktop app (not in the first version).

## Where the helper lives

Three places were considered.

| Place | For | Against |
| --- | --- | --- |
| Inside the desktop app's own process (Rust, through Objective-C bindings) | No second program | The restricted iCloud entitlement would sit on the desktop app itself. If the provisioning profile is missing, wrong or expired, macOS refuses to launch the whole app, and that app is how the owner starts, stops and repairs the server. CloudKit from Rust is block-based Objective-C driven by hand. |
| A bare Swift command-line tool beside the server | Smallest | A restricted entitlement needs a provisioning profile, and macOS only finds a profile inside an app-shaped bundle. A bare executable carrying the entitlement is killed at launch. |
| **A nested helper app bundle in the desktop app (chosen)** | A bad profile breaks only iCloud reading. Swift calls CloudKit directly. Ships, updates and is notarized with the desktop app that already exists. | One more thing to sign; a new package. |

**Ownership.** New row in `AGENTS.md`: `apps/icloud-reader` owns "the macOS helper that reads Provenance's CloudKit container and uploads to the reader endpoints". It is a Swift package with one executable target and a bundle layout (Info.plist, entitlements file). It may depend on nothing in this repository except, optionally, `clients/swift` for the generated models. It is an API client: it may not open the catalog or the data folder. `scripts/check-boundaries.mjs` reads TypeScript imports and will not see it; the rule is kept by review.

`clients/swift` was not chosen as the home because that package is the app-neutral client that Provenance, iCube and iFly consume, and it declares Apple platforms generally. A macOS executable with an entitlement does not belong in a library those apps import.

`apps/tray` gains only: bundling the helper, one native command to start it, and the status line. The helper is built by `swift build` on macOS and copied into the bundle before signing. Linux and Windows desktop builds skip it.

## Signing, profile and entitlement

What the helper needs to open `iCloud.org.provenance-emu.provenance` outside the App Store:

- **An App ID** for the helper under team `S32Z3HMYVQ` (the test borrowed Provenance Lite's; the shipped helper gets its own so it is never mistaken for that app), for example `org.provenance.contentserver.icloud-reader`, with the iCloud capability (CloudKit) and that container assigned to it. The container belongs to the same team (Provenance's project uses the same team identifier as this repository's `desktop-update.requirement`), so no cross-team arrangement is needed. iFly and iCube are already entitled to the container the same way.
- **A Developer ID provisioning profile** for that App ID, embedded as `Contents/embedded.provisionprofile` in the helper bundle. This is a different kind of profile from the development and App Store ones; it is created in the developer portal by the account holder.
- **Entitlements**, signed into the helper only:
  - `com.apple.application-identifier` = `S32Z3HMYVQ.org.provenance.contentserver.icloud-reader`
  - `com.apple.developer.team-identifier` = `S32Z3HMYVQ`
  - `com.apple.developer.icloud-services` = `[CloudKit]`
  - `com.apple.developer.icloud-container-identifiers` = `[iCloud.org.provenance-emu.provenance]`
  - `com.apple.developer.icloud-container-environment` = `Production`
- **Production only.** A Developer ID build reaches the production environment, which is where the owner's saves are. The `.dev` container is out of reach and not needed.
- **Hardened runtime and notarization** as today. No sandbox is required for Developer ID. The helper is signed first (inside out), then the desktop app, then the image.

Changes to the pipeline:

- `scripts/sign-nightly-macos.sh` signs the app in one `codesign` call with no entitlements. It needs a first step that copies the profile into the helper and signs the helper with its entitlements file, before the outer signature. The final check should also confirm the helper's entitlements and that the profile is present.
- The profile becomes a sixth signing input (`ECS_MACOS_ICLOUD_PROFILE`, base64, in the `nightly-macos-signing` environment). It is not a secret in the way the certificate is, but it is tied to the certificate: rotating the Developer ID certificate (`scripts/rotate-macos-signing-secret.sh`) means regenerating the profile too. `docs/operations/nightly-builds.md` gains that step.
- A repository without the profile builds the desktop app without the helper, and the server reports that honestly (see "Honest status").
- Local unsigned builds have no working helper. Tests use a stand-in (see "Testing").

The entitlement grants read and write to the container. Read-only is a property of the helper's code, not of the entitlement: see "Rules".

## Can a launchd service hold an iCloud session?

The server on the Mac Studio runs under launchd in one of two shapes (`docs/operations/service.md`):

- **Login agent** (`~/Library/LaunchAgents`), in the owner's login session.
- **Boot daemon** (`/Library/LaunchDaemons/app.emulator-content-server.plist`), in the system domain, running as the installing user.

- **GUI LaunchAgent.** The signed probe read the production private database on the Studio and fetched an asset.
- **System LaunchDaemon under the owner's UID.** The logged-in Studio run returned `serviceUnavailable` at `accountStatus()`. That result leaves the daemon's account state unknown.
- **Before GUI login.** Both the daemon boot run and the separate SSH-session test are pending.

The design therefore does not depend on which shape the server has. The helper always runs in the owner's graphical login session, started by the desktop app, and the server only receives uploads. On a Mac Studio that restarts unattended and waits at the login window, the server comes back (boot daemon) but iCloud reading waits until the owner logs in; with automatic login it comes back on its own. The interface says which.

## How the helper hands saves to the server

### Why the helper calls the server and not the other way round

The server is the long-lived, network-facing process. Starting a helper would require trusting an executable path. Opening files supplied by the helper would require trusting paths chosen by another process. The desktop app starts the helper in the GUI session, where the signed probe has demonstrated CloudKit access, and sends asset bytes through the import API.

Instead the helper is one more HTTP client on loopback. The server's trust grows by exactly one thing: a new caller identity, "the reader on this Mac", which can do less than the owner can.

### Proving who the helper is

The desktop app already proves it is the same macOS user as the server with `local-owner.key` (`2026-11-20-local-owner-access-design.md`). The same proof is used, but it buys a narrower pass:

- `POST /api/v1/icloud/reader/attach` with `{ "key": "…" }`, loopback peer only, same checks and rate-limit bucket as `auth/local`. It answers with a **reader ticket**: 32 random bytes, held in server memory only, valid until the server restarts, the owner disconnects, or ten minutes pass without a call.
- The ticket is accepted on `/api/v1/icloud/reader/*` and nowhere else. It is not a catalog session, cannot list the library, and cannot reach any other route. Sent as `Authorization: Bearer`, never in an address.
- The desktop app's Rust side re-runs its managed-endpoint check, reads the key, performs the attach, and gives the ticket to the helper on its standard input. The key never reaches the helper; the ticket never reaches a webview, a log or an argument list.
- One reader at a time. A second attach replaces the first.

This needs the server to have local trust on (not `--public`), as the key does today. A `--public` server has no local reader in the first version.

### What the helper sends, and what the server does with it

The server drives; the helper answers. All under `/api/v1/icloud/reader`, ticket only:

| Call | Meaning |
| --- | --- |
| `GET work` (held open up to 30 s) | "Anything to do?" Answers `none`, `list`, `fetch` with up to 20 record names, or `stop`. Also the helper's heartbeat. |
| `PUT account` | The helper's view of iCloud: `available`, `signedOut`, `restricted`, `unknown`. No account name or identifier is sent. |
| `POST listing` | A page of save descriptions: record name, change tag, `gameID`, `filename`, `systemIdentifier`, `coreIdentifier`, size, `lastModifiedDevice`, modified date. No bytes. Final page marked. |
| `PUT saves/{recordName}` | The bytes of one save the server asked for in a `fetch`, as a streamed body with its length, plus the change tag it was read at. |
| `POST saves/{recordName}/failed` | The helper could not read that record; a short reason from a fixed list. |

On the server:

- A listing is validated like untrusted input (field lengths, the `MAX_SAVES` cap of 50,000, the 512 MiB per-save cap) and turned into the same `CloudSave` values the web reader produces, minus the download address. `summarize` builds the preview exactly as today.
- For an import, the server decides which records it wants (matched to a game, not already in the ledger) and asks for them in `fetch` batches. The helper cannot push a save the server did not ask for: an upload for a record name not currently requested is refused.
- An uploaded save goes through the existing `copy` path with the network download replaced by the request body: staged in the data folder by the server, counted, capped, then `store` files it beside what the game has. `catalog.recordSaveImport` records it under the same origin, `icloud:<container>`, so a save brought in by either route is never brought in twice (subject to open question 4).
- Progress is the existing `ImportProgress`. Stop takes effect between saves: the next `work` answers `stop`.

Nothing in this exchange lets the helper name a game, a library, a path or a display name. `savePath` and the conflict-copy rule stay on the server.

### Inside the helper

- `CKContainer(identifier:)`, private database, default zone. Listing is a `CKQueryOperation` for `SaveState` with `desiredKeys` that leave out `fileData` and `imageAsset`, paged by cursor. This is the same match-everything query the app runs in production, so its index exists.
- A requested save is a `CKFetchRecordsOperation` for that record with `fileData`. CloudKit downloads the asset to a file in the helper's own cache; the helper streams it to the server and deletes it. One save on disk at a time.
- It checks `accountStatus` first and listens for account changes; a signed-out or changed account is reported and work stops.
- It exits when the server answers `none` for two minutes, or when its standard input closes (the desktop app quit). No window, no Dock icon, no menu.
- It holds no state between runs. The ledger of what was imported is the server's.

## Rules, and how each is kept

- **Owner only.** Starting a look or an import is the existing owner-only endpoints. The reader endpoints take only a ticket that only the same macOS user can obtain, on loopback. A member, a trusted-network device and a guest link can reach neither. The ticket cannot act as the owner elsewhere.
- **Nothing written to iCloud.** The helper links CloudKit but its source contains no modify operation, no `save`, no `delete`, no zone or subscription creation. A check in the package's tests fails the build if `CKModify`, `.save(`, `.delete`, `CKSubscription` or `CKRecordZone(` appear in `apps/icloud-reader/Sources`. Reading with a query does not create a zone or change a record. This is weaker than the web reader's "no write call exists in the protocol we speak", and it is said plainly in the file's header.
- **No save ever replaces a live one.** Unchanged: the server files an imported save beside what is there, as a conflict copy when the path is taken. The helper has no say.
- **Same save, once.** Unchanged: record name and change tag in the migration 28 ledger.
- **Secrets.** The key stays in the desktop app's native side. The ticket is in memory in three processes and nowhere else. The helper logs record counts and failure reasons, never record names with contents, never the ticket.
- **The owner's files.** The helper is given no path into the library and never reads the data folder.

## Honest status

Additive contract changes (`contract-change` skill):

- `capabilities.features.icloudSaves` stays as it is: the web route is configured.
- `icloudStatus` gains `reader`:
  - `offered`: this server can accept a reader (macOS or any platform with local trust on; see below).
  - `state`: `absent` (no desktop app has attached), `ready`, `signedOut`, `restricted`, `working`.
  - `lastSeenAt`.
- `icloudStatus` gains `source`: `web` or `mac`, for the current preview and import.
- `POST /api/v1/icloud/preview` and `/import` take an optional `source`. Without it the server uses `mac` when a reader is `ready`, otherwise `web`.

`reader.state` is `ready` only while a helper has called `work` in the last minute and reported an available account. A green state always means a look would work right now.

## What the owner sees

Settings, **iCloud saves**, same screen as today (`apps/web/src/IcloudSaves.svelte`). The reader is offered first when it is there, because it needs no sign-in:

- Reader ready: **"This Mac is signed in to iCloud."** with **Look for saves**. No Connect step. Preview, **Bring them in**, progress and **Stop** are the existing controls.
- Reader absent on a Mac server: **"Open Emulation Server on the Mac that runs this server to read iCloud from there."** The web sign-in stays available below it for accounts it works with.
- Mac not signed in to iCloud: says so, and that the account must be the one the devices use.
- Server up, nobody logged in at the Mac: **"Log in at the Mac to read iCloud."**
- After the web sign-in fails with the Advanced Data Protection refusal, the message points at the Mac route instead of at a setting the owner cannot use.

The owner can press these from any device they are signed in to as owner; the work happens on the Mac. "Works without being configured": the desktop app, when it has verified it manages the local server and the server reports `reader.offered`, attaches and starts the helper by itself and keeps it available while a look or import is pending or recent. The owner is not asked to start anything beyond having the desktop app open. Whether the desktop app should open at login is open question 6.

The desktop app's status window gets one line under the server status, for example "iCloud: ready" or "iCloud: not signed in on this Mac", and nothing else.

macOS may list the helper under the Apple Account's iCloud settings as an app using iCloud, where the owner can switch it off. That reads back as `restricted` and the screen says where to turn it on.

## Windows and Linux

CloudKit does not exist there, and neither does the helper. The framework is closed and ships only with Apple's systems; there is no Linux or POSIX build, and iCloud for Windows does not give other programs a CloudKit interface. So the feature is best effort, and the screen offers the best route the household has, in this order:

1. **The server is on a Mac that is logged in to iCloud.** The helper, with nothing to set up. First version.
2. **The server is elsewhere and there is a Mac in the house.** The desktop app on that Mac reads iCloud and sends the saves to the server. Second version; see "Later" below.
3. **No Mac.** The web sign-in, which works unless Apple refuses the account (Advanced Data Protection).
4. **None of these.** The screen says so plainly and points at the apps syncing to the server directly, which needs no iCloud at all.

- A server on Windows or Linux never has a local reader. `reader.state` is `absent`, and the screen does not mention "this Mac".
- The web sign-in remains the only route on those servers, and it stays closed to accounts with Advanced Data Protection. The screen says that plainly instead of failing at sign-in for no stated reason.
- **Later, not in the first version:** because the helper is only an HTTP client, a Mac elsewhere in the house running the desktop app could feed a server on a NAS. That needs a different proof than the key file (the owner signed in to that desktop app with their password, and an owner-approved pairing for the reader ticket) and its own review. The endpoint shapes above are chosen so this is an added way to get a ticket, not a redesign.
- Windows servers do not write `local-owner.key` today, so even a Mac-style local flow has nothing to stand on there.

## Testing

- Server: the reader endpoints against a stand-in helper in `node:test`: ticket required, ticket useless elsewhere, loopback only, unrequested upload refused, oversize refused, conflict copy kept, ledger shared with the web origin, stop between saves, reader going silent mid-import ends the run as failed with a plain message.
- Helper: the CloudKit calls sit behind one protocol so the upload loop is tested with generated bytes and no iCloud. The forbidden-symbol check above. No real save is a fixture.
- Real iCloud is acceptance on the owner's Mac only, recorded as evidence under `docs/operations/`.
- One `ecs-reviewer` pass: this adds an authentication path.

## Try on real hardware first

Experiment 1 passed on the owner’s laptop and in the Mac Studio’s desktop login session. Experiment 2(a) passed on the Studio. Experiment 2(b) reached CloudKit and returned `serviceUnavailable`. The pre-login cases still need results.

1. **Done. Smallest first experiment: can a Developer ID helper read the container at all?** As first written: in a scratch folder outside this repository: register the App ID, assign the container, create the Developer ID profile, and build a 40-line Swift app bundle that prints `accountStatus` and the count of `SaveState` records in the private database, plus the size of one `fileData` asset after fetching it. Sign with the existing Developer ID certificate and the entitlements above, notarize, and run it from Terminal on the Mac Studio while logged in, with Advanced Data Protection on. Pass: a non-zero count and a readable asset. This single run answers the profile question, the Advanced Data Protection question, the index question and whether macOS shows any prompt.
2. **Which launchd shapes have an iCloud session.** Run the same binary (a) from a LaunchAgent in the login session, (b) from a LaunchDaemon with `UserName` set to the owner, (c) as (b) after a restart with nobody logged in, (d) over SSH with nobody logged in at the screen. Record `accountStatus` and the first error for each.
3. **Nested and started by the desktop app.** Put the bundle in `Emulation Server.app/Contents/Helpers/`, sign inside out with the real script, notarize, and start it from the desktop app's process. Confirms a nested helper finds its own profile, that Gatekeeper and the updater's requirement check (`desktop-update.requirement`) still pass, and that a child of the desktop app inherits a working session.
4. **Change tags.** For three records, compare `recordChangeTag` from the framework with the web service's value for the same records on an account the web service accepts (not the owner's). Decides whether one ledger serves both routes.
5. **Volume and limits.** Time a full listing and 50 asset fetches; note any rate limiting and how much disk the asset cache uses.

## Risks

- **Experiment 1 fails.** Then no route on this server reads this owner's iCloud, and the answer is the apps syncing here directly, already the long-term plan. Cost so far: an afternoon.
- **The profile is a new single point of failure for the helper.** A profile that is missing, mismatched or expired stops the helper launching. It is isolated from the desktop app on purpose; the status line must say "iCloud reading is not available in this build" and not look like a sign-in problem.
- **Needs a logged-in owner.** A headless Mac that nobody logs in to cannot read iCloud. Acceptable for a one-off backfill; it limits "checking on a schedule" (step 5 of the earlier design) to Macs with a login session.
- **Read-only by discipline.** The entitlement allows writes. A future edit could add one. The forbidden-symbol check and the package's ownership rule are the guard; they are a convention, not a wall.
- **A second local program holding a pass to the server.** Bounded by the ticket's scope, loopback, memory-only life and the server asking for each record by name. The worst a misbehaving helper can do is supply wrong bytes for a save the server asked for; that save lands beside the live one and can be deleted.
- **Wrong account.** The Mac may be signed in to a different Apple Account than the devices. The preview would show zero or someone else's saves in a shared household. The preview-before-import step is the guard; no account identifier is shown or sent.
- **Shared ledger mismatch** if change tags differ between routes: a save could be imported twice as a conflict copy. Harmless but untidy; settled by experiment 4.
- **Pipeline weight.** One more signing step and input on the nightly, and Swift in the desktop build on macOS. A failure there must not block publishing the server archives.

## Open questions

1. Two Apple Accounts are involved and only one matters for reading. The developer account signs the helper and owns the profile; it holds no saves. The account signed in to iCloud in System Settings on the Mac is the one whose private database is read. The probe found 258 saves, so the laptop is on the personal account that the devices use. Still to confirm by looking at System Settings: that this is the account the web sign-in refused, and that Advanced Data Protection is on for it.
2. Answered: a Developer ID profile lasts 18 years. What happens to an installed helper when the certificate inside the profile is rotated is still unknown.
3. Can the signed probe reach the production private database from the boot daemon before GUI login? Experiment 2(c) will record the console owner and probe output. If the first attempt returns `serviceUnavailable`, repeat before GUI login once the network is up to distinguish a startup timing issue from a persistent failure in that context.
4. Is the framework's `recordChangeTag` the same string the web service returns? Experiment 4.
5. Which shape is the Mac Studio's server installed in today, login agent or boot daemon, and does that Mac log in automatically? Decides what the owner sees after a restart. Ask the owner.
6. Should the desktop app start at login so the reader is there without the owner opening anything? It does not appear to today. A product decision.
7. Is the Mac Studio signed in to the same Apple Account as the phones, tablets and TVs? Ask the owner.
8. Does macOS list the helper in iCloud settings? It did not block the probe; nobody looked at the screen or at settings.
9. Should the ticket be a memory-only value as proposed, or a new token kind in the catalog (`tokenKind` is `session` or `device` today)? Memory-only is proposed because it needs no migration and dies with the process; the reviewer should confirm.
10. Decided 2026-11-26 by the owner: the web route stays, as the route most households are expected to use, and the Mac helper is built for accounts it refuses. The web route cannot be tested end to end on the owner's account; someone with an account Apple accepts tests it later. Until then it is shipped unproven past sign-in, and the screen must fail plainly when it does not work.
11. Battery saves (`File` records matched through `ROM`), screenshots, iFly and iCube: the helper's query would take a list of places to look, as the earlier design says. iFly's and iCube's containers would each need to be assigned to the helper's App ID. Out of the first version.

12. Does switching on "Access iCloud Data on the Web" for the Apple Account let the existing web sign-in through? If it does, Windows and Linux servers have a route for such accounts, at the cost of the owner loosening an account setting. Cheap to try; the owner's call.

## Not in this design

- Writing anything to iCloud.
- A reader on a Mac other than the one running the server (sketched above, not designed).
- Keeping an iCloud session inside the server process.
- Replacing the web route.
- Changes to Provenance, iCube or iFly.

## Order of work

1. Experiments 2 to 4; update this document with what was found.
2. Contract: reader endpoints, `reader` and `source` on status. `pnpm generate`, `pnpm update-surface`. Additive.
3. Server: ticket, reader endpoints, the second source into the existing preview and import. Tests against a stand-in. Reviewer pass.
4. `apps/icloud-reader`: the helper and its tests.
5. Desktop app: bundle, attach, start, status line. Signing script and nightly input.
6. Web: the Settings screen states above.
7. Acceptance on the Mac Studio with the owner's account; evidence under `docs/operations/`.
