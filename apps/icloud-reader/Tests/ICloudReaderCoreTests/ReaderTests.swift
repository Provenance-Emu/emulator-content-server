import XCTest

@testable import ICloudReaderCore

/// Stands in for iCloud with generated saves.
struct FakeStore: SaveStore {
  var state: AccountState = .available
  var saves: [SaveDescription] = []
  var unreadable: Set<String> = []
  var listFailure: ReadFailure?
  let folder: URL

  func account() async -> AccountState { state }
  func list(page: @Sendable ([SaveDescription]) async throws -> Void) async throws {
    if let listFailure { throw listFailure }
    try await page(saves)
  }
  func games() async throws -> [GameDescription] {
    [GameDescription(gameId: "generated", filename: "game.nes", size: 9, title: "Game", playCount: 3)]
  }
  func file(recordName: String, _ file: RecordFile) async throws -> URL {
    if file == .cover {
      let url = folder.appendingPathComponent(UUID().uuidString)
      try Data("cover of \(recordName)".utf8).write(to: url)
      return url
    }
    if unreadable.contains(recordName) { throw ReadFailure.noFile }
    guard saves.contains(where: { $0.recordName == recordName }) else { throw ReadFailure.missing }
    let url = folder.appendingPathComponent(UUID().uuidString)
    try Data("bytes of \(recordName)".utf8).write(to: url)
    return url
  }
}

/// Fails the first read of each save the way a throttled iCloud does.
final class BusyOnceStore: SaveStore, @unchecked Sendable {
  private let inner: FakeStore
  private let lock = NSLock()
  private var seen: Set<String> = []
  init(inner: FakeStore) { self.inner = inner }
  func account() async -> AccountState { await inner.account() }
  func list(page: @Sendable ([SaveDescription]) async throws -> Void) async throws {
    try await inner.list(page: page)
  }
  func games() async throws -> [GameDescription] { [] }
  func file(recordName: String, _ file: RecordFile) async throws -> URL {
    let first = lock.withLock { seen.insert(recordName).inserted }
    if first { throw ReadFailure.busy }
    return try await inner.file(recordName: recordName, file)
  }
}

/// Stands in for the server: hands out a script of work, then says the ticket ended.
actor FakeLink: ServerLink {
  private var script: [Work]
  private(set) var events: [String] = []
  init(_ script: [Work]) { self.script = script }

  func work() async throws -> Work {
    if script.isEmpty {
      // Let work already started finish before the loop is told to leave.
      try await Task.sleep(for: .milliseconds(80))
      throw LinkError.ticketEnded
    }
    return script.removeFirst()
  }
  func account(_ state: AccountState) { events.append("account \(state.rawValue)") }
  func listing(_ saves: [SaveDescription], done: Bool, games: [GameDescription]) {
    let about = games.isEmpty ? "" : " games=\(games.count)"
    events.append("listing \(saves.map(\.filename).joined(separator: ",")) \(done)\(about)")
  }
  func listingFailed(_ reason: ReadFailure) { events.append("listing failed \(reason.rawValue)") }
  func upload(requestId: String, file: URL) throws {
    events.append("save \(requestId) \(try String(contentsOf: file, encoding: .utf8))")
  }
  func saveFailed(requestId: String, reason: ReadFailure) {
    events.append("save failed \(requestId) \(reason.rawValue)")
  }
}

final class ReaderTests: XCTestCase {
  private var folder: URL!

  override func setUpWithError() throws {
    folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }
  override func tearDownWithError() throws { try FileManager.default.removeItem(at: folder) }

  private func save(_ name: String) -> SaveDescription {
    SaveDescription(
      recordName: "savestate_\(name)", changeTag: "tag1", gameId: String(repeating: "A", count: 32),
      filename: "\(name).svs", size: 20)
  }

  func testListsInPagesThenSendsOnlyWhatWasAskedFor() async {
    let store = FakeStore(saves: [save("one"), save("two"), save("three")], folder: folder)
    let link = FakeLink([
      .list, .none,
      .fetch([WantedSave(requestId: "r1", recordName: "savestate_two")]),
    ])
    let reason = await Reader(store: store, link: link, pageSize: 2).run()
    XCTAssertEqual(reason, .ticketEnded)
    let events = await link.events
    XCTAssertEqual(
      events,
      [
        "account available",
        "listing one.svs,two.svs false", "listing three.svs false", "listing  true games=1",
        "save r1 bytes of savestate_two",
      ])
  }

  func testSaysWhyAListingOrASaveCouldNotBeRead() async {
    var store = FakeStore(saves: [save("one")], folder: folder)
    store.unreadable = ["savestate_one"]
    let link = FakeLink([
      .fetch([
        WantedSave(requestId: "r1", recordName: "savestate_one"),
        WantedSave(requestId: "r2", recordName: "savestate_gone"),
      ])
    ])
    _ = await Reader(store: store, link: link).run()
    let events = await link.events
    XCTAssertEqual(events.suffix(2), ["save failed r1 noFile", "save failed r2 missing"])

    store.listFailure = .busy
    let second = FakeLink([.list])
    _ = await Reader(store: store, link: second).run()
    let listed = await second.events
    XCTAssertEqual(listed.last, "listing failed busy")
  }

  func testReadsASaveAgainWhenICloudAsksForAPause() async {
    let store = BusyOnceStore(inner: FakeStore(saves: [save("one")], folder: folder))
    let link = FakeLink([.fetch([WantedSave(requestId: "r1", recordName: "savestate_one")])])
    _ = await Reader(store: store, link: link, retryDelay: .milliseconds(5)).run()
    let events = await link.events
    XCTAssertEqual(events.last, "save r1 bytes of savestate_one")
  }

  func testSendsAGamesCoverWhenThatIsTheFileAskedFor() async {
    let store = FakeStore(saves: [save("one")], folder: folder)
    let link = FakeLink([
      .fetch([WantedSave(requestId: "c1", recordName: "rom_generated", file: "cover")])
    ])
    _ = await Reader(store: store, link: link).run()
    let events = await link.events
    XCTAssertEqual(events.last, "save c1 cover of rom_generated")
  }

  func testReportsASignedOutMacAndTakesOnlyALoopbackServer() async {
    let store = FakeStore(state: .signedOut, folder: folder)
    let link = FakeLink([.none])
    _ = await Reader(store: store, link: link).run()
    let events = await link.events
    XCTAssertEqual(events, ["account signedOut"])

    XCTAssertNotNil(HTTPLink(origin: "http://127.0.0.1:7878", ticket: "generated"))
    XCTAssertNil(HTTPLink(origin: "http://192.168.1.20:7878", ticket: "generated"))
    XCTAssertNil(HTTPLink(origin: "https://example.com", ticket: "generated"))
    XCTAssertNil(HTTPLink(origin: "http://127.0.0.1:7878/elsewhere", ticket: "generated"))
    XCTAssertNil(HTTPLink(origin: "http://127.0.0.1:7878", ticket: ""))
  }
}
