# Connect an emulator to Emulation Server

Open `/docs/` on the server, for example [the local API reference](http://127.0.0.1:8473/docs/). Swagger UI reads `/openapi.yaml` from that same server, so the reference tracks the installed build. The [contract on main](https://raw.githubusercontent.com/Provenance-Emu/emulator-content-server/main/packages/protocol/openapi/openapi.yaml) tracks development. Pin a commit or use the installed server's contract when generating a client for a specific build.

The contract uses OpenAPI 3.1.2. OpenAPI 3.2.1 is the newer specification, but the pinned generator cannot validate this contract as 3.2.1. The wire API is still `/api/v1`. See the [OpenAPI specification versions](https://spec.openapis.org/oas/) and [protocol versioning](versioning.md).

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

## iOS and other Apple apps

For Provenance, iCube and iFly, add the local Swift package at `clients/swift` from a pinned checkout. It provides Codable models and `ContentSync` for the change feed, save adoption and resume requests. The package declares iOS 17, tvOS 17, macOS 14 and visionOS 1 minimums. Use `URLSession` for catalog requests and file downloads. For example, after selecting a server and retrieving its token from Keychain:

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

Put the server picker, authentication, catalog and download cache in the standalone app's `app/` front end. Its existing HTTP layer uses WinHTTP on Windows and libcurl on Linux and macOS. Use the read flow above to stage the chosen game, then pass its local path to the existing loader. The generated C client below is a libcurl-based option for JSON calls. Keep large file transfers in the app's streaming layer.

Browse `com.provenance.jaguar` for cartridges and `com.provenance.jaguarcd` for discs. For an indexed CUE/BIN source, call `GET /api/v1/sources/{sourceId}/group`, check `error`, and download each member by ID into its `relativePath` under one staging directory. Open the staged CUE after all members are present. `/bundle` can download a complete disc group as a ZIP when the client supports safe extraction. CHD content requires support in the local emulator or a compatible server-provided virtual entry.

## Generate client source

Install Java 21 and download the pinned [OpenAPI Generator CLI 7.27.0](https://repo.maven.apache.org/maven2/org/openapitools/openapi-generator-cli/7.27.0/openapi-generator-cli-7.27.0.jar) as `openapi-generator.jar`. From the checkout, copy `packages/protocol/openapi/openapi.yaml` into your working directory, or download it from the target server. Validate it and generate into a fresh output directory.

```sh
curl --fail --silent --show-error http://127.0.0.1:8473/openapi.yaml -o openapi.yaml
java -jar openapi-generator.jar validate -i openapi.yaml
java -jar openapi-generator.jar generate -i openapi.yaml -g swift6 -o sdk/swift
```

Replace `-g swift6 -o sdk/swift` with any of these arguments. The same Java commands work from PowerShell.

| Target | Arguments | Generated client |
| --- | --- | --- |
| Node.js | `-g typescript-fetch -o sdk/node` | TypeScript using Fetch |
| Python | `-g python -o sdk/python` | Python package |
| Swift | `-g swift6 -o sdk/swift` | Swift 6 package |
| Objective-C | `-g objc -o sdk/objc` | Objective-C client |
| C# | `-g csharp -o sdk/csharp` | .NET client |
| C | `-g c -o sdk/c` | C client using libcurl |
| C++ | `-g cpp-qt-client -o sdk/cpp` | C++ client using Qt |
| Kotlin | `-g kotlin -o sdk/kotlin` | Kotlin client |
| Java | `-g java -o sdk/java` | Java client |

For any target, `java -jar openapi-generator.jar config-help -g <target>` lists package and transport options. Set the generated client's base URL to the server origin, such as `https://content.example.org`. The generated paths include `/api/v1`. See the [generator catalog](https://openapi-generator.tech/docs/generators/).

The [Client SDK sources workflow](https://github.com/Provenance-Emu/emulator-content-server/actions/workflows/client-sdks.yml) regenerates these nine targets and bundles them with the exact contract when the contract changes on `main`. Download `ecs-client-sources-<commit>` from a successful run. These are source snapshots. Generated transport and nullability behavior vary by language, and some server administration operations currently document only their status codes. Build and test the operations your app uses before distributing a client. Registry publication would need a separate package and release workflow for each ecosystem.
