import Foundation
import Testing
import RomMClient

@Test(.enabled(if: ProcessInfo.processInfo.environment["ROMM_DEMO_SMOKE"] == "1"))
func officialDemo() async throws {
    let client = try RomMClient(address: RomMAddress("https://demo.romm.app"), credential: .none)
    let platforms = try await client.platforms()
    let snes = try #require(platforms.first { $0.slug == "snes" })
    let first = try await client.games(platformID: snes.id, limit: 1)
    let offset = try #require(first.nextOffset)
    let second = try await client.games(platformID: snes.id, offset: offset, limit: 1)
    #expect(first.items.first?.id != second.items.first?.id)

    let search = try await client.games(platformID: snes.id, search: "Christmas Craze")
    let game = try #require(search.items.first { $0.fsName == "Christmas Craze.smc" })
    let result = try await client.download(game)
    defer { try? FileManager.default.removeItem(at: result.directory) }
    #expect(result.files.count == 1)
    let size = try result.files.first?.resourceValues(forKeys: [.fileSizeKey]).fileSize
    #expect(size.map(Int64.init) == game.fsSizeBytes)

    let scummVM = try #require(platforms.first { $0.slug == "scummvm" })
    let results = try await client.games(platformID: scummVM.id, search: "Flight of the Amazon Queen")
    let group = try #require(results.items.first { $0.fsName == "Flight of the Amazon Queen" })
    let grouped = try await client.download(group)
    defer { try? FileManager.default.removeItem(at: grouped.directory) }
    #expect(Set(grouped.files.map { $0.lastPathComponent }) == ["WRC-MANIFEST.JSON", "queen.1"])
}
