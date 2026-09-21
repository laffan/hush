// swift-tools-version:5.5
import PackageDescription

let package = Package(
    name: "tauri-plugin-pencil",
    // Matches the app's own floor (bundle.iOS.minimumSystemVersion in
    // tauri.conf.json). The iOS 27 SDK refuses a deployment target below
    // 15.0 outright, and ML Kit — which the app links — wants 15.5.
    platforms: [
        .iOS(.v15),
    ],
    products: [
        .library(
            name: "tauri-plugin-pencil",
            type: .static,
            targets: ["tauri-plugin-pencil"]
        ),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
    ],
    targets: [
        .target(
            name: "tauri-plugin-pencil",
            dependencies: [
                .byName(name: "Tauri"),
            ],
            path: "Sources"
        ),
    ]
)
