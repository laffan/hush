import SwiftRs
import Tauri
import UIKit
import WidgetKit

// Home screen widgets — the app's half of the hand-off.
//
// The widget extension (widgets/ at the repo root) never reads a desk
// folder. It draws one JSON snapshot of recent desks and files, which the
// app builds (src/widgets/widget-snapshot.js) and sends here through the
// Rust command `publish_widget_snapshot`. This plugin writes it into the
// App Group container the app and the extension share, then asks
// WidgetKit to redraw every Hush widget from it.
//
// Without the App Group entitlement (a build that hasn't run
// `npm run ios:add-widgets`, or one whose signature lost the group),
// `containerURL` is nil. That is reported as an error rather than
// swallowed: a widget stuck on its empty state with nothing in the
// Activity Log is how a lost entitlement first went unnoticed. The app
// logs it and carries on, so the plugin is still safe in every build.

class HushWidgetsPlugin: Plugin {
  /// File name inside the group container. The extension reads the same
  /// name (widgets/Sources/HushWidgetsData.swift, `snapshotFileName`).
  static let snapshotFileName = "widgets.json"

  @objc public func publish(_ invoke: Invoke) throws {
    struct Args: Decodable {
      let json: String
      let appGroup: String
    }
    let args = try invoke.parseArgs(Args.self)
    guard
      let dir = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: args.appGroup)
    else {
      invoke.reject(
        "No App Group container for \(args.appGroup) — the app isn't signed with that App Group entitlement")
      return
    }
    let url = dir.appendingPathComponent(HushWidgetsPlugin.snapshotFileName)
    guard let data = args.json.data(using: .utf8) else {
      invoke.reject("Widget snapshot is not UTF-8")
      return
    }
    // Same bytes as last time — nothing for the widgets to redraw, and
    // WidgetKit's reload budget is worth keeping.
    if let existing = try? Data(contentsOf: url), existing == data {
      invoke.resolve(["written": false])
      return
    }
    do {
      try data.write(to: url, options: .atomic)
    } catch {
      invoke.reject("Couldn't write the widget snapshot: \(error.localizedDescription)")
      return
    }
    WidgetCenter.shared.reloadAllTimelines()
    invoke.resolve(["written": true])
  }
}

@_cdecl("init_plugin_hush_widgets")
func initPlugin() -> Plugin {
  return HushWidgetsPlugin()
}
