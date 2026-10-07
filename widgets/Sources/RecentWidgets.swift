import SwiftUI
import WidgetKit

// The two widgets with nothing to configure: Recent Desks and Recent
// Files (across desks). Both draw the latest snapshot and redraw when
// the app publishes a new one (WidgetCenter reload) — the half-hourly
// refresh only keeps the "… ago" labels honest.

struct SnapshotEntry: TimelineEntry {
  let date: Date
  /// nil until the app has published a snapshot.
  let snapshot: WidgetSnapshot?
}

struct SnapshotProvider: TimelineProvider {
  func placeholder(in context: Context) -> SnapshotEntry {
    SnapshotEntry(date: Date(), snapshot: HushSample.snapshot)
  }

  func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
    // The widget gallery shows sample content until there is real data.
    let real = HushWidgetStore.load()
    completion(SnapshotEntry(date: Date(), snapshot: real ?? (context.isPreview ? HushSample.snapshot : nil)))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
    let entry = SnapshotEntry(date: Date(), snapshot: HushWidgetStore.load())
    completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(30 * 60))))
  }
}

// MARK: - Recent Desks

struct RecentDesksView: View {
  @Environment(\.widgetFamily) private var family
  let entry: SnapshotEntry

  var body: some View {
    let desks = entry.snapshot?.desks ?? []
    VStack(alignment: .leading, spacing: 6) {
      WidgetTitle(text: "Desks", symbol: HushGlyph.desk)
      if desks.isEmpty {
        EmptyNote(text: "Open Hush to see your desks here.")
      } else {
        FittedList(items: desks) { desk in
          Link(destination: HushLink.openDesk(desk.id)) {
            if family == .systemSmall {
              EntryRow(symbol: HushGlyph.desk, title: desk.name, showsDetail: false)
            } else {
              // Wider sizes say what was last open there.
              EntryRow(
                symbol: HushGlyph.desk, title: desk.name,
                detail: desk.recent.first?.name,
                date: desk.openedDate)
            }
          }
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .widgetURL(desks.first.map { HushLink.openDesk($0.id) })
    .hushWidgetBackground()
  }
}

struct RecentDesksWidget: Widget {
  let kind = "HushRecentDesks"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: SnapshotProvider()) { entry in
      RecentDesksView(entry: entry)
    }
    .configurationDisplayName("Recent Desks")
    .description("The desks you've been working in. Tap one to go to it.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}

// MARK: - Recent Files

struct RecentFilesView: View {
  @Environment(\.widgetFamily) private var family
  let entry: SnapshotEntry

  var body: some View {
    let files = entry.snapshot?.recentFiles ?? []
    VStack(alignment: .leading, spacing: 6) {
      WidgetTitle(text: "Recent", symbol: "clock")
      if files.isEmpty {
        EmptyNote(text: "Files you open in Hush appear here.")
      } else {
        FittedList(items: files) { file in
          // Across desks, the desk is the useful detail; a small widget
          // has room for the name only.
          FileLink(
            file: file, detail: file.deskName,
            showsDetail: family != .systemSmall)
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .widgetURL(files.first.map { HushLink.openFile($0) })
    .hushWidgetBackground()
  }
}

struct RecentFilesWidget: Widget {
  let kind = "HushRecentFiles"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: SnapshotProvider()) { entry in
      RecentFilesView(entry: entry)
    }
    .configurationDisplayName("Recent Files")
    .description("What you've opened lately, across all your desks.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}
