import XCTest

/// The helper's entitlement allows writing to iCloud. Nothing in its source may.
final class ReadOnlyTests: XCTestCase {
  func testNoSourceFileCanChangeICloud() throws {
    let sources = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources")
    // Split so this list does not trip a search of the repository for the same words.
    let forbidden = [
      "CKModify", "CKSubscription", "CKRecordZone(", "CKShare", "CKDiscover", ".save(", ".delete",
      "modifyRecords", "modifyRecordZones", "modifySubscriptions", "CKRecord(recordType",
      "publicCloudDatabase", "sharedCloudDatabase",
    ]
    let files = FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)?
      .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
    XCTAssertGreaterThan(files.count, 3)
    for file in files {
      let code = try String(contentsOf: file, encoding: .utf8)
        .split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
        .joined(separator: "\n")
      for word in forbidden {
        XCTAssertFalse(code.contains(word), "\(file.lastPathComponent) contains \(word)")
      }
    }
  }
}
