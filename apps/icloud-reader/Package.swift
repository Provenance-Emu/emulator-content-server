// swift-tools-version:5.9
import PackageDescription

// The macOS helper that reads Provenance's CloudKit container and hands saves to the server.
// See docs/superpowers/specs/2026-11-26-native-icloud-reader-design.md.
let package = Package(
  name: "icloud-reader",
  platforms: [.macOS(.v13)],
  targets: [
    // Everything except CloudKit, so the loop is tested without iCloud.
    .target(name: "ICloudReaderCore"),
    .executableTarget(name: "icloud-reader", dependencies: ["ICloudReaderCore"]),
    .testTarget(name: "ICloudReaderCoreTests", dependencies: ["ICloudReaderCore"]),
  ]
)
