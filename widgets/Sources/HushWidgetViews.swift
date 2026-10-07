import SwiftUI
import WidgetKit

// Building blocks the three widgets share. Hush's own look: monochrome,
// the system face, one line per entry, nothing louder than the names.

/// Row count per size. A small widget has room for its header and a
/// couple of names; a large one for a column of them.
func rowLimit(_ family: WidgetFamily, small: Int, medium: Int, large: Int) -> Int {
  switch family {
  case .systemSmall: return small
  case .systemMedium: return medium
  default: return large
  }
}

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
        .font(.subheadline)
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

/// The square icon button in the desk widget's header.
struct ActionButton: View {
  let symbol: String
  let label: String
  let url: URL
  /// The notebook glyph has no "plus" variant, so it wears a badge.
  var badge = false

  var body: some View {
    Link(destination: url) {
      ZStack(alignment: .bottomTrailing) {
        Image(systemName: symbol)
          .font(.system(size: 14, weight: .regular))
          .frame(width: 28, height: 28)
        if badge {
          Image(systemName: "plus.circle.fill")
            .font(.system(size: 9, weight: .bold))
            .offset(x: -3, y: -3)
        }
      }
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
