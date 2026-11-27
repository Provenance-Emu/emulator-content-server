import Foundation

/// One save in iCloud, described but not sent. Mirrors `IcloudReaderSaveDescription`.
public struct SaveDescription: Codable, Equatable, Sendable {
  public var recordName: String
  public var changeTag: String
  public var gameId: String
  public var filename: String
  public var systemIdentifier: String?
  public var coreIdentifier: String?
  public var size: Int64
  public var device: String?
  public var modifiedAt: String?

  public init(
    recordName: String, changeTag: String, gameId: String, filename: String,
    systemIdentifier: String? = nil, coreIdentifier: String? = nil, size: Int64,
    device: String? = nil, modifiedAt: String? = nil
  ) {
    self.recordName = recordName
    self.changeTag = changeTag
    self.gameId = gameId
    self.filename = filename
    self.systemIdentifier = systemIdentifier
    self.coreIdentifier = coreIdentifier
    self.size = size
    self.device = device
    self.modifiedAt = modifiedAt
  }
}

/// What the app records about a game's file. Mirrors `IcloudReaderGameDescription`.
public struct GameDescription: Codable, Equatable, Sendable {
  public var gameId: String
  public var systemIdentifier: String?
  public var filename: String?
  public var size: Int64?
  public var title: String?
  public var lastPlayedAt: String?
  public var playCount: Int64?
  public var secondsPlayed: Int64?
  public var recordName: String?
  public var changeTag: String?
  public var description: String?
  public var developer: String?
  public var publisher: String?
  public var year: String?
  public var genre: String?
  public var region: String?
  public var language: String?
  public var hasCustomCover: Bool?

  public init(
    gameId: String, systemIdentifier: String? = nil, filename: String? = nil, size: Int64? = nil,
    title: String? = nil, lastPlayedAt: String? = nil, playCount: Int64? = nil,
    secondsPlayed: Int64? = nil
  ) {
    self.lastPlayedAt = lastPlayedAt
    self.playCount = playCount
    self.secondsPlayed = secondsPlayed
    self.gameId = gameId
    self.systemIdentifier = systemIdentifier
    self.filename = filename
    self.size = size
    self.title = title
  }
}

public enum AccountState: String, Codable, Sendable {
  case available, signedOut, restricted, unknown
}

/// Why something could not be read. The server takes only these words.
public enum ReadFailure: String, Codable, Error, Sendable {
  case missing, noFile, account, notAllowed, busy, network, unexpected
}

public struct WantedSave: Codable, Equatable, Sendable {
  public var requestId: String
  public var recordName: String
  /// Which file of the record: nil or "save" for the save state, "cover" for the game's cover.
  public var file: String?
  public init(requestId: String, recordName: String, file: String? = nil) {
    self.requestId = requestId
    self.recordName = recordName
    self.file = file
  }
}

/// A file a record can carry. The names are this program's; the store maps them to fields.
public enum RecordFile: Sendable {
  case save, cover
}

public enum Work: Equatable, Sendable {
  case none, list, stop
  case fetch([WantedSave])
}

/// Where saves are read from. The only implementation that ships reads CloudKit.
/// There is no way to write through this protocol, on purpose.
public protocol SaveStore: Sendable {
  func account() async -> AccountState
  /// Calls `page` with every save, a page at a time. Throws `ReadFailure`.
  func list(page: @Sendable ([SaveDescription]) async throws -> Void) async throws
  /// What the app records about each of the person's games: its file's name and size, and when
  /// and how much it was played. Throws `ReadFailure`.
  func games() async throws -> [GameDescription]
  /// A local file holding one of a record's files. Throws `ReadFailure`.
  func file(recordName: String, _ file: RecordFile) async throws -> URL
}

public enum LinkError: Error, Equatable {
  /// The server no longer takes this ticket. A new one is needed.
  case ticketEnded
  case refused(Int)
  case unreachable
}

/// The server's reader operations. See `/api/v1/icloud/reader` in the OpenAPI document.
public protocol ServerLink: Sendable {
  func work() async throws -> Work
  func account(_ state: AccountState) async throws
  func listing(_ saves: [SaveDescription], done: Bool, games: [GameDescription]) async throws
  func listingFailed(_ reason: ReadFailure) async throws
  func upload(requestId: String, file: URL) async throws
  func saveFailed(requestId: String, reason: ReadFailure) async throws
}
