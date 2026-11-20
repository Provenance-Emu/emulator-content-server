# Connect an emulator to Emulation Server

Browse the [public Swagger reference](https://provenance-emu.com/emulator-content-server/) for current examples. To make requests, open `/docs/` on the server, for example [the local API reference](http://127.0.0.1:8473/docs/). Swagger UI reads `/openapi.yaml` from that same server, so the reference tracks the installed build. The [contract on main](https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/main/packages/protocol/openapi/openapi.yaml) tracks development. Pin a commit or use the installed server's contract when generating a client for a specific build.

The contract uses OpenAPI 3.1.2. OpenAPI 3.2.1 is the newer specification, but the pinned generator cannot validate this contract as 3.2.1. The wire API is still `/api/v1`. See the [OpenAPI specification versions](https://spec.openapis.org/oas/) and [protocol versioning](versioning.md).

## Discover a server on the LAN

When the server runs with `--advertise`, browse `_pvcontent._tcp` and resolve the Bonjour service's host and port. TXT provides the server UUID (`id`), protocol major (`v=1`), display name (`name`), operator-declared TLS termination (`tls=0|1`), and bootstrap state at startup (`pair=0|1`). Use normal certificate validation for HTTPS and allow a manual origin when the proxy listens at a different address. Device PIN pairing is available after bootstrap on servers with the web UI. Use the HTTP response to determine whether pairing is needed or available.

## Browse and download a game

1. An operator sets up the server and adds games by scanning a folder into a library or uploading them. The client can call `GET /api/v1/capabilities` before signing in and check `protocol.major` and feature flags.
2. Use an authorized read-scoped device token or sign in with `POST /api/v1/auth/login`, sending JSON with `username` and `password`. Send the returned `token` as `Authorization: Bearer <token>` on subsequent requests. Store it in the platform credential store and use HTTPS for remote connections. In Swagger UI, enter the token in **Authorize**. The page keeps it in memory for that session.
3. Call `GET /api/v1/browse-libraries`. Use an ID from `items` to call `GET /api/v1/browse` with `libraryId` and `category=games`. Add `systemId` to narrow the list. Send `nextCursor` verbatim with the same filters until it is `null`.
4. For an `entityType` of `item`, call `GET /api/v1/items/{itemId}/manifest` and download the required files from their `contentPath` values. Keep the manifest's relative layout in a contained local staging directory and verify each file's SHA-256 before launching. For `source`, use `source.contentPath` for the original file. For an `asset`, use `/api/v1/files/{assetId}/content`. Resolve every content path against the configured server origin before attaching the token.

For example, with `ECS_TOKEN` already set, use `curl` to list libraries and find Atari Jaguar cartridges. Replace `LIBRARY_ID` and `SOURCE_ID` with values from the responses.

```sh
base=http://127.0.0.1:8473
printf 'Authorization: Bearer %s\n' "$ECS_TOKEN" |
  curl --fail --silent --show-error --header @- "$base/api/v1/browse-libraries"

printf 'Authorization: Bearer %s\n' "$ECS_TOKEN" |
  curl --fail --silent --show-error --header @- --get "$base/api/v1/browse" \
    --data-urlencode 'libraryId=LIBRARY_ID' --data-urlencode 'category=games' \
    --data-urlencode 'systemId=com.provenance.jaguar'

printf 'Authorization: Bearer %s\n' "$ECS_TOKEN" |
  curl --fail --silent --show-error --header @- --output cartridge.part \
    "$base/api/v1/sources/SOURCE_ID/content"
```

Stream large downloads to disk. To resume, send `Range: bytes=<local size>-` and `If-Range` with the saved ETag. Append only on `206` with a matching `Content-Range` start. On `200`, replace the partial file. On `416`, inspect `Content-Range` or request `HEAD` before deciding whether to restart. HTTP problems use `application/problem+json`. Report the request ID when available and keep credentials out of logs.

For NAOMI and NAOMI 2 GD-ROM games, browse `com.provenance.naomi` or `com.provenance.naomi2`, then read `/api/v1/sources/{sourceId}/group`. A scanned `cart.zip` with a `cart/gdrom.chd` companion returns both files in that layout, with the ZIP first. Check `error`, require local availability for every member, and stage both downloads before registering the ZIP. Each member downloads through `/api/v1/sources/{id}/content`. Flycast clients should validate the expected GD-ROM name against their game metadata. Uploaded items use the existing v1 manifest with two required ROM assets, whose `relativePath` values are `cart.zip` and `cart/gdrom.chd`. The server preserves paths supplied on upload and does not infer a missing asset in a newly created item.

## Find a BIOS file

A player that needs a BIOS it does not have asks the file list for it by name: `GET /api/v1/sources?kind=bios&name=naomi.zip`. `name` is the exact file name, compared without case. `kind` takes any asset kind. Both filters apply before a file is checked on disk, so the request does not stat the whole collection the way an unfiltered list does. Download the match through its `contentPath`, with the same Range rules as a game.

The scanner files a BIOS as `bios` when its name starts with `[BIOS]`, when it sits under a `bios`, `bioses` or `firmware` folder, or when it is one of the names in `firmwareNames` (`packages/storage/src/scan.ts`). That list includes the arcade sets Flycast loads by name (`naomi.zip`, `naomi2.zip`, `awbios.zip`, `segasp.zip`, `hod2bios.zip`, `f355bios.zip`, `f355dlx.zip`, `airlbios.zip`) and `dc_flash.bin`, so they are firmware wherever they sit and no longer appear among the games. A file indexed before a name was added keeps its old kind until the folder is scanned again. `bios` is a restricted kind: a guest sees it only with `share_restricted`.

## Show a library with covers

A game grid needs one request per page and no ROM downloads. Each `source` row in a `GET /api/v1/browse` page carries what a card shows:

- `title`: the matched game name. Fall back to `name`, the file name.
- `systemId`, `size`, `availability`: for the subtitle and for greying out a game whose drive is offline.
- `artworkPath`: present when a front cover is saved (`artworkAvailable` is also `true`). It is a server-relative path; `GET` it with the same Authorization header. The response has an `ETag` and `Cache-Control: private, no-cache`, so keep the image on disk and send `If-None-Match` next time; an unchanged cover answers `304` with no body.
- `details`: optional `publisher`, `developer`, `year`, `genre`, `region`, `language`, `description`. Fields are absent until a match is saved, so lay the card out without them.

`systemCounts` on the page gives the per-system totals for a sidebar. Poll `GET /api/v1/changes` to learn that the library changed instead of re-reading every page.

Covers are returned at their stored size (up to 8 MB, usually far smaller). Downscale on the device and cache the result. The Authorization header is required, so configure the image loader with a request modifier; a bare URL loader such as `AsyncImage` cannot fetch a cover.

## Edit a game's details from a device

An app that lets the user rename a game or change its cover can save the change back with two routes. Check `features.sourceDetailsWrite` in `GET /api/v1/capabilities` first; an older server does not have them.

1. Read the revision: `GET /api/v1/sources/{sourceId}/matches/selections` returns `revision`.
2. Send it back as `If-Match: "rev-N"` on every write. A missing header is `428`. A stale revision is `409` and nothing changes: reload the selections, show the user the current values and retry.
3. `PUT /api/v1/sources/{sourceId}/details` with a JSON body `{"title": "...", "details": {...}}` (`operationId` `saveSourceDetails`). `title` is required, 1 to 200 characters after trimming, and always replaces the saved title. `details` is optional and takes `publisher`, `developer`, `year`, `genre`, `region`, `language` and `description` (up to 2000 characters). Partial edits keep data: when `details` is omitted, the details already saved for the game are kept, whichever provider wrote them. When it is present, each key that is present replaces that field, an empty string clears it, and keys that are absent keep their current value. A client that only edits the title sends just `{"title": "..."}`.
4. `PUT /api/v1/sources/{sourceId}/details/cover` with the raw image as the body (`operationId` `saveSourceCover`). `Content-Type` must be `image/png`, `image/jpeg` or `image/webp` and the bytes must really be that format, otherwise `415`. The limit is 2 MiB; a larger image is `413`. The new cover is served from the `artworkPath` the browse row already carries. Add `?artworkRole=back|disc|manual|title|screenshot|banner|other` to save one of the game's other pictures the same way (the default is `front`); each kind is replaced on its own, `manual` may be up to 8 MiB, and an unknown kind is `400`. Read one back from the selected-content route with the same `artworkRole`.
5. Both answer `200` with the same body as the selections route, including the new `revision`. Use it for the next write. The game's change-feed event fires, so other devices refresh.

Who may write: a user session or device token with the `write` scope, for a user who is an owner or editor of the game's library. A reader gets `403`. A game the caller cannot read is `404`. A game that is not in any library is owner-only. Pairing issues read-only tokens, so an app that edits needs a device token the owner created with the `write` scope. Hand-entered details are never replaced by automatic matching; the owner can still pick a lookup match or clear the selection.

```sh
base=http://127.0.0.1:8473
printf 'Authorization: Bearer %s\n' "$ECS_TOKEN" |
  curl --fail --silent --show-error --header @- "$base/api/v1/sources/SOURCE_ID/matches/selections"
# take "revision" from the reply, for example 3

printf 'Authorization: Bearer %s\n' "$ECS_TOKEN" |
  curl --fail --silent --show-error --header @- --request PUT \
    --header 'If-Match: "rev-3"' --header 'Content-Type: application/json' \
    --data '{"title":"My Game","details":{"year":"1991"}}' \
    "$base/api/v1/sources/SOURCE_ID/details"

printf 'Authorization: Bearer %s\n' "$ECS_TOKEN" |
  curl --fail --silent --show-error --header @- --request PUT \
    --header 'If-Match: "rev-4"' --header 'Content-Type: image/png' \
    --data-binary @cover.png "$base/api/v1/sources/SOURCE_ID/details/cover"
```

## Delete with an undo

`DELETE /api/v1/items/{itemId}` and `DELETE /api/v1/files/{assetId}` move an uploaded game or file to the trash. Nothing is removed from disk yet. `GET /api/v1/capabilities` reports `trash.retentionDays`; when the field is absent the server keeps no trash and a delete cannot be undone.

- Offer an undo right after a delete: `POST /api/v1/items/{itemId}/restore` or `POST /api/v1/files/{assetId}/restore`. Both need a signed-in account with write access to the game; a guest grant cannot restore. Restoring something that is already live returns it unchanged, so a retry is safe.
- `GET /api/v1/trash` pages through what the account may restore, newest first, with `purgeAfter` on each entry. A game deleted with its files is one entry. A file entry with `itemDeleted: true` answers `409` until its game is restored.
- A restored file whose path was taken by a newer upload comes back as a conflict copy (`conflictOf` set), the same shape as a save conflict.
- A restore appears in `GET /api/v1/changes` as ordinary `upsert` entries for the game and each file. After `purgeAfter` the row is gone and restore answers `404`.

Games in a watched server folder are not deleted through the API and never appear in the trash.

## Pair a device with a TV interface

Try the catalog without an Authorization header first if the user has not supplied a token. The server's network policy determines whether that request can browse. Existing bearer tokens still work.

Start with `POST /api/v1/device-pairing/requests` and the device name. Keep the returned challenge secret on the requesting device. Poll `/api/v1/device-pairing/requests/status` with the request ID and secret every three seconds. Under **Settings → Devices**, the owner can approve the request and display its six-digit PIN and QR code. The device validates that a scanned `ecs-pair:<id>:<pin>` payload matches its active request before using the PIN. Submit the ID, secret and PIN to `POST /api/v1/device-pairing/requests/complete`.

A successful completion returns a revocable read-only device token once, valid for 90 days. Save it using the same credential store as a manually supplied token. Requests expire after five minutes and are cleared on server restart. Cancel a request with `POST /api/v1/device-pairing/requests/cancel` and the request ID and secret.

On servers that return `404` when starting a request, use the original `POST /api/v1/device-pairing` flow. Show the device PIN and link to `/ui/?settings=devices#pair=<PIN>` for owner approval, then poll `/api/v1/device-pairing/redeem` with the ID and secret. Existing apps can keep using those endpoints.

An owner can start pairing from **Pair a device** on the library home page. The owner creates a five-minute invitation with `POST /api/v1/device-pairing/invitations`. The QR uses `ecs-pair://invite` with URL-encoded `server`, `id`, and `pin` query parameters. Show the server origin to the user for confirmation and ask before using local HTTP. Redeem once with the invitation ID, PIN, and device name at `POST /api/v1/device-pairing/invitations/redeem`. A successful claim returns the same read-only device token as request-first pairing. The owner can withdraw the unused code with `DELETE /api/v1/device-pairing/invitations/{id}`.

## iOS and other Apple apps

Pin the Emulation Server Swift SDK by adding the repository as a SwiftPM dependency:

```swift
.package(url: "https://github.com/Provenance-Emu/emulator-content-server.git", exact: "0.1.7-swift.1")
```

Add `.product(name: "EmulatorContentClient", package: "emulator-content-server")` to the app target's dependencies. Xcode can use the same URL with the **Exact Version** rule. The tag pins the Swift package and the matching OpenAPI contract together. Existing clients that vendor `clients/swift` can continue to use that package path.

The package provides Codable models and `ContentSync` for the change feed, save adoption and resume requests. In revisions with request-first pairing, `DevicePairingClient` handles approval polling, PIN or QR redemption and fallback for older servers. `DevicePairingView` provides the shared pairing sheet, with camera scanning on supported iOS devices. Apps that offer scanning provide a camera usage description. The package declares iOS 17, tvOS 17, macOS 14 and visionOS 1 minimums. Use `URLSession` for catalog requests and file downloads. For example, after selecting a server and retrieving its token from Keychain:

```swift
import EmulatorContentClient
import Foundation

func libraries(server: URL, token: String) async throws -> LibraryList {
    let url = server.appending(path: "api/v1/browse-libraries")
    var request = URLRequest(url: url)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let (data, response) = try await URLSessionTransport().data(for: request)
    guard response.statusCode == 200 else {
        throw SyncFailure(status: response.statusCode, message: "Could not list libraries")
    }
    return try JSONDecoder().decode(LibraryList.self, from: data)
}
```

## Virtual Jaguar on Windows, Linux and macOS

Put the server picker, authentication, catalog and download cache in the standalone app's `app/` front end. Its existing HTTP layer uses WinHTTP on Windows and libcurl on Linux and macOS. Use the read flow above to stage the chosen game, then pass its local path to the existing loader. Use the app's HTTP and JSON handling for catalog calls. The generated C client builds, but its parser rejects required nullable fields such as `nextCursor: null` on the last page. Stream file transfers to disk through the app's HTTP layer.

Browse `com.provenance.jaguar` for cartridges and `com.provenance.jaguarcd` for discs. For an indexed CUE/BIN source, call `GET /api/v1/sources/{sourceId}/group`, check `error`, and download each member by ID into its `relativePath` under one staging directory. Open the staged CUE after all members are present. `/bundle` can download a complete disc group as a ZIP when the client supports safe extraction. CHD content requires support in the local emulator or a compatible server-provided virtual entry.

## Generate client source

Install Java 21 and download the pinned [OpenAPI Generator CLI 7.27.0](https://repo.maven.apache.org/maven2/org/openapitools/openapi-generator-cli/7.27.0/openapi-generator-cli-7.27.0.jar) as `openapi-generator.jar`. From the checkout, copy `packages/protocol/openapi/openapi.yaml` into your working directory, or download it from the target server. Validate it and generate into a fresh output directory.

```sh
curl --fail --silent --show-error http://127.0.0.1:8473/openapi.yaml -o openapi.yaml
java -jar openapi-generator.jar validate -i openapi.yaml
java -jar openapi-generator.jar generate -i openapi.yaml -g swift6 -o sdk/swift --additional-properties "hideGenerationTimestamp=true,disallowAdditionalPropertiesIfNotPresent=false"
```

Replace `-g swift6 -o sdk/swift` with any of these arguments. The same Java commands work from PowerShell.

| Target | Arguments | Generated client |
| --- | --- | --- |
| Node.js | `-g typescript-fetch -o sdk/node` | TypeScript using Fetch |
| Python | `-g python -o sdk/python` | Python package |
| Swift | `-g swift6 -o sdk/swift` | Swift 6 package |
| Objective-C | `-g objc -o sdk/objc` | Objective-C client |
| C# | `-g csharp -o sdk/csharp` | .NET client |
| C | `-g c -o sdk/c --model-name-mappings Item=ecs_item` | C client using libcurl |
| C++ | `-g cpp-qt-client -o sdk/cpp` | C++ client using Qt |
| Kotlin | `-g kotlin -o sdk/kotlin` | Kotlin client |
| Java | `-g java -o sdk/java` | Java client |

With the platform's libcurl development files installed, build the generated C client with CMake.

```sh
cmake -S sdk/c -B sdk/c-build -DCMAKE_POLICY_VERSION_MINIMUM=3.10
cmake --build sdk/c-build --config Release
```

For any target, `java -jar openapi-generator.jar config-help -g <target>` lists package and transport options. Set the generated client's base URL to the server origin, such as `https://content.example.org`. The generated paths include `/api/v1`. See the [generator catalog](https://openapi-generator.tech/docs/generators/).

The [Client SDK sources workflow](https://github.com/Provenance-Emu/emulator-content-server/actions/workflows/client-sdks.yml) regenerates these nine targets and bundles them with the exact contract when the contract changes on `main`. Download `ecs-client-sources-<commit>` from a successful run. These are source snapshots. Generated transport and nullability behavior vary by language, and some server administration operations currently document only their status codes. Build and test the operations your app uses before distributing a client. Registry publication would need a separate package and release workflow for each ecosystem.
