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
    Timeline(entries: [makeEntry(for: configuration)], policy: .after(Date().addingTimeInterval(30 * 60)))
  }

  private func makeEntry(for configuration: SelectDeskIntent) -> DeskFilesEntry {
    guard let snapshot = HushWidgetStore.load() else {
      return DeskFilesEntry(date: Date(), desk: nil, hasSnapshot: false)
    }
    let desk: WidgetDesk?
    if let chosen = configuration.desk {
      desk = snapshot.desks.first { $0.id == chosen.id }
    } else {
      desk = snapshot.desks.first
    }
    return DeskFilesEntry(date: Date(), desk: desk, hasSnapshot: true)
  }
}

// MARK: - View

struct DeskFilesView: View {
  @Environment(\.widgetFamily) private var family
  let entry: DeskFilesEntry

  var body: some View {
    VStack(alignment: .leading, spacing: family == .systemLarge ? 9 : 7) {
      if let desk = entry.desk {
        header(desk)
        let limit = rowLimit(family, small: 2, medium: 2, large: 8)
        if desk.recent.isEmpty {
          EmptyNote(text: "Nothing opened on this desk yet.")
        } else {
          ForEach(desk.recent.prefix(limit)) { file in
            FileLink(file: file, showsDetail: family != .systemSmall)
          }
        }
        Spacer(minLength: 0)
      } else {
        WidgetTitle(text: "Desk", symbol: HushGlyph.desk)
        EmptyNote(text: entry.hasSnapshot
          ? "That desk isn't on this device any more. Edit the widget to choose another."
          : "Open Hush to see your desks here.")
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .widgetURL(entry.desk.map { HushLink.openDesk($0.id) })
    .hushWidgetBackground()
  }

  /// The desk's name (which opens it) and the two create buttons.
  private func header(_ desk: WidgetDesk) -> some View {
    HStack(alignment: .center, spacing: 6) {
      Link(destination: HushLink.openDesk(desk.id)) {
        Text(desk.name)
          .font(.headline)
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      ActionButton(symbol: HushGlyph.newDoc, label: "New Doc", url: HushLink.newDoc(desk.id))
      ActionButton(
        symbol: HushGlyph.newNotebook, label: "New Notebook",
        url: HushLink.newNotebook(desk.id), badge: true)
    }
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
