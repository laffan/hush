import SwiftUI
import WidgetKit

// Building blocks the three widgets share. Hush's own look: monochrome,
// the system face, one line per entry, nothing louder than the names.

/// The shortest a row may be. Every size uses it, with the same type —
/// a large widget is a taller list, not a bigger one. `FittedList` fits
/// as many rows of this height as the space holds, then spreads the
/// entries it shows over the whole height, so the list always runs to
/// the bottom.
let minRowHeight: CGFloat = 26

/// "5 min. ago", "yesterday" — measured from when the entry is drawn.
/// Not the live-ticking `Text(_:style: .relative)`, which reads
/// "2 hr, 5 min" and keeps counting seconds in a trailing column too
/// narrow for it; the timelines redraw every half hour instead.
func shortRelative(_ date: Date, now: Date = Date()) -> String {
  if now.timeIntervalSince(date) < 60 { return "now" }
  let f = RelativeDateTimeFormatter()
  f.unitsStyle = .abbreviated
  f.dateTimeStyle = .named
  return f.localizedString(for: date, relativeTo: now)
}

/// Section label at the top of a widget.
struct WidgetTitle: View {
  let text: String
  var symbol: String? = nil

  var body: some View {
    HStack(spacing: 4) {
      if let symbol {
        Image(systemName: symbol).font(.caption2.weight(.semibold))
      }
      Text(text.uppercased())
        .font(.caption2.weight(.semibold))
        .tracking(0.6)
        .lineLimit(1)
    }
    .foregroundStyle(.secondary)
  }
}

/// As many rows as fit the space left under the widget's header — no
/// half rows — with a faint rule between them. Whatever entries are
/// shown share the whole height evenly, so the list always runs to the
/// bottom edge: more entries than fit, and the leftover is spread over
/// the ones that do; fewer, and each gets more padding rather than the
/// list stopping short.
struct FittedList<Item: Identifiable, Row: View>: View {
  let items: [Item]
  @ViewBuilder let row: (Item) -> Row

  var body: some View {
    GeometryReader { geo in
      let height = geo.size.height
      let fits = max(1, Int((height + 1) / minRowHeight))
      let shown = Array(items.prefix(fits).enumerated())
      let rowHeight = height / CGFloat(max(1, shown.count))
      VStack(spacing: 0) {
        ForEach(shown, id: \.element.id) { index, item in
          row(item)
            .frame(height: rowHeight)
            .overlay(alignment: .top) {
              if index > 0 { RowDivider() }
            }
        }
      }
      .frame(maxWidth: .infinity, alignment: .topLeading)
    }
  }
}

/// The hairline between two rows.
struct RowDivider: View {
  var body: some View {
    Rectangle()
      .fill(Color.primary.opacity(0.1))
      .frame(height: 0.5)
  }
}

/// One entry: glyph, name, and (when there is room) a trailing detail.
struct EntryRow: View {
  let symbol: String
  let title: String
  var detail: String? = nil
  var date: Date? = nil
  var showsDetail = true

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: symbol)
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(width: 14)
      Text(title)
        .font(.footnote)
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer(minLength: 4)
      if showsDetail {
        if let detail {
          Text(detail)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        } else if let date {
          Text(shortRelative(date))
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
    }
    .frame(maxHeight: .infinity)
    .contentShape(Rectangle())
  }
}

/// A file row that opens the file.
struct FileLink: View {
  let file: WidgetFile
  var detail: String? = nil
  var showsDetail = true

  var body: some View {
    Link(destination: HushLink.openFile(file)) {
      EntryRow(
        symbol: HushGlyph.symbol(for: file.type), title: file.name,
        detail: detail, date: file.openedDate, showsDetail: showsDetail)
    }
  }
}

/// An icon button in the desk widget's header — the glyph alone; where
/// it sits says it makes something. Square by default; `width: nil`
/// shares out a row (the small widget's button strip).
struct ActionButton: View {
  let symbol: String
  let label: String
  let url: URL
  var width: CGFloat? = 28
  var height: CGFloat = 28

  var body: some View {
    Link(destination: url) {
      Image(systemName: symbol)
        .font(.system(size: 14, weight: .regular))
        .frame(minWidth: width ?? 0, maxWidth: width ?? .infinity, minHeight: height, maxHeight: height)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .accessibilityLabel(label)
    }
  }
}

/// What a widget says before the app has published anything.
struct EmptyNote: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.caption)
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

extension View {
  /// The system's own widget background, in whichever appearance the
  /// home screen or desktop is in.
  func hushWidgetBackground() -> some View {
    containerBackground(.background, for: .widget)
  }
}
