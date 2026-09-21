// swift-tools-version:5.5
import PackageDescription

let package = Package(
    name: "tauri-plugin-icloud-folder",
    // Matches the app's own floor (bundle.iOS.minimumSystemVersion in
    // tauri.conf.json). The iOS 27 SDK refuses a deployment target below
    // 15.0 outright, and ML Kit — which the app links — wants 15.5.
    platforms: [
        .iOS(.v15),
    ],
    products: [
        .library(
            name: "tauri-plugin-icloud-folder",
            type: .static,
            targets: ["tauri-plugin-icloud-folder"]
        ),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
    ],
    targets: [
        .target(
            name: "tauri-plugin-icloud-folder",
            dependencies: [
                .byName(name: "Tauri"),
            ],
            path: "Sources"
        ),
    ]
)
