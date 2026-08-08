// swift-tools-version:5.5
import PackageDescription

let package = Package(
    name: "tauri-plugin-scene-reuse",
    platforms: [
        .iOS(.v13),
    ],
    products: [
        .library(
            name: "tauri-plugin-scene-reuse",
            type: .static,
            targets: ["tauri-plugin-scene-reuse"]
        ),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
    ],
    targets: [
        .target(
            name: "tauri-plugin-scene-reuse",
            dependencies: [
                .byName(name: "Tauri"),
            ],
            path: "Sources"
        ),
    ]
)
