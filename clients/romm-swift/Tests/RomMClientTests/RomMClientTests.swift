import Foundation
import Testing
@testable import RomMClient

@Test func addresses() throws {
    #expect(try RomMAddress(" Roms.example:443/romm/api/ ").baseURL.absoluteString == "https://roms.example/romm")
    #expect(try RomMAddress("http://[::1]:8080").baseURL.absoluteString == "http://[::1]:8080")
    for invalid in ["ftp://example.org", "https://name:pass@example.org", "https://example.org/a/%2E%2E",
                    "https://example.org/x%2Fy", "https://example.org?token=a", "https://example.org:99999"] {
        #expect(throws: RomMError.invalidAddress) { try RomMAddress(invalid) }
    }
}

@Test func credentialsAndHTTP() throws {
    let address = try RomMAddress("http://romm.local")
    #expect(throws: RomMError.insecureConnection) { try RomMClient(address: address, credential: .token("rmm_test")) }
    #expect(throws: RomMError.invalidCredential) { try RomMCredential.token("bad\r\nheader").authorization() }
    #expect(try RomMCredential.basic(username: "user", password: "a:b").authorization() == "Basic dXNlcjphOmI=")
    _ = try RomMClient(address: address, credential: .token("rmm_test"), allowHTTP: true)
}

@Test func savedLoginsRestoreCredentialsAndHTTPChoice() throws {
    let fixtures: [(RomMCredential, Bool, String?)] = [
        (.basic(username: "reader", password: "secret"), true, "Basic cmVhZGVyOnNlY3JldA=="),
        (.token("rmm_saved"), false, "Bearer rmm_saved"),
        (.none, false, nil)
    ]
    for (credential, allowHTTP, authorization) in fixtures {
        let login = RomMSavedLogin(credential: credential, allowHTTP: allowHTTP)
        let restored = try #require(RomMSavedLogin(storedValue: login.storedValue()))
        #expect(try restored.credential.authorization() == authorization)
        #expect(restored.allowHTTP == allowHTTP)
    }
    #expect(RomMSavedLogin(storedValue: "invalid") == nil)
}

@Test func browseAndSearch() async throws {
    let transport = FixtureTransport()
    let client = try makeClient(transport)
    let platforms = try await client.platforms()
    #expect(platforms.first?.title == "Dreamcast")
    let first = try await client.games(platformID: 7, search: "A+B & C", limit: 1)
    #expect(first.items.first?.title == "Test Game")
    #expect(first.nextOffset == 1)
    let last = try await client.games(platformID: 7, search: "A+B & C", offset: 1, limit: 1)
    #expect(last.nextOffset == nil)
    let requests = await transport.requests
    #expect(requests.count == 3)
    #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer rmm_fixture" })
    #expect(requests[1].url?.absoluteString.contains("search_term=A%2BB%20%26%20C") == true)
    #expect(requests[2].url?.absoluteString.contains("platform_ids=7&limit=1&offset=1") == true)
}

@Test func singleFile() async throws {
    let transport = FixtureTransport(files: [FixtureFile(1, "Test Game", "roms/dc")])
    let client = try makeClient(transport)
    let game = try #require(await client.games(platformID: 7).items.first)
    let result = try await client.download(game)
    defer { try? FileManager.default.removeItem(at: result.directory) }
    #expect(result.files.map(\.lastPathComponent) == ["Test Game"])
    #expect(try Data(contentsOf: result.files[0]) == Data([1, 2, 3]))
}

@Test func groupsPreserveOriginalLayout() async throws {
    let base = "roms/dc/Test Game"
    let transport = FixtureTransport(files: [
        FixtureFile(1, "Disc Set.m3u", base),
        FixtureFile(2, "game.gdi", base + "/Disc 1"),
        FixtureFile(3, "track01.bin", base + "/Disc 1"),
        FixtureFile(4, "game.gdi", base + "/Disc 2"),
        FixtureFile(5, "track01.bin", base + "/Disc 2"),
        FixtureFile(6, "arcade.zip", base),
        FixtureFile(7, "disc.chd", base + "/arcade"),
        FixtureFile(8, "optional.ips", base, category: "patch")
    ])
    let client = try makeClient(transport)
    let game = try #require(await client.games(platformID: 7).items.first)
    let result = try await client.download(game)
    defer { try? FileManager.default.removeItem(at: result.directory) }
    #expect(result.files.map { String($0.path.dropFirst(result.directory.path.count + 1)) } == [
        "Disc Set.m3u", "Disc 1/game.gdi", "Disc 1/track01.bin", "Disc 2/game.gdi", "Disc 2/track01.bin",
        "arcade.zip", "arcade/disc.chd"
    ])
    let requests = await transport.requests
    #expect(requests.contains { $0.url?.absoluteString.hasSuffix("/content/Disc%20Set.m3u?file_ids=1") == true })
    #expect(requests.contains { $0.url?.absoluteString.hasSuffix("/content/game.gdi?file_ids=2") == true })
    #expect(requests.contains { $0.url?.absoluteString.hasSuffix("/content/game.gdi?file_ids=4") == true })
}

@Test func rejectsUnsafeGroupsAndShortDownloads() async throws {
    let root = "roms/dc/Test Game"
    for files in [
        [FixtureFile(1, "outside", root + "/../other")],
        [FixtureFile(1, "disc.chd", root), FixtureFile(2, "Disc.CHD", root)],
        [FixtureFile(1, "disc", root), FixtureFile(2, "track", root + "/Disc")],
        [FixtureFile(1, "short.iso", root, size: 20)]
    ] {
        let client = try makeClient(FixtureTransport(files: files))
        let game = try #require(await client.games(platformID: 7).items.first)
        await #expect(throws: RomMError.invalidContent) { try await client.download(game) }
    }
}

@Test func coversResolveAgainstTheInstance() async throws {
    let relative = FixtureTransport(cover: "roms/7/4/cover/small.png?ts=2026-01-02 03:04")
    let game = try #require(await makeClient(relative).games(platformID: 7).items.first)
    #expect(game.coverPath == "roms/7/4/cover/small.png?ts=2026-01-02 03:04")
    #expect(try await makeClient(relative).cover(for: game) == Data([9, 8, 7]))
    let request = try #require(await relative.requests.last)
    #expect(request.url?.absoluteString
        == "https://romm.example/install/assets/romm/resources/roms/7/4/cover/small.png?ts=2026-01-02%2003:04")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer rmm_fixture")

    let rooted = FixtureTransport(cover: "/assets/romm/resources/ecs/4/cover")
    let gatewayGame = try #require(await makeClient(rooted).games(platformID: 7).items.first)
    #expect(try await makeClient(rooted).cover(for: gatewayGame) == Data([9, 8, 7]))
    #expect(await rooted.requests.last?.url?.absoluteString == "https://romm.example/install/assets/romm/resources/ecs/4/cover")

    let none = try #require(await makeClient(FixtureTransport()).games(platformID: 7).items.first)
    #expect(none.coverPath == nil)
    #expect(try await makeClient(FixtureTransport()).cover(for: none) == nil)

    let escaping = FixtureTransport(cover: "../../api/users")
    let hostile = try #require(await makeClient(escaping).games(platformID: 7).items.first)
    await #expect(throws: RomMError.invalidContent) { try await makeClient(escaping).cover(for: hostile) }
}

@Test func firmwareListsAndDownloads() async throws {
    let transport = FixtureTransport()
    let client = try makeClient(transport)
    let all = try await client.firmware()
    #expect(all.map(\.fileName) == ["naomi.zip", "dc_boot.bin", "gone.zip"])
    #expect(all.map(\.isDownloadable) == [true, true, false])
    // RomM 4.x sends no platform_id; 5.x does.
    #expect(all.map(\.platformId) == [9, nil, 9])
    _ = try await client.firmware(platformID: 9)
    await #expect(throws: RomMError.invalidContent) { try await client.firmware(platformID: 0) }

    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let destination = folder.appendingPathComponent("naomi.zip")
    try await client.download(all[0], to: destination)
    #expect(try Data(contentsOf: destination) == Data([1, 2, 3]))

    let requests = await transport.requests
    #expect(requests[0].url?.absoluteString == "https://romm.example/install/api/firmware")
    #expect(requests[1].url?.absoluteString == "https://romm.example/install/api/firmware?platform_id=9")
    #expect(requests[2].url?.absoluteString == "https://romm.example/install/api/firmware/31/content/naomi.zip")
    #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer rmm_fixture" })
}

@Test func firmwareRejectsMissingShortAndUnsafeFiles() async throws {
    let client = try makeClient(FixtureTransport())
    let all = try await client.firmware()
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    // The fixture download is 3 bytes; dc_boot.bin claims 20.
    await #expect(throws: RomMError.invalidContent) {
        try await client.download(all[1], to: folder.appendingPathComponent("dc_boot.bin"))
    }
    await #expect(throws: RomMError.unavailable) {
        try await client.download(all[2], to: folder.appendingPathComponent("gone.zip"))
    }
    #expect(try FileManager.default.contentsOfDirectory(atPath: folder.path).isEmpty)

    let hostile = try JSONDecoder.snakeCase.decode(RomMFirmware.self, from: Data(
        #"{"id":5,"file_name":"../naomi.zip","file_size_bytes":3}"#.utf8
    ))
    await #expect(throws: RomMError.unavailable) {
        try await client.download(hostile, to: folder.appendingPathComponent("naomi.zip"))
    }
}

@Test func firmwareWithoutTheScopeIsAccessDenied() async throws {
    let client = try makeClient(FixtureTransport(status: 403))
    await #expect(throws: RomMError.accessDenied) { try await client.firmware() }
}

@Test func rejectedAuthentication() async throws {
    let client = try makeClient(FixtureTransport(status: 401))
    await #expect(throws: RomMError.accessDenied) { try await client.platforms() }
}

private extension JSONDecoder {
    static var snakeCase: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }
}

private func makeClient(_ transport: FixtureTransport) throws -> RomMClient {
    try RomMClient(address: RomMAddress("https://romm.example/install/api"), credential: .token("rmm_fixture"), transport: transport)
}

private struct FixtureFile: Sendable {
    let id: Int
    let name: String
    let path: String
    let size: Int
    let category: String

    init(_ id: Int, _ name: String, _ path: String, size: Int = 3, category: String = "game") {
        self.id = id
        self.name = name
        self.path = path
        self.size = size
        self.category = category
    }
}

private actor FixtureTransport: RomMTransport {
    var requests: [URLRequest] = []
    private let files: [FixtureFile]
    private let status: Int
    private let cover: String?

    init(files: [FixtureFile] = [], status: Int = 200, cover: String? = nil) {
        self.files = files
        self.status = status
        self.cover = cover
    }

    func data(for request: URLRequest) throws -> (Data, URLResponse) {
        requests.append(request)
        let url = try #require(request.url)
        if url.path.hasPrefix("/install/assets/") { return (Data([9, 8, 7]), try response(for: url)) }
        let body: Any
        switch url.path {
        case "/install/api/platforms":
            body = [["id": 7, "slug": "dc", "fs_slug": "dreamcast", "name": "Sega Dreamcast", "display_name": "Dreamcast", "rom_count": 2]]
        case "/install/api/firmware":
            body = [
                ["id": 31, "platform_id": 9, "file_name": "naomi.zip", "file_size_bytes": 3,
                 "md5_hash": "abc", "sha1_hash": "def", "missing_from_fs": false],
                ["id": 32, "file_name": "dc_boot.bin", "file_size_bytes": 20],
                ["id": 33, "platform_id": 9, "file_name": "gone.zip", "file_size_bytes": 3, "missing_from_fs": true]
            ]
        case "/install/api/roms":
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let offset = Int(query.first { $0.name == "offset" }?.value ?? "") ?? 0
            var game: [String: Any] = ["id": 4 + offset, "name": "Test Game", "fs_name": "Test Game", "platform_id": 7,
                                       "platform_slug": "dc", "fs_size_bytes": 3]
            if let cover { game["path_cover_small"] = cover }
            body = ["items": [game], "limit": 1, "total": 2, "offset": offset]
        default:
            body = [
                "id": 4, "fs_name": "Test Game", "fs_path": "roms/dc",
                "files": files.map { ["id": $0.id, "file_name": $0.name, "file_path": $0.path, "file_size_bytes": $0.size, "category": $0.category] }
            ]
        }
        return (try JSONSerialization.data(withJSONObject: body), try response(for: url))
    }

    func download(for request: URLRequest) throws -> (URL, URLResponse) {
        requests.append(request)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data([1, 2, 3]).write(to: url)
        return (url, try response(for: #require(request.url)))
    }

    private func response(for url: URL) throws -> URLResponse {
        try #require(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil))
    }
}
