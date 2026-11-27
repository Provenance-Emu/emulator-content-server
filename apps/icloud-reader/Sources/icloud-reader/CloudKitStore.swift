import CloudKit
import Foundation
import ICloudReaderCore

/// Reads Provenance's save states from the signed-in person's private CloudKit database.
///
/// READ ONLY. The entitlement this program carries would allow writing, so the guarantee is this
/// file: it queries and fetches and does nothing else. The apps depend on these records. A test
/// fails the build if a call that changes iCloud appears anywhere in this package's sources.
struct CloudKitStore: SaveStore {
  static let containerIdentifier = "iCloud.org.provenance-emu.provenance"
  private static let listed = [
    "gameID", "filename", "systemIdentifier", "coreIdentifier", "fileSize", "lastModifiedDevice",
  ]

  private let container = CKContainer(identifier: containerIdentifier)
  private var database: CKDatabase { container.privateCloudDatabase }

  func account() async -> AccountState {
    switch try? await container.accountStatus() {
    case .available: return .available
    case .noAccount: return .signedOut
    case .restricted: return .restricted
    default: return .unknown
    }
  }

  func list(page: @Sendable ([SaveDescription]) async throws -> Void) async throws {
    let query = CKQuery(recordType: "SaveState", predicate: NSPredicate(value: true))
    do {
      var found = try await database.records(
        matching: query, desiredKeys: Self.listed, resultsLimit: 200)
      while true {
        try await page(found.matchResults.compactMap { Self.describe($0.1) })
        guard let cursor = found.queryCursor else { return }
        found = try await database.records(
          continuingMatchFrom: cursor, desiredKeys: Self.listed, resultsLimit: 200)
      }
    } catch let error as CKError {
      throw Self.failure(error)
    }
  }

  func games() async throws -> [GameDescription] {
    // The game's file itself is never asked for: only what describes it.
    let keys = [
      "md5", "systemIdentifier", "originalFilename", "fileSize", "title", "lastPlayed", "playCount",
      "timeSpentInGame", "gameDescription", "developer", "publisher", "publishDate", "genres",
      "regionName", "language", "customArtworkURL",
    ]
    let stamp = ISO8601DateFormatter()
    stamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let query = CKQuery(recordType: "ROM", predicate: NSPredicate(value: true))
    var games: [GameDescription] = []
    do {
      var found = try await database.records(matching: query, desiredKeys: keys, resultsLimit: 200)
      while true {
        for (_, result) in found.matchResults {
          guard case .success(let record) = result, let md5 = record["md5"] as? String,
            !md5.isEmpty
          else { continue }
          let count: (String) -> Int64? = { key in
            (record[key] as? Int64).flatMap { $0 >= 0 ? $0 : nil }
          }
          let text: (String) -> String? = { key in
            (record[key] as? String).flatMap { $0.isEmpty ? nil : $0 }
          }
          var game =
            GameDescription(
              gameId: md5,
              systemIdentifier: text("systemIdentifier"),
              filename: text("originalFilename"),
              size: (record["fileSize"] as? Int64).flatMap { $0 > 0 ? $0 : nil },
              title: text("title"),
              lastPlayedAt: (record["lastPlayed"] as? Date).map(stamp.string(from:)),
              playCount: count("playCount"),
              secondsPlayed: count("timeSpentInGame"))
          game.recordName = record.recordID.recordName
          game.changeTag = record.recordChangeTag
          game.description = text("gameDescription")
          game.developer = text("developer")
          game.publisher = text("publisher")
          game.year = Self.year(record["publishDate"])
          game.genre = text("genres")
          game.region = text("regionName")
          game.language = text("language")
          // The cover itself is fetched only if the server asks; its key says whether one exists.
          game.hasCustomCover = text("customArtworkURL") != nil
          games.append(game)
        }
        guard let cursor = found.queryCursor else { return games }
        found = try await database.records(
          continuingMatchFrom: cursor, desiredKeys: keys, resultsLimit: 200)
      }
    } catch let error as CKError {
      throw Self.failure(error)
    }
  }

  func file(recordName: String, _ file: RecordFile) async throws -> URL {
    let field = file == .cover ? "customArtworkAsset" : "fileData"
    do {
      let results = try await database.records(
        for: [CKRecord.ID(recordName: recordName)], desiredKeys: [field])
      guard case .success(let record)? = results.values.first else { throw ReadFailure.missing }
      guard let url = (record[field] as? CKAsset)?.fileURL else { throw ReadFailure.noFile }
      return url
    } catch let error as CKError {
      throw Self.failure(error)
    }
  }

  /// The four-digit year in a release date the app stores as text or as a date.
  private static func year(_ value: Any?) -> String? {
    if let date = value as? Date {
      return String(Calendar(identifier: .gregorian).component(.year, from: date))
    }
    guard let text = value as? String else { return nil }
    return text.range(of: #"(19|20)\d\d"#, options: .regularExpression).map { String(text[$0]) }
  }

  private static func describe(_ result: Result<CKRecord, Error>) -> SaveDescription? {
    guard case .success(let record) = result,
      let gameId = record["gameID"] as? String, !gameId.isEmpty,
      let filename = record["filename"] as? String, !filename.isEmpty
    else { return nil }
    let stamp = ISO8601DateFormatter()
    stamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return SaveDescription(
      recordName: record.recordID.recordName,
      changeTag: record.recordChangeTag ?? "",
      gameId: gameId,
      filename: filename,
      systemIdentifier: record["systemIdentifier"] as? String,
      coreIdentifier: record["coreIdentifier"] as? String,
      size: max(0, (record["fileSize"] as? Int64) ?? 0),
      device: record["lastModifiedDevice"] as? String,
      modifiedAt: record.modificationDate.map(stamp.string(from:))
    )
  }

  private static func failure(_ error: CKError) -> ReadFailure {
    switch error.code {
    case .unknownItem: return .missing
    case .notAuthenticated, .accountTemporarilyUnavailable: return .account
    // iCloud does not accept this program for the container: its App ID or profile is wrong.
    case .permissionFailure, .badContainer, .missingEntitlement: return .notAllowed
    case .networkUnavailable, .networkFailure: return .network
    case .requestRateLimited, .serviceUnavailable, .zoneBusy: return .busy
    default:
      // The code alone, so a new kind of failure can be told apart in the log.
      FileHandle.standardError.write(Data("icloud-reader: CloudKit error code \(error.code.rawValue)\n".utf8))
      return .unexpected
    }
  }
}
