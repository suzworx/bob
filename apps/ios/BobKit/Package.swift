// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "BobKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "BobKit", targets: ["BobKit"])
    ],
    targets: [
        .target(name: "BobKit"),
        .testTarget(name: "BobKitTests", dependencies: ["BobKit"])
    ]
)
