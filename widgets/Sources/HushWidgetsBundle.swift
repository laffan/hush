import SwiftUI
import WidgetKit

// Entry point of the widget extension (iOS and macOS). See
// widgets/README-WIDGETS.md for how it is built and what it reads.

@main
struct HushWidgetsBundle: WidgetBundle {
  var body: some Widget {
    RecentDesksWidget()
    RecentFilesWidget()
    DeskFilesWidget()
  }
}
