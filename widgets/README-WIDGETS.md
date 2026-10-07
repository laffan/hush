# Home screen widgets — iOS / iPadOS and macOS

Extension of [README-TECHNICAL.md](../README-TECHNICAL.md). Three WidgetKit widgets, each in small, medium and large:

| Widget | Kind | Shows | Taps |
|---|---|---|---|
| **Recent Desks** | `HushRecentDesks` | Desks, most recently used first; wider sizes add each desk's last-open file and how long ago | A desk → switch to it |
| **Recent Files** | `HushRecentFiles` | Files opened lately across every desk, newest first, with their desk | A file → its desk, then the file |
| **Desk** | `HushDeskFiles` | One desk's recent files under its name, with **New Doc**, **New Notebook** and **New Sticky** buttons | The name → the desk; a file → the file; the buttons → a new doc / notebook in that desk's Inbox, or a new desk sticky, focused for typing |

Every list shows as many rows as its space holds and runs to the bottom of the widget: `FittedList` fits as many rows of `minRowHeight` (26 pt) as the space under the header takes, then — when there are more entries than that — shares the leftover height out between them, so no gap of up to a row is left below the last one. A list shorter than the space keeps its rows at 26 pt from the top. Every size uses the same type (footnote names, caption details) and the same rows: a large widget is a taller list, not a bigger one. On an iPhone that is about four rows in a small or medium widget (the two are the same height) and ten in a large one; the Desk widget gives up a row or two to its buttons, which take a strip of their own under the name in the small size. The snapshot carries twelve files a desk and twelve across desks. The Desk widget's desk is the widget's own setting (edit the widget); unset, it follows the most recently used desk. The widgets need iOS 17 / macOS 14 (App Intents configuration, `containerBackground`). The app keeps its own floor: on an older system it installs and runs as before, and the widgets simply aren't offered.

## How the data gets there

The extension never reads a desk folder — it couldn't (a local desk is a security-scoped folder the extension has no bookmark for), and it shouldn't (that is the code README-SYNC.md exists to protect). It draws one JSON **snapshot** the app publishes into an **App Group** container both of them can read:

```
app (JS)                                 Rust                         native
src/widgets/widget-snapshot.js   ──►  publish_widget_snapshot  ──►  iOS:   tauri-plugin-hush-widgets (Swift)
  built from the tree + recents         (src-tauri/src/widgets.rs)   macOS: widget-bridge-macos (Swift, via swift-rs)
                                                                       └─ write <group>/widgets.json, WidgetCenter.reloadAllTimelines()
widgets/Sources (the extension) ◄──── reads <group>/widgets.json
```

- **Recency.** The per-desk MRU (`settings.recentFileIdsByDesk`) is an order without times, which is all the sidebar's desk-scoped list needs. "Recent desks" and "recent files across desks" need *when*, so `src/widgets/widget-activity.js` stamps `settings.recentActivity` — `{ desks: { id: ms }, files: { id: ms } }`, per device, capped at 200 a map — from `recordActiveDeskLastFile` (every open) and from desk switches. It is written in one key-scoped patch 1.5 s after the stamp, so an open costs no extra IPC on its own path. Files in the MRU from before stamping sort after the stamped ones, in MRU order.
- **The snapshot** (`buildWidgetSnapshot`, pure) — `{ version, desks: [{ id, name, openedAt, recent: [file…] }], recentFiles: [file…] }`, a file being `{ id, name, type, deskId, deskName, openedAt }`. Trash and project PDF aliases are left out. It carries no "generated at", so two windows describing the same state produce the same bytes.
- **Publishing** (`widget-publish.js`), debounced 1.2 s, on activity stamps, tree and desk-list changes, desk switches and sibling-window settings merges. Every window publishes; three layers skip a repeat (the window's last JSON, Rust's last string, the Swift side's compare against the file), because WidgetKit rations reloads.
- **Swift side.** `WidgetCenter.shared.reloadAllTimelines()` after each write. Timelines also refresh every 30 minutes, only so the "… ago" labels stay roughly right.

## Taps

Every tap target is a `hushwriter://widget?action=…` link (`HushLink` in `widgets/Sources/HushWidgetsData.swift`; `open-desk`, `open-file`, `new-doc`, `new-notebook`, `new-sticky`, each with `desk=`). They go through the deep-link router like any `hushwriter://` request — main window only — into `src/widgets/widget-links.js`, which waits for the desk to load (a local desk's folder can appear seconds after a cold launch, which is exactly when a tap arrives), switches to it, **waits for the switch's own last-file restore** (`desk-overview-restore`, or it would supersede whatever the tap opens), then opens or creates. New Notebook asks for a name, as every New Notebook in the app does; New Sticky makes an empty desk sticky with the caret in it (`addSticky(state, "desk")`).

**A widget link can't carry a nonce** — it is the same URL every time that button is tapped — and iPadOS delivers a link more than once (to every window, and again from a replayed `getCurrent()` after a webview reload). Opening a file twice is harmless; making two documents is not. `claim_widget_link` (Rust, so its memory is the app process) refuses the same link within 4 s, and refuses a *cold* delivery (`getCurrent()`, the kind a reload replays) of a link that has already acted in this process. A launch the tap itself caused is a fresh process, so its link acts; the same button tapped again later is a warm delivery and acts too. That last case is what a nonce-less "seen before" rule would get wrong.

## Building

Widgets are **opt-in per build**: they add an App Group to the app's signature, and a build that can't provision it can't install. Every other build is unaffected — the plugin and the publisher ship in all of them and do nothing without a container.

### iOS / iPadOS

```sh
npm run ios:init && npm run ios:add-widgets
npm run build:ios
```

`scripts/ios-add-widgets.mjs` adds a `HushWidgets` app-extension target to `src-tauri/gen/apple/project.yml` (built from `widgets/Sources`, embedded in the app, iOS 17), gives it and the app the App Group `group.com.hushwriter.app` (`IOS_APP_GROUP` in `widgets.rs` — change both together), regenerates the project with XcodeGen and re-runs `pod install`. `gen/apple` is regenerated by `ios:init`, so run the two together. In Xcode, check that the App Group capability is enabled for your team on both targets the first time.

**Both App Groups go into the spec as `properties`, never into the `.entitlements` files.** XcodeGen *writes* every target's entitlements file from its `properties` on each `xcodegen generate`, and Tauri's template gives the app target a path and no properties — so an App Group added to `hush_iOS.entitlements` by hand is erased by the next generate. The first version of the script did exactly that: the extension kept its group (its properties were in the spec), the app lost its own, `containerURL` came back nil, nothing was ever written, and every widget sat on "Open Hush to see your desks here." The script now carries whatever the app's entitlements file holds (read with `plutil`) into an inline `properties:` line, App Group added, and re-running it over an older run's output repairs it.

### macOS

```sh
HUSH_TEAM_ID=ABCDE12345 \
HUSH_SIGN_IDENTITY="Developer ID Application: Your Name (ABCDE12345)" \
npm run build:macos:widgets
```

The desktop app has no Xcode project, so `scripts/macos-build-widgets.sh` builds the extension on its own (`widgets/macos/project.yml`, XcodeGen + xcodebuild, sandboxed), then runs `tauri build` with a config overlay that signs the app with the same App Group and copies the extension into `Contents/PlugIns`, and with the `macos-widgets` cargo feature, which links `src-tauri/widget-bridge-macos` (swift-rs) and bakes in the group as `HUSH_MACOS_APP_GROUP`. On macOS the group **must** be `<team ID>.<bundle id>`: since macOS 15 a group container is reachable only through `FileManager` and only for a group the signature names, and a `group.` identifier is accepted only with a provisioning profile; an extension asking for anything else is denied without a prompt.

Tauri's bundler copies a directory named in `bundle.macOS.files` as a folder and leaves it out of its own signing list — it signs frameworks and binaries, then the app last — so the extension keeps the signature and entitlements xcodebuild gave it, and the app's signature seals it. The script ends by checking exactly that. Should a future Tauri re-sign nested code, re-sign the extension (`codesign --force --options runtime --entitlements widgets/macos/build/HushWidgets.entitlements --sign "$HUSH_SIGN_IDENTITY" …/PlugIns/HushWidgets.appex`) and then the app.

## When a widget stays empty

"Open Hush to see your desks here" means the extension found no snapshot. Look in **Settings → Debug → Activity Log**, filtered to `widgets`: the app logs the first successful hand-off of each session ("Widget snapshot published", with how many desks and files it carried) and any failure ("Widget snapshot not published" — a missing App Group container is reported by name). Then check the signed app itself carries the group:

```sh
codesign -d --entitlements - path/to/Hush.app                          # the app
codesign -d --entitlements - path/to/Hush.app/PlugIns/HushWidgets.appex # the extension
```

Both must list the same `com.apple.security.application-groups` entry.

## Not verified here

This was written without a Mac. The JavaScript and the Rust compile and their logic is tested (`cargo test widgets`); the Swift — the extension, the iOS plugin, the macOS bridge — and both build scripts have not been compiled or run. Expect to fix small things on the first build: an SDK signature, an XcodeGen key, a signing setting.
