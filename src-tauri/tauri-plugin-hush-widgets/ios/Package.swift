// swift-tools-version:5.5
import PackageDescription

let package = Package(
    name: "tauri-plugin-hush-widgets",
    // Matches the app's own floor (bundle.iOS.minimumSystemVersion in
    // tauri.conf.json), as the other plugins do. WidgetKit itself is
    // iOS 14+, so the floor is no constraint on it.
    platforms: [
        .iOS(.v15),
    ],
    products: [
        .library(
            name: "tauri-plugin-hush-widgets",
            type: .static,
            targets: ["tauri-plugin-hush-widgets"]
        ),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
    ],
    targets: [
        .target(
            name: "tauri-plugin-hush-widgets",
            dependencies: [
                .byName(name: "Tauri"),
            ],
            path: "Sources",
            linkerSettings: [
                .linkedFramework("WidgetKit"),
            ]
        ),
    ]
)
