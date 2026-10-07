import Foundation
import WidgetKit

// macOS counterpart of tauri-plugin-hush-widgets' Swift half: write the
// widget snapshot into the App Group container and reload the widgets'
// timelines. Called from src-tauri/src/widgets.rs (`macos` module).
//
// The container is resolved through FileManager rather than by building
// ~/Library/Group Containers/<group> by hand: on macOS 15 a group
// container is only reachable that way, and only for a group the app's
// signature names (prefixed with the signing team's ID).

/// Must match HushWidgetStore.snapshotFileName in the extension.
private let snapshotFileName = "widgets.json"

/// 1 = written, 0 = unchanged, -1 = no container, -2 = write failed,
/// -3 = bad arguments.
@_cdecl("hush_widgets_publish")
public func hushWidgetsPublish(_ json: UnsafePointer<CChar>?, _ appGroup: UnsafePointer<CChar>?) -> Int32 {
  guard let json, let appGroup else { return -3 }
  let group = String(cString: appGroup)
  guard let data = String(cString: json).data(using: .utf8) else { return -3 }
  guard
    let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
  else { return -1 }
  let url = dir.appendingPathComponent(snapshotFileName)
  if let existing = try? Data(contentsOf: url), existing == data { return 0 }
  do {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
  } catch {
    return -2
  }
  if #available(macOS 11.0, *) {
    WidgetCenter.shared.reloadAllTimelines()
  }
  return 1
}
