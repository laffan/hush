import Foundation
import WidgetKit

// The snapshot the app publishes (src/widgets/widget-snapshot.js) and
// the links a tap sends back (src/widgets/widget-links.js). The two
// sides agree on this file's shapes and nothing else: the extension
// never reads a desk folder, and the app never learns how a widget is
// drawn.

/// One openable entry: a document, notebook, stack, PDF or project.
struct WidgetFile: Codable, Hashable, Identifiable {
  let id: String
  let name: String
  let type: String
  let deskId: String
  let deskName: String
  /// Epoch milliseconds, or nil for a file opened before times were kept.
  let openedAt: Double?

  var openedDate: Date? { openedAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

struct WidgetDesk: Codable, Hashable, Identifiable {
  let id: String
  let name: String
  let openedAt: Double?
  /// The desk's own recent files, most recent first.
  let recent: [WidgetFile]

  var openedDate: Date? { openedAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

struct WidgetSnapshot: Codable {
  let version: Int
  /// Most recently used first.
  let desks: [WidgetDesk]
  /// Across every desk, newest first.
  let recentFiles: [WidgetFile]
}

enum HushWidgetStore {
  /// Must match HushWidgetsPlugin.snapshotFileName (iOS) and
  /// SNAPSHOT_FILE_NAME in src-tauri/src/widgets.rs (macOS).
  static let snapshotFileName = "widgets.json"

  /// The App Group the app writes into — `HushAppGroup` in this
  /// extension's Info.plist, filled in at build time (see
  /// widgets/README-WIDGETS.md), so the identifier is written in one
  /// place per platform.
  static var appGroup: String? {
    let value = Bundle.main.object(forInfoDictionaryKey: "HushAppGroup") as? String
    guard let value, !value.isEmpty, !value.hasPrefix("$(") else { return nil }
    return value
  }

  /// The latest snapshot, or nil before the app has published one (or
  /// when the App Group isn't set up).
  static func load() -> WidgetSnapshot? {
    guard
      let group = appGroup,
      let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
      let data = try? Data(contentsOf: dir.appendingPathComponent(snapshotFileName))
    else { return nil }
    return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
  }
}

/// `hushwriter://widget?action=…` — the only thing a tap ever sends.
enum HushLink {
  private static func make(_ action: String, _ params: [(String, String)]) -> URL {
    var c = URLComponents()
    c.scheme = "hushwriter"
    c.host = "widget"
    c.queryItems = [URLQueryItem(name: "action", value: action)]
      + params.map { URLQueryItem(name: $0.0, value: $0.1) }
    // Every component is a fixed string or an id the app minted; a nil
    // here would be a programming error, and the app home is a safe
    // landing for it.
    return c.url ?? URL(string: "hushwriter://widget")!
  }

  static func openDesk(_ deskId: String) -> URL {
    make("open-desk", [("desk", deskId)])
  }

  static func openFile(_ file: WidgetFile) -> URL {
    make("open-file", [("desk", file.deskId), ("file", file.id), ("type", file.type)])
  }

  static func newDoc(_ deskId: String) -> URL {
    make("new-doc", [("desk", deskId)])
  }

  static func newNotebook(_ deskId: String) -> URL {
    make("new-notebook", [("desk", deskId)])
  }
}

/// SF Symbols standing in for the sidebar's glyphs: lines for a
/// document, the dot grid for a notebook, three columns for a stack.
enum HushGlyph {
  static func symbol(for type: String) -> String {
    switch type {
    case "notebook": return "circle.grid.3x3"
    case "stack": return "rectangle.split.3x1"
    case "pdf": return "doc.richtext"
    case "project": return "folder"
    default: return "doc.text"
    }
  }

  static let desk = "table.furniture"
  static let newDoc = "doc.text"
  static let newNotebook = "circle.grid.3x3"
}

/// Sample content for the widget gallery and for redacted placeholders.
enum HushSample {
  static let files: [WidgetFile] = [
    WidgetFile(id: "s1", name: "Chapter Three", type: "document", deskId: "d1", deskName: "Novel", openedAt: nil),
    WidgetFile(id: "s2", name: "Plot map", type: "notebook", deskId: "d1", deskName: "Novel", openedAt: nil),
    WidgetFile(id: "s3", name: "Reading notes", type: "document", deskId: "d2", deskName: "Research", openedAt: nil),
    WidgetFile(id: "s4", name: "Draft review", type: "stack", deskId: "d2", deskName: "Research", openedAt: nil),
    WidgetFile(id: "s5", name: "Letters", type: "project", deskId: "d3", deskName: "Personal", openedAt: nil),
    WidgetFile(id: "s6", name: "Morning pages", type: "document", deskId: "d3", deskName: "Personal", openedAt: nil),
  ]

  static let desks: [WidgetDesk] = [
    WidgetDesk(id: "d1", name: "Novel", openedAt: nil, recent: Array(files[0...1])),
    WidgetDesk(id: "d2", name: "Research", openedAt: nil, recent: Array(files[2...3])),
    WidgetDesk(id: "d3", name: "Personal", openedAt: nil, recent: Array(files[4...5])),
  ]

  static let snapshot = WidgetSnapshot(version: 1, desks: desks, recentFiles: files)
}
