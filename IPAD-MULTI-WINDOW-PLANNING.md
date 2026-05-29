# Hush — iPad Multi-Window (single-file) Planning

> **Status**: Stages 1 & 2 working on-device — the satellite runs the real
> `dist` and the invoke relay carries every command (the seeded file loads,
> renders, and edits/saves). Next: Stage 3 (single-file boot mode) to stop
> booting the full app, then Stage 4 (event routing for live sync).
> **Last Updated**: 2026-05-29

## Implementation Status

**Scope correction (important):** the second window must work for **all
file types — doc, notebook, and stack** — not just docs. Notebooks (canvas)
and stacks (multi-column, lazily-mounted editors/canvases/PDF viewers) are
drawn by the Hush web app's own renderers and call `invoke()` constantly at
runtime, so there is **no shortcut of passing serialized content** to the
new window. The second window must run the real `dist` bundle with a
working `invoke()` → the **satellite relay is mandatory**, not optional.

- **Stage 1 — scene + seed path: working.** Confirmed on hardware via the
  Web Inspector trace and a rendered window. wry builds the iOS app in Rust
  with the **legacy (non-scene) UIWindow lifecycle** (no Swift in
  `gen/apple`, no Tauri scene manifest), so UIKit fixes the lifecycle at
  `UIApplicationMain` and never calls `configurationForConnecting` — the
  original config-router swizzle could never fire. Final mechanism:
  - `open_single_file_window` (carrying `fileId` / `fileType` / `title`)
    fires `requestSceneSessionActivation`.
  - A NotificationCenter observer on `UIScene.willConnectNotification`
    catches the new scene and attaches our own `UIWindow` + content. The
    legacy primary window is not a scene, so it never trips the observer.
  - `expectingNewScene` gates ours vs. iOS-restored zombie sessions;
    unrequested scenes are destroyed so activation can't reuse a stale one.
  - Two bugs fixed along the way: the `EmptyResponse` deserialize (null →
    `serde_json::Value`) that made the command report failure, and `diag()`
    needing to dispatch `trigger()` to the main thread (so `openWindow`'s
    breadcrumbs actually reach the JS console).
  - Diagnostics mirror to the main window's JS console via
    `trigger("diag", …)` → an `addPluginListener` in `multi-window.js`,
    readable in Safari Web Inspector (`tauri ios dev` fails code 70 here;
    `build:ios` works).
  - The window currently shows an **all-type-safe placeholder** (title +
    type + id). This is the platform we build the satellite on.
- **Stage 2 — satellite webview + invoke relay: working on-device.** The
  scene now hosts a real WKWebView that boots the full `dist` and proxies
  every `invoke` through the primary. Hard-won mechanics:
  - **wry's `tauri://` asset handler is webview-specific and crash-prone.**
    Reusing it for a second webview — whether via `WKWebViewConfiguration.copy()`
    (which *does* carry the handler: `carriedByCopy=true`) or by
    re-registering the instance on a fresh config — loads nothing and
    crashes the shared web-content process. Do **not** touch it.
  - **Assets are proxied, not shared.** The satellite gets a *fresh* config
    with its own `hushsat://` scheme + a `SatelliteSchemeHandler`. For each
    request it asks the **primary** to `fetch()` the same path from
    `tauri://localhost` and return base64 bytes + content-type via
    `callAsyncJavaScript`; we hand that back as the scheme-task response.
    Works regardless of where the bundle physically lives.
  - **Process isolation.** The fresh config takes its own `WKProcessPool`,
    so a satellite crash/teardown no longer freezes or kills the primary.
    (Swapping the pool on a *copied* config crashes WebKit — only safe on a
    fresh one.)
  - **Invoke relay.** Satellite `__TAURI_INTERNALS__.invoke` → native
    `hushInvoke` handler → primary's `__hushSatelliteRequest` (real IPC) →
    result back via `hushRelayResult` → satellite. JSON is base64-wrapped
    across the JS↔Swift boundary. One relay covers all commands/file types.
  - **Known gap (Stage 4):** `listen()` registers a callback that lives in
    the satellite but fires in the primary, so events never arrive
    (`Couldn't find callback id …` spam in the primary console). Request-
    response `invoke` is unaffected, so load/edit/save all work.
  - **Why Stage 3 is now urgent:** the satellite boots the *entire* app —
    sidebar, sync (`enqueue_sync_op`/`local_sync_list`), Zotero PDF
    downloads, stacks, `register_window`, autosave — i.e. a second full
    instance racing the primary on the same files/sync/settings. Single-
    file boot mode must trim this down.

## Goal

Add a command-palette entry **Open in New Window** on iPad that opens the
currently-active document or notebook in a *second iPad window* — a lone,
chrome-free editor for that one file. The new window deliberately has **no
files sidebar, no floating panes, no stacks, no file management**. Editing
the same file in both windows stays live-synced, exactly as it does
between two macOS windows today.

The macOS feature is described in `README-TECHNICAL.md` §"Multiple Windows"
and lives in `src/multi-window.js` + `src-tauri/src/multi_window.rs` +
`src-tauri/src/commands/multi_window.rs`. This document is the iPad
counterpart.

## Why iPad Can't Reuse the macOS Path

The macOS implementation works because **every window is a wry-managed
`WebviewWindow` in one shared Rust process.** `openInNewWindow()` calls
`new WebviewWindow(label, { url: "index.html#file=…&type=…" })`; wry creates
a real second `NSWindow` + `WKWebView`; cross-window state rides
`app.emit(...)` broadcasts that reach *every* webview in the process.

None of that transfers to iPadOS:

1. **iPad windows are `UIScene`s, not NSWindows.** A second window is a
   separate `UIWindowScene`, created via
   `UIApplication.shared.requestSceneSessionActivation(...)` — the same
   machinery behind Split View / Slide Over / Stage Manager.
2. **wry/Tauri owns exactly one webview on iOS, in one scene.** Tauri's IPC
   (the `WKScriptMessageHandler`, the custom-scheme asset loader, `invoke()`
   resolution, `app.emit` targeting, event listeners) is registered against
   that single webview inside Tauri's `WebviewManager`. There is no public
   API to create a second *Tauri-managed* webview/scene on iOS, and a
   webview Tauri doesn't manage receives neither `invoke` responses nor
   emitted events.
3. **`WebviewWindow.new` is a no-op on iOS.** `src/multi-window.js` already
   early-returns when `!IS_TAURI`; on iOS the call would simply fail.

So the Swift bridge can *open* a second scene (tractable), but making that
scene a working Hush editor requires us to wire its webview to the shared
Rust core ourselves.

## Why Single-File Scope Makes This Tractable

A full second editor would need most of the app's `invoke()` surface —
files tree, sync, Zotero, images, snapshots, panes, desks. A lone
single-file window needs only a handful of operations:

- Load one file by id (`load_file` for docs, the notebook envelope for
  notebooks).
- Save / autosave that one file.
- Read settings/style so the editor paints on-theme.
- Participate in the existing live-edit broadcasts so two windows on the
  same file stay in sync.

That small surface is hand-wireable, which is the whole reason this scope
is worth attempting.

## Recommended Architecture: the "Satellite" Model

Scene 2 is a **thin client of scene 1's already-working Tauri bridge.**
Scene 1 (the primary, Tauri-managed window) remains the single source of
truth for all Rust IPC; scene 2 proxies its few requests through Swift
into scene 1.

```
┌─ Scene 1 (primary, Tauri-managed) ──────────┐     ┌─ Scene 2 (satellite) ─────────┐
│  WKWebView (full Hush)                        │     │  plain WKWebView               │
│   └ invoke() → Tauri Rust core (AppState)     │     │   └ single-file mode UI        │
│        files / sync / zotero / disk …         │     │   └ no Tauri; IPC shim posts   │
│   ▲                                            │     │      to Swift handler          │
│   │ evaluateJavaScript(__hushSatelliteReq)     │     │   ▲                            │
└───┼────────────────────────────────────────────┘    └───┼────────────────────────────┘
    │                                                       │
    └──────────────  Swift bridge (new iOS plugin)  ────────┘
         holds refs to both WKWebViews; relays req/resp
         and fans cross-window broadcasts to the satellite
```

**Request path (scene 2 → Rust):**
1. Scene 2's web app, in single-file mode, replaces `invoke()` with a shim
   that `window.webkit.messageHandlers.<name>.postMessage({reqId, cmd, args})`.
2. The Swift bridge receives it and calls
   `evaluateJavaScript("window.__hushSatelliteRequest(<json>)")` on the
   **primary** webview.
3. Scene 1 runs the real `invoke(cmd, args)`, then posts the result back to
   Swift, which `evaluateJavaScript`s it into scene 2 keyed by `reqId`.

**Live-sync path (Rust broadcast → scene 2):** scene 1 already receives
`cross-window-doc-changed` / `cross-window-notebook-changed` (today these
fan between macOS windows). The primary window's listener, when it sees a
broadcast for the file scene 2 has open, relays it to Swift, which forwards
to scene 2. Scene 2 likewise broadcasts its own edits back through the
request path so scene 1 (and any future windows) apply them. We reuse the
existing `acquirePullLock` / `releasePullLock` plumbing so the round-trip
can't loop.

**Why this over a Swift→Rust FFI?** A direct FFI (expose a few
`extern "C"` load/save functions over a process-global file store) would
make scene 2 independent of scene 1's lifecycle — but it duplicates file
logic, bypasses the `AppState` plumbing (sync queue, version snapshots,
rename rewrites), and still needs a bespoke Rust→Swift→scene-2 event
channel for live sync. The satellite model reuses the *entire* existing,
tested Rust path and the existing broadcast machinery. Its one cost —
scene 2 dies if scene 1 closes — is acceptable for v1 (and matches the
"primary is the app" mental model). Revisit FFI only if independent
scene lifecycle becomes a hard requirement.

## Components To Build

### 1. New Tauri iOS plugin `tauri-plugin-ipad-window`

Mirrors `tauri-plugin-pencil` exactly (same `build.rs` / `Package.swift` /
`Cargo.toml` / `permissions/default.toml` shape; registered in `lib.rs`
alongside `tauri_plugin_pencil::init()`).

- **Rust** (`src/lib.rs`):
  - command `open_single_file_window(file_id, file_type)` →
    `run_mobile_plugin("openWindow", …)` on iOS; no-op elsewhere.
  - command `close_single_file_window(scene_id)` (optional v1).
  - holds the `PluginHandle` on managed state like `Pencil<R>`.
- **Swift** (`ios/Sources/IpadWindowPlugin.swift`):
  - capture the **primary** `WKWebView` in `load(webview:)` (as the pencil
    plugin does) so the relay has a target.
  - `openWindow(_ invoke:)`: build an `NSUserActivity`
    (`activityType = "com.hushwriter.app.fileWindow"`) whose `userInfo`
    carries `{fileId, fileType}`, then
    `UIApplication.shared.requestSceneSessionActivation(_:userActivity:options:errorHandler:)`.
    This is the iPad analog of the macOS URL hash.
  - implement a `WKScriptMessageHandler` (e.g. message name
    `hushSatellite`) that relays scene-2 requests to the primary webview
    and results back (see request path above).
  - a `SceneDelegate` (`scene(_:willConnectTo:options:)`): read the
    `NSUserActivity`, build a plain `WKWebView` loading the bundled
    `index.html` with single-file mode signalled (see §3), install the
    satellite message handler, and present it as the scene's root.
  - `windowScene(_:didUpdate:)` / scene disconnect: tell Rust to drop the
    scene from the registry (relayed via the primary webview's existing
    `unregister_window` path, or a dedicated event).

### 2. Info.plist / scene manifest (generated project)

`gen/apple` is generated by `npm run ios:init` and is **not checked in**, so
this needs a repeatable injection step (a script run after `ios:init`, or a
Tauri iOS template hook — to be decided during implementation):

- `UIApplicationSceneManifest` →
  `UIApplicationSupportsMultipleScenes = true`.
- A scene configuration pointing at our `SceneDelegate` for the
  file-window activity type.
- `NSUserActivityTypes` listing `com.hushwriter.app.fileWindow`.

> **Open question for implementation:** confirm whether Tauri's generated
> iOS app uses a `UISceneDelegate` we can extend, or an
> `application(_:didFinishLaunchingWithOptions:)`-only setup we must adapt.
> This is the highest-uncertainty item and should be validated on-device
> first, before any JS work.

### 3. Web app "single-file mode"

A new boot path in the existing dist (no second bundle). Signalled by the
satellite webview via a query param / hash (e.g. `index.html#satellite=1&file=…&type=…`)
injected by the `SceneDelegate`, parsed by the same machinery as
`getInitialFileFromHash()` in `src/multi-window.js`.

When `satellite` is set, `main.js` boots a trimmed shell:
- Mount only the editor surface for the seeded file. **Skip** sidebar
  (`files-panel`), pane manager, stacks, desk switcher, recent files.
- The command palette is reduced to file-local actions (modes, styles,
  export, find-in-doc); entries that need the sidebar/tree are filtered
  out — reuse the existing `ctx` gating in `command-palette-commands.js`.
- Replace the Tauri `invoke()` import with the satellite shim for the ~4
  commands this mode uses; everything else is unreachable by construction.
- Reuse the existing `applyRemoteDocChange` / `applyRemoteNotebookChange`
  receivers and the `doc-content-changed` broadcaster from
  `multi-window.js`, pointed at the satellite transport instead of Tauri
  events.

### 4. Registry + command-palette wiring (shared with macOS)

- `src/multi-window.js`: add `openSingleFileWindow(fileId, fileType)` that,
  on iOS, `invoke("plugin:ipad-window|open_single_file_window", …)`. The
  existing `openInNewWindow` stays the desktop path.
- `command-palette-commands.js`: today the entry is `ctx: "desktop"`. Add an
  iOS-visible variant (or widen the predicate) that dispatches to the iPad
  path. Keep it gated to "a single doc/notebook is active" (no project, no
  multi-select).
- `multi_window.rs` `WindowRegistry`: extend to track iPad scenes keyed by
  scene id so the existing per-window numeral badge story *can* extend
  later — though with the sidebar hidden in satellite mode, badges only
  show in the primary window for v1.

## Staging (each stage independently verifiable on-device)

1. **Scene + seed path.** ✅ *Working on-device.* Plugin crate, scene
   manifest, the `willConnect` observer that attaches our `UIWindow` to a
   requested scene, zombie-session cleanup, seed (`fileId`/`fileType`/
   `title`) and the JS↔Swift diag channel. The window shows an all-type
   placeholder. (Mechanism details in Implementation Status above.)
2. **Satellite webview loads the real `dist`.** Replace the placeholder VC
   with a WKWebView that loads the bundled `index.html` in single-file mode
   (a `WKURLSchemeHandler` or `loadFileURL` pointed at the app bundle), and
   stand up the **invoke relay**: the satellite's `invoke()` shim posts to a
   Swift `WKScriptMessageHandler`, which `evaluateJavaScript`s a request
   into the **primary** webview (`window.__hushSatelliteRequest`), which
   runs the real Tauri `invoke` and posts the result back keyed by `reqId`.
   This single relay covers **every** command, so all file types are served
   by the same plumbing. Milestone: the seeded file (doc *or* notebook *or*
   stack) loads and renders read-only.
3. **Single-file boot mode.** The web app, when launched with the satellite
   flag, mounts only the editor surface for the seeded file (doc editor /
   notes canvas / stack), skipping sidebar, pane manager, desk switcher,
   recent files; the command palette trims to file-local actions.
4. **Editing + autosave + live two-way sync.** Wire saves back through the
   relay; hook the existing `cross-window-*` broadcasts (relayed via the
   primary) so edits propagate both directions under the pull-lock guard.
5. **Lifecycle + polish.** Scene close → registry cleanup; primary-close
   behaviour; theme/style fidelity across all three file types; per-type
   edge cases (stack column virtualization, notebook autosave envelopes).

## Known Risks & Open Questions

- **Cannot build/test iOS in CI / this environment** (Linux, no Xcode, no
  checked-in `gen/apple`). Every native stage needs a Mac + device/sim to
  verify. Land the design first; treat Swift as draft until run.
- **Tauri scene-delegate assumptions (Stage 1)** — the single biggest
  unknown. If Tauri's generated app doesn't cleanly allow a custom
  `UISceneDelegate`, Stages 2–5 don't matter. Validate before anything else.
- **Primary-scene dependency** — satellite can't outlive the primary in the
  satellite model. Documented tradeoff; FFI is the escape hatch if needed.
- **Asset loading in the satellite webview** — the primary uses Tauri's
  custom-scheme loader for `dist/`. The satellite (non-Tauri) webview must
  load the same bundled assets via its own `loadFileURL` / a `WKURLScheme
  Handler` pointed at the app bundle. Needs validation.
- **`requestSceneSessionActivation` is best-effort** — iPadOS may decline
  (e.g. unsupported multitasking state). Surface failures quietly like the
  macOS `tauri://error` path does.

## Out of Scope (v1)

- Sidebar / file management / opening *other* files from within the new
  window (it's a single-file window — but that one file may be a doc,
  notebook, **or stack**, each fully rendered).
- Opening *projects* in a new window (joined-buffer view).
- More than the primary + one satellite at a time is not a goal, though the
  relay/observer impose no hard cap.
- Independent scene lifecycle (satellite surviving primary close) — the
  relay routes through the primary, so the primary must stay open.
