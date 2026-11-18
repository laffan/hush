import AppIntents
import SwiftUI
import WidgetKit

// Desk Files: one desk's recent files, with New Doc and New Notebook at
// the top. Which desk is the widget's own setting (edit the widget to
// pick one); left unset it follows the most recently used desk.

// MARK: - Choosing the desk

struct DeskEntity: AppEntity {
  let id: String
  let name: String

  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Desk"
  static let defaultQuery = DeskQuery()

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)")
  }
}

struct DeskQuery: EntityQuery {
  private func all() -> [DeskEntity] {
    (HushWidgetStore.load()?.desks ?? []).map { DeskEntity(id: $0.id, name: $0.name) }
  }

  func entities(for identifiers: [DeskEntity.ID]) async throws -> [DeskEntity] {
    all().filter { identifiers.contains($0.id) }
  }

  func suggestedEntities() async throws -> [DeskEntity] {
    all()
  }

  func defaultResult() async -> DeskEntity? {
    all().first
  }
}

struct SelectDeskIntent: WidgetConfigurationIntent {
  static let title: LocalizedStringResource = "Choose Desk"
  static let description = IntentDescription("The desk whose recent files the widget shows.")

  @Parameter(title: "Desk")
  var desk: DeskEntity?
}

// MARK: - Timeline

struct DeskFilesEntry: TimelineEntry {
  let date: Date
  /// nil when the app hasn't published yet, or the chosen desk is gone.
  let desk: WidgetDesk?
  let hasSnapshot: Bool
  /// Drawn in Night Vision (the app was in it, and it hasn't ended by
  /// this entry's moment).
  var nightVision = false
}

struct DeskFilesProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> DeskFilesEntry {
    DeskFilesEntry(date: Date(), desk: HushSample.desks.first, hasSnapshot: true)
  }

  func snapshot(for configuration: SelectDeskIntent, in context: Context) async -> DeskFilesEntry {
    let entry = makeEntry(for: configuration)
    if entry.desk == nil && context.isPreview {
      return placeholder(in: context)
    }
    return entry
  }

  func timeline(for configuration: SelectDeskIntent, in context: Context) async -> Timeline<DeskFilesEntry> {
    let now = Date()
    let snapshot = HushWidgetStore.load()
    // A second entry at Night Vision's end, so the widget turns back at
    // 8am on its own.
    let entries = (snapshot?.entryDates(from: now) ?? [now]).map { makeEntry(for: configuration, at: $0, snapshot: snapshot) }
    return Timeline(entries: entries, policy: .after(now.addingTimeInterval(30 * 60)))
  }

  private func makeEntry(for configuration: SelectDeskIntent) -> DeskFilesEntry {
    makeEntry(for: configuration, at: Date(), snapshot: HushWidgetStore.load())
  }

  private func makeEntry(for configuration: SelectDeskIntent, at date: Date, snapshot: WidgetSnapshot?) -> DeskFilesEntry {
    guard let snapshot else {
      return DeskFilesEntry(date: date, desk: nil, hasSnapshot: false)
    }
    let desk: WidgetDesk?
    if let chosen = configuration.desk {
      desk = snapshot.desks.first { $0.id == chosen.id }
    } else {
      desk = snapshot.desks.first
    }
    return DeskFilesEntry(date: date, desk: desk, hasSnapshot: true, nightVision: snapshot.nightVision(at: date))
  }
}

// MARK: - View

struct DeskFilesView: View {
  @Environment(\.widgetFamily) private var family
  let entry: DeskFilesEntry

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let desk = entry.desk {
        header(desk)
        if desk.recent.isEmpty {
          EmptyNote(text: "Nothing opened on this desk yet.")
        } else {
          FittedList(items: desk.recent) { file in
            FileLink(file: file, showsDetail: family != .systemSmall)
          }
        }
      } else {
        WidgetTitle(text: "Desk", symbol: HushGlyph.desk)
        EmptyNote(text: entry.hasSnapshot
          ? "That desk isn't on this device any more. Edit the widget to choose another."
          : "Open Hush to see your desks here.")
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .widgetURL(entry.desk.map { HushLink.openDesk($0.id) })
    .nightVision(entry.nightVision)
    .hushWidgetBackground(nightVision: entry.nightVision)
  }

  /// The desk's name (which opens it) and the two create buttons — New
  /// Doc and New Notebook. Side by side where there's room; on a small
  /// widget, a strip of their own under the name, which the buttons and
  /// a name can't share at that width.
  @ViewBuilder
  private func header(_ desk: WidgetDesk) -> some View {
    if family == .systemSmall {
      VStack(alignment: .leading, spacing: 6) {
        deskName(desk)
        HStack(spacing: 6) { buttons(desk, width: nil, height: 26) }
      }
    } else {
      HStack(alignment: .center, spacing: 6) {
        deskName(desk)
        buttons(desk, width: 28, height: 26)
      }
    }
  }

  /// The same weight and size in every widget size.
  private func deskName(_ desk: WidgetDesk) -> some View {
    Link(destination: HushLink.openDesk(desk.id)) {
      Text(desk.name)
        .font(.subheadline.weight(.semibold))
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  @ViewBuilder
  private func buttons(_ desk: WidgetDesk, width: CGFloat?, height: CGFloat) -> some View {
    ActionButton(
      symbol: HushGlyph.newDoc, label: "New Doc",
      url: HushLink.newDoc(desk.id), width: width, height: height)
    ActionButton(
      symbol: HushGlyph.newNotebook, label: "New Notebook",
      url: HushLink.newNotebook(desk.id), width: width, height: height)
  }
}

struct DeskFilesWidget: Widget {
  let kind = "HushDeskFiles"

  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: kind, intent: SelectDeskIntent.self, provider: DeskFilesProvider()) { entry in
      DeskFilesView(entry: entry)
    }
    .configurationDisplayName("Desk")
    .description("One desk's recent files, with New Doc and New Notebook.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}
