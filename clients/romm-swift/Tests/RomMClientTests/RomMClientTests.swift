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

@Test func rejectedAuthentication() async throws {
    let client = try makeClient(FixtureTransport(status: 401))
    await #expect(throws: RomMError.accessDenied) { try await client.platforms() }
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

    init(files: [FixtureFile] = [], status: Int = 200) {
        self.files = files
        self.status = status
    }

    func data(for request: URLRequest) throws -> (Data, URLResponse) {
        requests.append(request)
        let url = try #require(request.url)
        let body: Any
        switch url.path {
        case "/install/api/platforms":
            body = [["id": 7, "slug": "dc", "fs_slug": "dreamcast", "name": "Sega Dreamcast", "display_name": "Dreamcast", "rom_count": 2]]
        case "/install/api/roms":
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let offset = Int(query.first { $0.name == "offset" }?.value ?? "") ?? 0
            body = [
                "items": [["id": 4 + offset, "name": "Test Game", "fs_name": "Test Game", "platform_id": 7, "platform_slug": "dc", "fs_size_bytes": 3]],
                "limit": 1, "total": 2, "offset": offset
            ]
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
