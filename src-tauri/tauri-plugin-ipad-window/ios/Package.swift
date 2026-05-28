// swift-tools-version:5.5
import PackageDescription

let package = Package(
    name: "tauri-plugin-ipad-window",
    platforms: [
        .iOS(.v13),
    ],
    products: [
        .library(
            name: "tauri-plugin-ipad-window",
            type: .static,
            targets: ["tauri-plugin-ipad-window"]
        ),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
    ],
    targets: [
        .target(
            name: "tauri-plugin-ipad-window",
            dependencies: [
                .byName(name: "Tauri"),
            ],
            path: "Sources"
        ),
    ]
)
