// swift-tools-version: 6.0
import PackageDescription

// The repository root is the SwiftPM entry point for tagged Git dependencies.
// Keep the nested package available to clients that vendor clients/swift.
let package = Package(
    name: "EmulatorContentClient",
    platforms: [
        .iOS(.v17),
        .tvOS(.v17),
        .macOS(.v14),
        .visionOS(.v1),
    ],
    products: [
        .library(name: "EmulatorContentClient", targets: ["EmulatorContentClient"]),
        .library(name: "RomMClient", targets: ["RomMClient"]),
    ],
    targets: [
        .target(
            name: "EmulatorContentClient",
            path: "clients/swift/Sources/EmulatorContentClient"
        ),
        .testTarget(
            name: "EmulatorContentClientTests",
            dependencies: ["EmulatorContentClient"],
            path: "clients/swift/Tests/EmulatorContentClientTests"
        ),
        .target(name: "RomMClient", path: "clients/romm-swift/Sources/RomMClient"),
        .testTarget(
            name: "RomMClientTests",
            dependencies: ["RomMClient"],
            path: "clients/romm-swift/Tests/RomMClientTests"
        ),
    ]
)
