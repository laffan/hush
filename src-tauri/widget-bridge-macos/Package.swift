// swift-tools-version:5.5
import PackageDescription

// The Swift half of macOS home screen widgets, compiled and linked into
// the app by build.rs only when the `macos-widgets` feature is on (via
// swift-rs). Two C entry points, no Swift types cross the boundary, so
// it needs no SwiftRs runtime package.
let package = Package(
    name: "hush-widget-bridge",
    platforms: [
        .macOS(.v11),
    ],
    products: [
        .library(
            name: "hush-widget-bridge",
            type: .static,
            targets: ["HushWidgetBridge"]
        ),
    ],
    targets: [
        .target(
            name: "HushWidgetBridge",
            path: "Sources/HushWidgetBridge",
            linkerSettings: [
                .linkedFramework("WidgetKit"),
            ]
        ),
    ]
)
