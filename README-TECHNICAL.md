# Hush — Technical Overview

## Architecture

Hush is a [Tauri v2](https://v2.tauri.app/) desktop app with a vanilla JavaScript frontend and Rust backend. The editor is built on [CodeMirror 6](https://codemirror.net/) — no framework.

```
Frontend (src/)                        Backend (src-tauri/src/)
───────────                            ────────────────────
main.js                  ←──IPC──→     lib.rs (app setup + run)
├── font-imports.js                    ├── atomic.rs            (tmp+rename writer)
├── style-application.js               ├── commands/
├── window-shortcuts.js                │   ├── files.rs
├── tooltips.js                        │   ├── images.rs
├── command-palette.js                 │   ├── settings.rs
├── cmd-button.js                      │   ├── snapshots.rs
├── backup.js                          │   ├── local_sync.rs
├── theme-colors.js                    │   ├── window.rs
├── themes/                            │   ├── backup.rs
│   ├── index.js                       (themeList, getThemeById, getActiveTheme)
│   ├── _create-theme.js               (EditorView.theme + HighlightStyle wrapper)
│   └── <theme>.js × 16                (one file per built-in theme)
├── tauri-bridge.js                    │   └── zotero.rs
├── zotero.js                          │
├── zotero-snapshot.js                 ├── settings.rs
├── zotero-annotations.js              │   └── defaults.rs
├── zotero/                            ├── files.rs
│   └── highlight-pane.js              ├── images.rs
│                                      ├── snapshots.rs
│                                      ├── sync.rs / sync_commands.rs
│                                      ├── local_sync.rs
│                                      └── zotero.rs
│
├── editor/
│   ├── editor.js
│   ├── heading-indent.js              (extracted from editor.js)
│   ├── comment-plugins.js             (extracted from editor.js)
│   ├── modes.js
│   ├── formatting.js
│   ├── sentence-navigator.js
│   ├── find-replace.js
│   ├── file-drop.js
│   ├── image-preview.js
│   ├── zen-focus.js
│   └── plugins/
│       ├── callouts.js
│       ├── dry-highlight.js
│       ├── encourage-typing.js
│       ├── focus-mode.js
│       ├── footnotes.js
│       ├── footnotes-ui.js
│       ├── image-decorator.js
│       ├── link-decorator.js
│       ├── private-mode.js
│       ├── project-view.js
│       ├── sticky-headers.js
│       ├── grammar-check.js
│       └── typewriter.js
│
├── notebook/              (see README-NOTEBOOK.md)
│   ├── notebook-bridge.js
│   ├── notes-canvas.ts
│   ├── state.ts                       (exception — see .line-limit-exceptions)
│   ├── renderer.ts
│   ├── renderer-selection.ts          (extracted from renderer.ts)
│   ├── renderer-background.ts         (extracted from renderer.ts)
│   ├── input-handler.ts
│   ├── ui/
│   │   ├── toolbar.ts
│   │   ├── shelf-panel.ts
│   │   └── ...
│   └── drawing/            (see README-DRAWING.md)
│       ├── drawing-layer.ts
│       ├── drawing-layer-types.ts     (DrawingLayer interface + selection-style types)
│       ├── drawing-layer-dom.ts       (DOM/SVG/canvas scaffolding)
│       ├── selection-style.ts         (retroactive styling session)
│       ├── sync-shim.ts
│       ├── brush-slots.ts
│       ├── tool-panel.ts
│       ├── layers-panel.ts
│       └── engine/                    (engine/stroke.js — exception)
│
├── pane/
│   ├── pane-manager.js                (lifecycle, focus, theme/style sync)
│   ├── pane-toolbar.js                (extracted: title-bar DOM + collapse/attach/pin)
│   ├── pane-layout.js                 (extracted: getInitialPanePosition, fitActivePaneToGap, centerPaneInViewport)
│   ├── pane-state.js                  (shared module state + accessors)
│   ├── pane-editor.js
│   ├── pane-content.js                (load / save / sync I/O)
│   ├── pane-attach-sync.js            (canvas + scroll attach loops)
│   ├── pane-drag.js                   (titlebar drag + edge resize)
│   ├── pane-size-popover.js           (per-pane font-size override)
│   ├── pane-persistence.js            (persist + restore across restarts)
│   └── text-drag.js
│
├── sidebar/
│   ├── sidebar.js
│   ├── sidebar-export.js              (extracted from sidebar.js)
│   ├── ratchet-dropdown.js            (extracted from sidebar.js)
│   ├── panel-resizer.js               (extracted from sidebar.js)
│   ├── files-panel.js
│   ├── files-panel-shared.js          (icons + escapers + hover handlers)
│   ├── files-panel-local-sync.js      (Local Sync subtree rendering)
│   ├── desktop-thumbnail.js           (pinned thumbnail at the panel bottom)
│   ├── styles-panel.js
│   ├── styles-panel-shared.js         (escapers + theme color maps)
│   ├── style-modal.js                 (two-column edit modal)
│   ├── style-modal-shader.js          (Post Processing block + per-layer knobs)
│   ├── custom-dropdown.js             (extracted dropdown widget used by style-modal)
│   ├── versions-panel.js
│   ├── version-diff.js                (LCS line diff for the Highlight changes toggle)
│   ├── notebook-snapshot-preview.js   (snapshot thumbnails for notebooks)
│   └── sortable-list/
│       ├── sortable-list.js
│       ├── rendering.js
│       ├── drag-drop.js
│       ├── keyboard-nav.js
│       └── utils.js
│
├── longview/
│   ├── longview.js
│   ├── longview-parser.js
│   └── longview-settings.js
│
├── settings/
│   ├── settings-window.js
│   ├── settings-tabs.js               (shared escapers + General/Editor/D.R.Y./Privacy/Flags tabs)
│   ├── settings-tabs-shortcuts.js     (extracted: shortcutCategories + Shortcuts tab)
│   ├── settings-tabs-sync.js          (extracted: Dropbox + Local Sync tab)
│   ├── settings-tabs-zotero.js        (extracted: Zotero tab)
│   └── settings-ui.js
│
├── state/
│   ├── state.js                       (AppState — thin coordinator)
│   ├── state-defaults.js              (default AppSettings shape)
│   ├── state-modes.js                 (extracted: ratchet / private / typewriter / dry / focus / zen / fullscreen toggles)
│   ├── state-snapshots.js             (extracted: keystroke-driven snapshot tracking)
│   ├── state-naming.js                (extracted: first-line auto-rename helpers)
│   ├── state-project.js
│   ├── state-tree.js
│   ├── state-images.js
│   ├── state-desktop.js
│   └── tree-helpers.js
│
├── sync/
│   ├── sync-state.js                 (manifest, reconcile, push helpers)
│   ├── initial-sync.js               (one-shot bulk push/pull on first connect)
│   ├── sync-mutations.js             (per-node mutations — enqueue ops via op-log)
│   ├── op-log.js                     (durable mutation queue + drain worker; idempotent executors)
│   ├── dropbox-cursor.js             (cursor pull loop; identity by remote_id; rev-based echo suppression)
│   ├── sync-images.js                (Dropbox image binary upload/download + tree insert)
│   ├── sync-polling.js               (10s tick: cursor pull + drain trigger + health check)
│   ├── notebook-sync.js              (.hushnote zip pack/unpack)
│   ├── dropbox.js
│   ├── dropbox-browser.js
│   └── local-sync.js                 (desktop-only filesystem mounts — JS wrapper over Rust commands)
│
├── shader-layer/                      (optional per-style post-processing — see README)
│   ├── index.js                       (registry + lifecycle + per-layer knob schema)
│   └── layers/
│       ├── css-vignette-scanlines.js  (CSS — static, zero-rAF)
│       ├── css-phosphor-scanlines.js  (CSS — scanlines + text-shadow glow on actual editor text)
│       └── webgl-neon-bloom.js        (WebGL2 — drifting glow blobs)
│
└── styles/                            (CSS, per-module)
```

Communication: `invoke` IPC for commands (settings, file CRUD) and `emit`/`listen` for events (settings updates, fullscreen toggle).

## Development Rules

**No code file may exceed 700 lines.** If a module grows past this limit, split it. The rule is enforced by `scripts/check-line-limits.sh` (run automatically as part of `npm run build`). A small allowlist lives in `.line-limit-exceptions` for files where splitting would do more harm than good (currently: `notebook/state.ts` and `notebook/drawing/engine/stroke.js`); every entry there must carry a one-line justification.

## Frontend

### Entry Points

- **`index.html`** — Main editor window. Loads `src/main.js`.
- **`settings.html`** — Settings window (separate Tauri WebviewWindow). Loads `src/settings/settings-window.js`.

Both are built by Vite as separate Rollup inputs.

`main.js` is pure orchestration — `init()` wires up the editor, sidebar, panes, command palette, and Tauri integration. Three companion modules carry pieces that used to bloat `main.js` past the line limit:

- **`font-imports.js`** — every `@fontsource` CSS import (~33 lines), pulled in for side effects only
- **`style-application.js`** — `applyActiveStyle(state)` (apply a named style's theme/font/colour overrides to the document), `applyFocusModeOpacity(state)` (publish the `--focus-mode-opacity` CSS var), and `handleOAuthCode(state, invoke, code)` (Dropbox deep-link callback)
- **`window-shortcuts.js`** — `installWindowShortcuts(state, windowCommands)`, the window-level keydown fallback that fires when CodeMirror hasn't already consumed the event (Cmd+P, Cmd+O, the always-allowed sidebar/outline/fullscreen toggles, plus the dispatch into `dispatchDomShortcut` for everything else)
- **`tooltips.js`** — global tooltip gate. `setTooltipsEnabled(bool)` reflects the `showTooltips` setting onto the DOM; `applyTooltip(el, label)` stashes the label on `data-tooltip` and only writes a native `title` attribute when tooltips are enabled. The notebook `h()` helper routes its `title:` option through `applyTooltip` automatically
- **`cmd-button.js`** — iOS-only Touch mode. Mounts two floating pills in the bottom-left (a `⌘` key to hold for Cmd-drag gestures, a `☰` button that opens the command palette on tap) when `settings.touchMode` is on. Holding the ⌘ pill sets `window.__hushCmdHeld = true`, adds `body.cmd-held`, and dispatches a synthetic `Meta` keydown so listeners that already gate on `e.metaKey` (link-decorator's `_modifierHeld`, the `body.cmd-held` class flip, etc.) pick up the virtual modifier without per-call-site changes. Exports `isCmdHeld(event)` — call sites that previously checked `e.metaKey || e.ctrlKey` on pointer / drag events (text-drag, image-decorator, sortable-list drag-out, notebook drop / merge / link-click) consult this helper so the on-screen ⌘ counts as Cmd-held even though the touch event itself has `metaKey: false`. iPad detection lowered the touchpoints threshold to `> 0` (some WKWebView versions only expose 1 touch even though the device handles multi-touch)
- **`backup.js`** — *Backup App Data* command palette modal. Calls the Rust `backup_app_data` command with a user-chosen destination, listens for `backup-progress` events to fill a progress bar, then reports the final path + size. Versions / snapshots are excluded server-side
- **`multi-window.js`** — desktop multi-window plumbing. Exports `setupMultiWindow(state)` (called from `main.js` after Tauri integration) plus `openInNewWindow(fileId, fileType)` for the command palette. Handles four jobs: (1) reads the URL hash on load so a new window seeded with `index.html#file=…&type=…` opens that file instead of restoring `lastFileId`; (2) calls `register_window` to claim a sequential number from the Rust `WindowRegistry` and pushes the current file via `set_window_file` whenever `file-opened` / `notebook-open` fire; (3) listens for `windows-updated` so `state.windowList` (and the sidebar's per-window numeral badges) tracks reality; (4) listens for `cross-window-state-changed` and re-pulls settings or the file tree from disk when a sibling mutates them — re-pinning per-window keys (`lastFileId`, `lastNotebookId`, `lastProjectId`, `scrollPosition`, `typewriterMode`, `dryMode`) on the local copy so a sibling write can't blow away this window's session state in memory

### Fonts

Google Fonts are bundled locally via `@fontsource` npm packages. Loaded as a side-effect import (`import "./font-imports.js"`) from `main.js` so Vite resolves npm paths correctly without polluting `main.js` itself.

**Built-in fonts:** Source Sans Pro (default), Source Serif Pro, Libre Franklin, Libre Baskerville, Karla, Lora, EB Garamond, Inter, Fira Code, iA Writer Duo, iA Writer Mono, iA Writer Quattro, Helvetica (system). The iA Writer families are bundled from `src/assets/fonts/ia-writer-*` and registered via `src/styles/ia-writer-fonts.css`.

### State Management (`state/state.js`)

`AppState` is the single source of truth. It holds settings, file list, mode flags, and the editor reference. Uses a simple event emitter (`on`/`off`/`emit`) to notify UI of changes. The default `settings` shape is built by `createDefaultSettings()` in `state/state-defaults.js` (~170 fields mirroring the Rust `AppSettings` struct).

**Sibling state modules.** `state.js` stays a thin coordinator; the chunks of behaviour that don't need to live on `AppState` itself were lifted into siblings so the file stays under the line limit:

- **`state-modes.js`** — every `toggle*` / `start|stopRatchet` mode flip. Each export takes `state` as the first arg; the matching `AppState.toggleX()` methods are one-line delegations so external callers (command palette, sidebar, editor commands) keep working unchanged.
- **`state-snapshots.js`** — `trackKeystroke(state)` (the every-30-keystrokes auto-snapshot) and `createManualSnapshot(state)`. Doc-only; notebook snapshots ride the autosave path in `notebook-bridge.js`.
- **`state-naming.js`** — `deriveName`, `cursorOnFirstLine`, `updateTreeNodeNameByFileId`, `maybeRenameFromFirstLine`, `maybeRenameFileFromContent`. The "name follows first line" rule has four triggers in `editor.js` — cursor leaves line 1, editor blur, autosave when cursor isn't on line 1, and a 1.5 s-debounced timer fired from `docChanged` (so a user who titles a doc and never moves the cursor still sees the rename land). The pane-driven counterpart fires on `savePaneContent` so docs created via "New Document as Pane" get the same treatment. `renameTreeNode` in `state-tree.js` early-returns when the requested name resolves to the existing one (after `uniqueChildName` suffixing) so the debounced trigger doesn't churn.

**`state.runtime` substructure.** Cross-module side-channel data that doesn't belong on `settings` (not persisted) and isn't first-class state (no event emissions) lives on `state.runtime`. Replaces the prior convention where any module could stamp a fresh `state._foo` field on AppState. Current fields:

- `columnResizeHandler` — set by `editor/modes.js`; called by sidebar / panel-resizer / pane-manager / main.js whenever sidebar or pane geometry changes so the editor column re-centers.
- `hasVisibleDocPane` — written by `pane-manager.js` when pane visibility changes; read by `editor/modes.js` to decide whether to leave the right gutter free.
- `pendingScrollPosition` — set during `init()` from the persisted `scrollPosition` setting; consumed once by `main.js` after the editor mounts.
- `localSyncWriteFlag` — short-lived timestamp set when Hush writes to a Local Sync file; the watcher uses it to suppress its own echo within ~500 ms.
- `syncPulling` — true while a sync layer (Dropbox poll, Local Sync watcher, pane sync) is pushing remote content into the editor; suppresses `markDirty` so the pull doesn't re-trigger an upload.

Key events: `mode-changed`, `fullscreen-changed`, `files-changed`, `file-opened`, `settings-changed`, `theme-changed`, `style-changed`, `style-preview`, `style-preview-end`, `show-files-panel`, `hide-panel`, `show-styles-panel`, `show-ratchet-dropdown`, `show-versions-panel`, `export-current-file`, `notebook-open`, `notebook-unmount`, `notebook-autosave`, `doc-content-changed`, `notebook-shapes-changed`, `desktop-changed`, `zen-focus-changed`.

**Notebook state:** When a notebook is open, `currentNotebookFileId` is set and `currentFileId` / `currentProjectId` are null. The notebook canvas has its own `DrawingState` (in `src/notebook/state.ts`), managed by `notebook-bridge.js`. See [README-NOTEBOOK.md](README-NOTEBOOK.md) for details and [README-DRAWING.md](README-DRAWING.md) for the freehand drawing layer and its engine/shim architecture.

On Tauri, state loads from the Rust backend via `invoke("get_settings")`, `invoke("list_files")`, and `invoke("get_file_tree")`. In the browser (dev without Tauri), it falls back to localStorage.

**File tree:** `AppState.fileTree` holds a nested tree of documents, folders, projects, and images. Each node: `{ id, type, name, fileId?, children[] }`. Persisted via `file_tree.json` (backend) or `localStorage` (web). Three special nodes are auto-created if missing and pinned in place: **Inbox** (root position 0, accepts new docs/notebooks), **Images** (second-to-last, holds every `image` node dropped into a doc), and **Trash** (last).

**Desks sync.** `.hush/desks.json` carries the synced part of the data model — the `desks` list and `desksMeta` — through the existing meta-sync pipeline (`sync/desks-sync.js`). `applyDesksFile` does five things: (1) merges the incoming desks list with any local desks the sender hadn't published yet (UNION rather than replace); (2) calls `reassignDeskIdByName` to unify a same-named local desk with an incoming one — both devices independently creating a "Personal" desk on first boot would otherwise carry two; (3) creates desk nodes for any incoming desks the local tree doesn't have, calling `absorbMatchingFolder` to fold up "ghost" folders the cursor delta may have built before the desks.json payload arrived (`<DeskName>/Inbox/Doc.md` events arriving before `.hush/desks.json` build a plain `<DeskName>` folder + `Inbox` subfolder via `insertDocumentNode`; absorption walks every level for a same-named folder with an `Inbox` sub-child and merges its children into the new desk); (4) calls `reconcileDesksWithStrayFolders` to do the same sweep for already-existing desks (catches the case where the user restarted and `ensureDesksTreeSpecials` already folded the ghost folder into another desk's children); (5) merges `desksMeta` entry-by-entry rather than replacing wholesale, so a payload from one device can't blow away saved choices for desks the sender hasn't touched. Dropbox layout migration (`sync/desks-migration.js`) runs once on the device that performs the boot-time always-on wrap: it enumerates `synced_files`, enqueues `rename` ops through the op log to prefix every path with `<DeskName>/`, and updates `relative_path` via `rename_sync_file`. Receiving devices don't enqueue any Dropbox writes — the cursor delta picks up the source's moves naturally.

**Desks** (`state/state-desks.js`) sit one level above everything else and are part of the structural model — there's no on/off switch. The top-level tree always holds `type: "desk"` nodes; each desk carries its own per-desk Inbox / Images / Trash addressed as `__inbox__:<deskId>`, `__images__:<deskId>`, `__trash__:<deskId>`. Active-desk routing goes through `state.getInboxId()` / `getImagesId()` / `getTrashId()` (delegated to `state-desks.js#activeSpecialId`); `state.isSpecialNodeId` and `state.isInTrash` match across every desk's namespaced ids by prefix. `migrateLegacyTreeIfNeeded(state)` runs in `init()` after the file tree loads — installs predating the always-on rollout persist a flat tree with bare `__inbox__` / `__images__` / `__trash__` ids, so the helper calls `enableDesks(state, "Personal")` to wrap them under a single default desk (and triggers the Dropbox path-prefix migration when sync is connected); the same helper also runs `reconcileDesksWithStrayFolders` so an already-broken tree (broken by an earlier sync before the absorb fix landed) self-heals on next launch. `createDesk` / `renameDesk` / `deleteDesk` mutate the desk list in place — they also enqueue `create_folder` / `rename_dir` / `delete_dir` ops on the op log so the desk skeleton lands on Dropbox immediately (without this empty Inbox/Trash subfolders never appeared remotely until a file landed inside). The very last desk can't be deleted. Per-desk synced metadata (active style, desktop slot, persisted panes) lives in `settings.desksMeta[deskId]`; the active desk id (`settings.activeDeskId`) is intentionally local-only — each device picks its own. Tree traversal helpers in `state/tree-helpers.js` know about the desk node type via prefix-matching the special-id checks (`pinSpecialsInList`, `enforceSpecialPositions`, `sanitizeDescendants`, `normalizeProjectChildren`).

**Per-desk active style.** The styles list (`settings.styles`) is shared across every desk, but the user's *selected* style is stored per-desk on `settings.desksMeta[<deskId>].globalStyleId` and rides cross-device sync via `.hush/desks.json`. `state.getDeskGlobalStyleId()` / `state.setDeskGlobalStyleId(id)` (thin wrappers over `state-desks.js`) own reads and writes; the legacy top-level `settings.globalStyleId` is preserved as a per-device fallback so installs that haven't been touched yet keep working. `enableDesks` seeds the default desk's meta with the user's existing top-level value on the first migration, while `createDesk` seeds new desks with `globalStyleId: null` so a fresh desk starts on Default rather than inheriting the previous selection. The style picker (`sidebar/styles-panel.js`), the `Mod+1..5` shortcut path (`editor/commands.js`), and the style-delete cascade all write through `setDeskGlobalStyleId`. `main.js` repaints on `active-desk-changed` (locked-style files still win via the `file-opened` branch). `style-sync.js` no longer carries the global pointer in `.hush/styles.json` — the field is emitted as null for older clients and ignored on receive once the local tree has at least one per-desk choice.

**Desk lifecycle** (`state/state-desks-ops.js`). The command palette exposes **New desk** (creates a fresh "Untitled desk" and switches to it), **Convert folder to desk** (promotes a folder/project that's a direct child of a desk into its own top-level desk; inner Inbox/Trash/Images subfolders matched by name become per-desk specials), and **Collapse desk into folder** (demotes a desk back to a regular folder placed inside another desk). The collapse path refuses while the source desk's Inbox or Trash carry any items — the operation drops those specials on the way through, so silently merging non-empty contents would be a data-loss surprise. The blocked path throws an error tagged `code: "desk-collapse-blocked"`; the picker surfaces the message via `window.alert` so the user knows what to clear before retrying. Images survive the collapse as a plain folder when non-empty so existing image refs still resolve.

**Desk switcher** (`sidebar/desk-switcher.js`) is a header rendered above the create-buttons row in the files panel. It auto-hides while there's only one desk so single-desk sessions don't carry the chrome. Clicking the header opens a popover with one row per desk (active marker, click to switch), inline rename, delete, and an "Add desk" entry that creates a new desk and switches to it. `render()` updates the header in place rather than rewriting `_container.innerHTML`, so a sync apply firing `desks-changed` while the user is mid-rename doesn't blow away the input; the popover body refresh is also gated on "no rename input present". The popover click handler short-circuits while a rename input is open — the input lives inside the row's `<button data-action="pick">` (it replaces the name span, which is a child of that button), and browsers synthesize a click on a `<button>` when Space is pressed on a child input; without the short-circuit that synthesized click bubbles up and gets routed to the "pick" branch, closing the popover mid-typing. The legacy `useDesks` boolean still ships in `state-defaults.js` and `AppSettings`, but only as a deprecated marker — the JS layer ignores its value and treats desks as structural; the field is retained so settings.json files written by older builds parse cleanly.

**Project state:** When a project is selected (`currentProjectId`), the editor shows all child *documents* joined by separator markers. Notebook children of a project are intentionally excluded from the joined buffer — they ride along as supplementary material in the sidebar instead. `openProject()` loads and concatenates document content; `saveProjectContent()` splits on separators and saves each part back. `state.projectDocIds` only carries doc fileIds, so the split-and-save pipeline never sees a notebook envelope.

Tree traversal utilities live in `state/tree-helpers.js` (`findNode`, `findNodeByFileId`, `findParentOfNode`, `removeNode`, `collectDocumentIds`, `insertAfter`, etc.).

**Same-name guard.** `tree-helpers.js#uniqueChildName(parent, baseName, type, excludeId)` returns a name that doesn't collide with any same-type sibling — `Foo`, then `Foo (2)`, `Foo (3)`, etc. on collision. It's wired into every create + rename path: `state.newFile`, `state.createNotebook`, `state-tree.js#createTreeNode` (folder + project), and `state-tree.js#renameTreeNode`. Two same-type children of a parent can't share a name (which would map to the same Dropbox path); rename also uses `excludeId` so the renaming node doesn't see itself as a conflict. New folders / projects default to the active desk as parent so they don't drop at the top level next to the desks (where `visibleTopLevel` would never render them); `createTreeNode` runs `enforceSpecialPositions` after the Tauri create so the new entry sits above the desk's Inbox/Images/Trash tail rather than below it.

### Theme Colors (`theme-colors.js`)

Extracted from `main.js`. Contains `fontFallbacks` map, `themeBackgrounds` color table, `hexLuminance()`, `updatePrivateBoxColor()` (derives `--private-box`, `--theme-bg`, `--fg`, `--cursor`, panel colors from the active theme background), and `applyFontFamily()`.

### Editor (`editor/editor.js`, `editor/modes.js`)

The CodeMirror 6 instance is configured with:

- **Markdown language** with inline syntax highlighting (headings get scaled font sizes, generic syntax characters dimmed to 40% opacity; `%%` comment markers and `==` highlight markers carry their own tags pinned to 20% opacity so the delimiters fade further than the content they wrap)
- **Custom inline parsers** for `%%comments%%` and `==highlighted text==`
- **Heading indent plugin** — hides `#` markers entirely by default via replace decorations; when the cursor enters the heading line the markers are revealed inline so the user can edit them. This replaces the previous behavior of pulling the markers into the left margin, which was being cropped when the editor column was narrow or inside a floating pane
- **Heading normalization** — optional setting to remove scaled heading sizes
- **Theme/highlight compartments** for live reconfiguration
- **Ratchet keymap** (`Prec.highest`) intercepting all deletion/navigation/selection keys when ratchet mode is active
- **Transaction filter** blocking deletions and non-end insertions in ratchet mode
- **Mouse filter** blocking mousedown in ratchet mode

**Plugins loaded:** private mode, D.R.Y. highlighting, footnotes, focus mode, callouts, project view (separators), flag highlighting, link decorator, heading indent, sticky headers, encourage typing.

**Sibling modules.** Two CodeMirror plugins were extracted to keep `editor.js` under the line limit:

- **`editor/heading-indent.js`** — `headingIndentPlugin` (collapses `#` markers when the cursor isn't on the heading line) plus the hang-indent helpers for wrapped list lines (`measureListMarkerPx`, `listIndentLineDeco`, `blockquoteLineDeco`).
- **`editor/comment-plugins.js`** — `createMultiLineCommentPlugin` (multi-line `%%…%%` blocks) and `createCommentAfterPlugin` (the `---%` end-of-document dim marker, scoped per file in project view — the dim closes at the next `---hush-separator---` line so a `---%` in one project doc no longer bleeds across the boundary into the next).

Both are re-exported from `editor.js` so external imports keep working.

**`createBaseExtensions(state, onChange)`** builds the shared extension set (theme, syntax highlighting, shortcuts, all plugins) used by both the main editor and floating pane editors. Returns compartment handles for theme, highlight, shortcut, and editable reconfiguration.

**`editor/modes.js`** contains mode application (`applyModes`, `applyFullscreen`), column width/resizer management (`updateColumnResizers`), and ratchet timer display (`updateRatchetTimer`). `applyModes` toggles CSS classes on `#app`: `ratchet-active`, `private-mode`, `typewriter-mode`, and `dummy-mode` (when private mode + dummy text is active).

Column width is managed by dynamically setting `paddingLeft`/`paddingRight` on `.cm-scroller`. Draggable resizer elements sit 10px outside the column edges. When the sidebar panel is open in inset mode, the column re-centers within remaining space.

### Command Palette (`command-palette.js`)

Centered overlay activated by `Cmd+P` (hardcoded in the fixed keymap). Lists all major commands with icons, labels, and keyboard shortcut keycaps. Supports arrow-key navigation, Enter to execute, Escape to dismiss, and text filtering.

Commands are context-sensitive: **shared** commands (New document, New notebook, **New document as pane**, **New notebook as pane**, Files, Styles, Toggle fullscreen, Settings, etc.) always appear; **doc-only** commands (Ratchet, Private mode, Typewriter, Show repeats, Highlight sentence, Outline view) are hidden when a notebook is open; **notebook-only** commands (Open shelf, Start brainstorm) appear only in notebook mode.

The "as pane" variants call `state.newFile(null, { openImmediately: false })` / `state.createNotebook("New Notebook", null, { openImmediately: false })` — both methods accept an option to skip the main-view switch and return `{ fileId, name }` so the palette can hand them to `createPane()`. The new file lands in Inbox like any other; it just opens as a floating reference instead of taking over the main editor.

Doc, notebook, project, and trash rows reuse the inline `typeIcons` glyphs exported from `sidebar/files-panel-shared.js` (filled rectangle, ruled rectangle, triangle, lid + bin) so the palette and the file tree show the exact same visual language. Mode-toggle and action rows still use the hand-drawn 24-unit SVGs from `src/sidebar/sidebar_icons/`. Each entry in the `icons` map is a fully-formed `<svg>…</svg>` string (24-unit for the sidebar imports, 16-unit for the `typeIcons` glyphs); `renderList` just drops it into the icon slot rather than re-wrapping with a per-row viewBox. All glyphs use `currentColor` for stroke/fill so they pick up the palette's `--fg`.

**File picker (`enterFilePicker`).** `collectFileLeaves` walks the tree and surfaces document, notebook, and user-created project nodes. It skips `__images__` / `__trash__` outright and skips the `__inbox__` *project entry* while still recursing into its children (Inbox is internally typed as a project but functions as a folder, so it shouldn't appear as a clickable target — only the docs inside it should). `enterFilePicker` accepts an `{ includeProjects }` opt-in flag because only the main editor can host a project's joined view — `createPane` doesn't know how to render the multi-doc separator buffer. The Cmd+P "Open document, notebook, or project" entry and the `Cmd+O` shortcut both pass `includeProjects: true` and route projects to `state.openProject(node.id)`; the "Open as pane…" entry and `Cmd+Shift+O` filter projects out so the resulting list only carries pane-compatible types.

**Keyboard nav vs. hover.** Arrow keys set a module-level `keyboardNav` flag and re-render the list. The per-row `pointerenter` handler early-returns while `keyboardNav` is true, so the `pointerenter` that fires on the row that re-renders under a stationary cursor doesn't yank the highlight back to the mouse position. An overlay-level `mousemove` listener clears the flag the moment the user actually moves the mouse again — `mousemove` is a mouse-only event (touch never dispatches it) so iPad touch scrolling doesn't trip the reset.

When toggle modes are active (ratchet, private, typewriter, D.R.Y., focus), "Turn off X" entries are prepended at the top of the list (doc mode only). Mouse hover selection is suppressed while keyboard-navigating to prevent conflicts.

**Touch-friendly hover handling.** Row hover activation keys off `pointerenter` filtered to `pointerType === "mouse"` — synthetic mouse events fire on iOS for every row your finger crosses during a touch scroll, and toggling an `.active` class across every row in response was causing visible scroll stutter. The keyboard-nav-clearing reset moved from an overlay-wide `pointermove` listener (which fired every touch frame) onto the per-row `pointerenter` so there is no per-frame work during a scroll. `.cmd-palette-list` carries `overscroll-behavior: contain` (so flicks at the end don't yank the underlying editor) and `will-change: scroll-position` (to nudge WKWebView onto a fast scrolling path).

**Backup App Data.** A shared command (`backup`) opens a modal from `src/backup.js` that calls the `backup_app_data` Tauri command with a destination chosen via `tauri-plugin-dialog::save`, listens for `backup-progress` events to drive a progress bar, and reports the final path + size on completion. Versions / snapshots are excluded server-side.

### Sidebar (`sidebar/sidebar.js`)

Fixed 50px column on the left edge with icon buttons. The column + panel open as a single unit via the floating toggle (upper-left circular button) or Cmd+\ — hover-to-reveal has been retired because on iPad it fought with the explicit toggle. `#sidebar` is opacity 0 / `pointer-events: none` until the `.visible` or `.pinned` class is set. On viewports wider than 700px the panel is always inset (pushing the editor column over); at 700px or narrower it falls back to overlay mode. The legacy pin button is `display: none` everywhere — the toggle owns open/close.

**Floating toggle (`.sidebar-floating-toggle`).** Circular button fixed at `top: 40px; left: 20px`, `z-index: var(--z-modal)` so it clears every other piece of chrome. Click emits `toggle-left-panel`, which either shows the files panel or hides all panels. Icon flips between `sidebar-expand` and `sidebar-collapse` based on `#panel-overlay`'s `.hidden` class (watched via `MutationObserver`). When the panel is open the button rides its right edge via `left: calc(50px + var(--panel-width) + 20px)` — no transition, matching the panel's snap behavior. In doc mode only, typing in an editable target adds a `.typing-fade` class that hides the button until any pointer activity brings it back; notebook mode keeps the button permanently visible for Pencil-only users.

**Buttons:** Files panel, Styles panel, Versions, Export, Settings (iOS only). Mode toggles (ratchet, private, typewriter, D.R.Y., focus, zotero) are accessed via the command palette (`Cmd+P`).

Panels render into `#panel-overlay`. Layout is responsive: when wide enough, panels inset beside content; otherwise they overlay as a modal.

**Cursor:** The sidebar column and open panel use `cursor: crosshair` so hovering anywhere in the sidebar surfaces a consistent navigation affordance distinct from the editor cursor.

**Tooltips.** The sidebar's icon buttons use a custom-styled tooltip overlay (`.sidebar-tooltip` — name + shortcut keycap diagram, ~900 ms hover delay). Pane header buttons and notebook UI buttons use the native browser `title` attribute. Both are gated by the `showTooltips` setting (default off — tooltips are opt-in). The shared mechanism lives in `src/tooltips.js`: `applyTooltip(el, label)` stashes the label on `data-tooltip` and only writes the live `title` attribute when tooltips are enabled; `setTooltipsEnabled(enabled)` flips a body class and walks every `[data-tooltip]` to add/strip its title. Wired from `main.js` once at startup and on every `settings-changed`. The notebook `h()` helper in `ui/dom-helpers.ts` routes its `title:` option through `applyTooltip` automatically, so adding a new notebook button picks up the gate for free.

**Resizable width:** The right edge of the panel overlay exposes a draggable handle that reuses the same invisible-until-approached resizer pattern as the editor column (`editor/modes.js::updateColumnResizers`). A 10px hit zone sits outside the panel edge; pointer-down begins a drag that updates a `--panel-width` CSS custom property and persists the value to `sidebarWidth` in `AppSettings`. The handle is transparent at rest and only paints a thin accent line while hovered/dragging. Minimum and maximum widths match the inset-vs-overlay thresholds used by the responsive layout so the panel never collapses below its content or exceeds the viewport. Implementation in `sidebar/panel-resizer.js`.

Two more sidebar helpers live alongside the main file: **`sidebar-export.js`** (the Export button — handles markdown-only and folder-with-images flavours, picking dialog vs. download-blob based on Tauri vs. browser) and **`ratchet-dropdown.js`** (the centered duration grid surfaced by the command palette).

### Files Panel (`sidebar/files-panel.js`, `files-panel-shared.js`, `files-panel-local-sync.js`)

Nested tree view with four node types:

- **Documents** — Markdown files. Click to open in the editor.
- **Notebooks** — Canvas-based visual notes. Click to open in the notebook view. See [README-NOTEBOOK.md](README-NOTEBOOK.md).
- **Folders** — Containers for organizing. Drag-and-drop reordering.
- **Projects** — Ordered containers whose document children concatenate into one editor buffer with dashed separators between them. Notebook children are accepted too but render as a supplementary block in the sidebar — sorted below all docs and painted at 50 % opacity — and stay self-contained (clicked → opens the canvas) instead of feeding the joined buffer. `tree-helpers.js::normalizeProjectChildren` runs after every drag-drop and on initial render so the docs-first / notebooks-after order is canonical; it skips the pinned `__inbox__` node, which is typed `project` for legacy reasons but behaves like a folder. The per-row vertical-line connector and the notebook-fade are pure CSS hanging off `data-type` / `data-id` attributes set in `sortable-list/rendering.js`. Consecutive doc rows inside a real project carry a 1 px × 4 px vertical line over the gap between icons (`.sl-item[data-type="project"]:not([data-id="__inbox__"]) > .sl-list > .sl-item[data-type="document"] + .sl-item[data-type="document"]::before`); notebook rows inside that same scope drop their `tree-item-row` to `opacity: 0.5`.

Four icon-only "New" buttons (Doc, Notebook, Folder, Project) at the top; the button type is surfaced via tooltip. All types share a hover menu (rename, duplicate, delete). Active item shown bold and underlined. Rendered via the `SortableList` component.

**Row interactions.** A click anywhere on a folder row — including its icon and label — toggles the folder open or closed. This applies uniformly to every container node: regular folders, Projects, **Inbox**, **Images**, and **Trash**. The explicit expand arrow (if present) remains as a visual cue but is no longer the sole hit target. A second click on the already-selected row still enters rename mode via the existing double-click/enter keymap; the toggle only fires on a single click that is not part of a pending rename gesture.

**Hover buttons overlay.** Per-row action buttons (rename, duplicate, delete, hover menu) render as an absolutely-positioned layer above the row rather than as inline flex children. This keeps them out of the row's width calculation so the label text is allotted the full available width regardless of hover state — previously, nested deep rows were truncating labels to leave space for buttons that weren't yet visible. While a row is in rename mode the overlay is hidden (`display: none`) so the input can span the full row width.

**Duplicate + Folder ↔ Project toggle.** The duplicate action shows a confirmation modal (a generic `showConfirmModal` extracted to `files-panel-shared.js`, mirroring the delete dialog's style) and the new node lands beside the original with a `-Copy` suffix instead of the previous `" copy"` filename. The hover-button row also surfaces a bi-directional arrow on real folder / project rows that calls `state.convertContainerType(nodeId, target)` — folders and projects are structurally identical so the swap is a one-field tree edit. Project → Folder loses ordering and the joined preview view, so that direction prompts via `showConfirmModal` first; Folder → Project is a silent flip.

**Images folder.** The pinned Images node renders with a photo-frame icon that has a single diagonal slash through it (replacing the previous "X"-like mark). Like Trash, it defaults to collapsed and is only expanded when the user explicitly clicks to open it; the expanded/collapsed state is persisted per-user alongside other sidebar state.

**Flagged bubbling (longview).** The outline view's **Flagged** section walks nested folders so that a folder marked "flagged" lifts all of its descendants into the Flagged list. `longview-parser.js` recurses through children rather than stopping at the first non-document; the resulting entries preserve their indentation depth relative to the flagged ancestor so the hierarchy is still legible inside the Flagged group.

**Local Sync rendering** lives in `files-panel-local-sync.js`. The mounted-folder subtrees render outside the SortableList because their content comes from disk (lazy-expanded via `local_sync_read_dir`). Shared icons / escapers / hover-handlers live in `files-panel-shared.js` so both files can use them without a circular import.

**Desktop thumbnail** (`sidebar/desktop-thumbnail.js`) is a pinned card at the bottom of the panel-overlay showing the doc or notebook in `settings.desktopFileId`. It's `position: absolute; bottom: 0` inside the fixed `#panel-overlay`, so the file list scrolls behind it without lifting it off the bottom edge. Click opens the file via `openFile` / `openNotebook`. The thumbnail re-renders on `desktop-changed` and `files-changed`, plus a 2.5 s-debounced refresh on `doc-content-changed` / `notebook-shapes-changed` for the desktop file (the delay lets the 2 s autosave land before we re-read from disk). A `ResizeObserver` on the body re-runs the snapshot render whenever the panel is resized so the canvas bitmap stays crisp instead of stretching. For docs, the body shows a markdown-stripped text preview clamped to six lines via `previewSnippet`. For notebooks, it reuses `renderNotebookSnapshotThumbnail` from the Versions panel work, threaded through the live `NotesCanvas`'s theme/font/imageCache so the thumbnail visually matches the open notebook. Assignment and clear flow through two command-palette entries: **Use this file as desktop** and **Clear desktop**, both calling `state.setDesktop(fileId | null)` (delegated to `state/state-desktop.js`). Cross-device sync rides `.hush/desktop.json`: the wire format carries Dropbox's cross-device-stable `remote_id` (resolved at upload via `get_sync_file_info`, resolved at apply via `find_synced_file_by_remote_id`) plus the file type. Local-Sync-only files have no `remote_id`, so they keep the desktop slot locally but skip the upload. The applier also accepts the legacy `desk.json` filename / `format: "hush-desk"` payload so existing Dropbox folders keep working through the rename.

**Notebook minimap** (`notebook/minimap.js`) is a floating widget anchored bottom-right of `#notebook-container` and toggled via the command palette (**Show minimap** / **Hide minimap**, gated to notebook context). State lives on `settings.minimapVisible`; the toggle goes through `state.toggleMinimap()` which emits `minimap-visibility-changed`. `main.js` mounts the widget on `notebook-open` (or at boot when restoring the last notebook) if the setting is on, and unmounts it on `notebook-unmount`. The implementation reuses `renderNotebookSnapshotThumbnail` from the Versions / Desktop work and projects three overlays on top of the snapshot: pane rectangles (filtered to the open notebook by `ownerContext` plus any pinned panes), a live viewport rectangle driven by `requestAnimationFrame` ticks against `getCanvasInstance().state.camera`, and pointer-drag pan that sets the live camera to centre the clicked world point. The minimap is what was previously baked into the desktop thumbnail; lifting it out lets the desktop thumbnail be a pure preview that works for any pinned file regardless of whether the notebook is open.

### Sortable List (`sidebar/sortable-list/`)

Drag-and-drop nested list engine (5 modules):

- **`sortable-list.js`** — Main class. API: `setData()`, `getData()`, `destroy()`, `render()`.
- **`rendering.js`** — Recursive DOM rendering with fold arrows and nested `<ul>` children.
- **`drag-drop.js`** — Pointer events, hold-to-drag (200ms), ghost element, hysteresis drop zones, auto-expand.
- **`keyboard-nav.js`** — Arrow key selection, M to enter/confirm move, Q to cancel.
- **`utils.js`** — Path parsing, comparison, ancestor checks, tree traversal.

### Styles Panel (`sidebar/styles-panel.js`, `style-modal.js`, `styles-panel-shared.js`)

Named presets combining theme, font, font size, line height, and color overrides (bg, fg, cursor, selection). Managed through the sidebar's Styles panel.

Style data: `{ id, name, themeId, fontFamily, fontSize, lineHeight, colorOverrides: { bg, fg, cursor, selection } }`.

Live preview on hover/edit via `style-preview` / `style-preview-end` events. Color overrides take precedence over theme colors, applied directly to CSS variables.

The two-column edit modal (settings on the left, live preview on the right) lives in `style-modal.js`. It autosaves on a 200 ms debounce — there are no Save/Cancel buttons; closing the modal flushes the timer. Shared escaper helpers + theme color maps used by both the panel and the modal live in `styles-panel-shared.js`. The Post Processing block in the modal is split into `style-modal-shader.js` and the generic dropdown widget into `custom-dropdown.js` to keep `style-modal.js` under the line limit.

### Post Processing / Shader Layer (`shader-layer/`)

Optional per-style overlay of decorative effects (scanlines, vignette, neon glow on text, drifting bloom). Surfaced in the style edit modal as a "Post Processing" block; data lives on `Style.shaderLayer` for user styles and `AppSettings.shaderLayer` for the Default style. Rust struct `ShaderLayer { enabled, layer_id, intensity, options }` (camelCase via serde) round-trips alongside the rest of the Style.

**Zero-cost-when-off.** The whole runtime — `shader-layer/index.js` and every `layers/<id>.js` — is dynamically imported via `import()` only when a style with `shaderLayer.enabled === true` is applied. `style-application.js` keeps a one-shot `_shaderModulePromise` so the chunk loads once per session at most. Users with no effect configured pay nothing: no DOM, no canvas, no WebGL context, no rAF loop, no listeners, and the bundle never reaches the renderer.

**Registry** (`shader-layer/index.js`). `SHADER_LAYERS` is an array of `{ id, name, family: "css" | "webgl2", load: () => Promise<Module>, settings: KnobSchema[] }`. The schema lives in the registry rather than the layer modules so the modal can render a layer's knob list without first loading the layer's code. Each `KnobSchema` is `{ id, label, type: "range" | "color", min?, max?, step?, default }`. `resolveLayerOptions(layerId, userValues)` overlays user values on top of the schema defaults.

**Lifecycle.** `applyShaderLayer({ layerId, intensity, container?, options? })` is idempotent: same layer + same container → push new intensity/options to the existing instance via `update()`; different layer or container → `unmountShaderLayer()` and remount fresh. `container` is optional — pass an element to scope the host inside it (used by the modal preview pane); omit for fullscreen overlay. `unmountShaderLayer()` calls the layer's `dispose()`, drops the resize/visibility listeners installed by `buildCtx`, and removes the host element.

**Per-mount ctx.** `buildCtx(host, intensity, options)` returns `{ intensity, options, dpr, width, height, onResize, onVisible }`. The registry installs the resize observer + `visibilitychange` / `focus` / `blur` handlers once at mount; layers subscribe through callbacks rather than wiring their own. Animated layers gate their rAF loop on `onVisible(visible && focused)` so the GPU/CPU goes quiet when the user tabs away.

**Host element.** Single `<div id="shader-layer-host">` with `pointer-events: none` so it never intercepts clicks. Two positioning modes:

- **Fullscreen** (no container): `position: fixed; inset: 0; z-index: 501`. Above the floating sidebar toggle (`--z-modal: 500`) but below modal content (`--z-modal-content: 510`) — so the shader covers all chrome (sidebar, panes, overlays, popovers) but the style modal / settings / command palette stay visually clean while open.
- **Scoped** (container element): `position: absolute; inset: 0; z-index: 1` appended into the container. Used by the modal preview pane (`#style-preview-pane`, which carries `position: relative` so the host sizes correctly) so hovering / selecting layers in the dropdown previews them inside the preview pane only, not over the live editor.

**Blend modes live on the host, not the canvas.** Putting `mix-blend-mode` on a child canvas isolates the blend to the host's transparent backdrop — cleared white pixels paint opaque over the editor instead of multiplying with it. Setting it on the host blends the entire layer-as-a-unit onto everything beneath in body's stacking context. The host CSS deliberately omits `contain: strict` for the same reason (paint containment establishes paint isolation that breaks `mix-blend-mode` reach).

**Layer modules.** Each exports `default function mount(host, ctx)` returning `{ update?, dispose }`.

- **`css-vignette-scanlines.js`** — radial vignette + horizontal scanline pattern via two stacked `background-image` gradients on the host. No animation. Knobs: `vignetteStrength`, `scanlineOpacity`, `scanlineColor`. `mix-blend-mode: multiply` so scanlines darken light themes correctly.
- **`css-phosphor-scanlines.js`** — first layer to break the pure-overlay model. Adds a class (`.shader-layer-phosphor-active`) to either `<body>` (fullscreen) or the modal preview pane (scoped), and injects a `<style>` in `<head>` with rules targeting `.cm-content` and `.style-preview-content`. The rules read CSS custom properties (`--shader-layer-phosphor-glow`, `--shader-layer-phosphor-halo`) that intensity-driven JS sets on the scope element so a slider drag retunes the glow without re-rendering anything. Knobs: `glow`, `halo`, `scanlineOpacity`, `scanlineColor`. Cleanup invariant: `dispose()` removes the class, the custom properties, the injected `<style>`, and the host's inline styles. Each step wrapped in its own try block so a stale reference can't strand the rest — this is the "pull the plug" path.
- **`webgl-neon-bloom.js`** — three soft colored glow blobs drifting on irrationally-related rates (so the pattern never visibly repeats), screen-blended via `mix-blend-mode: screen` on the host. Procedural-only; no source texture sampled. Knobs: `brightness`, `speed`, three blob colors. Speed accumulates real-time × current rate into a `timeAccum` counter so changing speed mid-flight doesn't snap the blob positions. Renders at half-DPR — the blobs are smooth volumetric gradients, so upsampling adds an extra hint of softness for free. WebGL context is `WEBGL_lose_context.loseContext()`-ed on dispose so WebKit releases GPU memory immediately. Falls back to animated CSS radial gradients when WebGL2 isn't available.

**Belt-and-suspenders panic cleanup.** `panicCleanup()` (also exposed on `window.__hushShaderPanicCleanup` for dev-console use) is the "pull the plug" escape hatch — finds and removes any `shader-layer-*` artifacts (host element, injected stylesheets, scope classes, custom properties on `<html>`/`<body>`) regardless of internal state tracking. Idempotent and safe to call any time. Useful if a layer ever glitches mid-mount or if you want to verify the feature can be fully removed.

**Modal integration** (`sidebar/style-modal-shader.js`). `renderShaderSection(draft)` produces the section markup (Enable checkbox + layer dropdown + master intensity slider + per-layer knob list); `bindShaderSection(backdrop, draft, scheduleSave)` wires events. Hovering layers in the dropdown previews each via `applyShaderLayer({ container: previewPane })`; selecting commits to the draft and `scheduleSave()`-s. Switching layers re-renders the knob list against the new schema. `endShaderPreview(applyActiveStyle, state)` is called from `style-modal.js::close()` so closing the modal restores whatever shader the active style requires (or none).

**Default vs user-style storage.** User styles carry `shaderLayer` on each `Style` object; the Default style stores its shader at `AppSettings.shaderLayer` (top-level), since the Default style is reconstructed on the fly in the modal from individual `AppSettings` fields. `applyActiveStyle()` reads from whichever slot matches the active style. The startup call to `applyActiveStyle` is unconditional (was previously gated on `activeStyleId` truthy) so the Default's shader mounts on app launch.

### Outline View / Longview (`longview/`)

Right-side panel showing document structure. Parses headings and flagged items from the document. Features: heading hierarchy navigation, flag detection, callout tinting, paragraph preview tooltips, customizable display options via a dedicated settings tab (Flags).

### Versions Panel (`sidebar/versions-panel.js`)

Snapshot history viewer for both docs and notebooks. Shows timestamped snapshots and a one-click restore. Backend storage via `snapshots.rs` — the `snapshots` table is keyed by `document_id` + free-form `content` text, so notebook JSON envelopes drop into the same store as doc markdown without a schema change.

**Preview interaction.** Each list row has paired `mouseenter` / `mouseleave` listeners alongside the click handler. Hover renders the snapshot in the right pane with the **Restore current with…** bar suppressed (the preview container's `bottom: 50px` is overridden inline to `0` so the preview fills the full height). Click commits the selection — the active class flips on, the restore bar mounts, and `selectedSnapshotId` is set. Hovering a different row while a selection is committed swaps the preview in transiently; mouseleave reverts to the committed snapshot, or hides the preview when nothing is committed. Module-level `hoveredSnapshotId` and `selectedSnapshotId` track the two slots; arrow-key navigation still goes through the click path so it commits.

**Doc mode.** Snapshot creation is driven by `state.js::trackKeystroke()` (every 30 dirty keystrokes) plus `createManualSnapshot`. The default preview is the snapshot text with search-match highlighting; restore writes through `save_file` and re-seeds the editor via `editor.setContent`.

**Highlight changes (doc-only diff).** A checkbox below the search input flips the preview into a line-level diff between the snapshot and its chronological predecessor (`currentSnapshots` is ordered DESC by `created_at`, so the predecessor is `currentSnapshots[idx + 1]`). The diff lives in `sidebar/version-diff.js` and is dynamically imported on first toggle so users who never enable it pay nothing. `diffLines(oldText, newText)` trims common prefix and suffix lines first, then runs an LCS table over the remaining middle (`Int32Array`-backed, `(m+1)*(n+1)` cells, capped at 4M to fall back to "all removed, then all added" on pathological cases). Each entry comes back as `{ type: "context" | "added" | "removed", text }` and renders as `.diff-line` rows with a gutter (`+` / `−` / blank) and the line text — added rows get a green background, removed rows get a red background plus strikethrough. The first snapshot has no predecessor and shows a "First snapshot — no prior version to compare against." note above the plain content. Notebook mode hides the toggle entirely (no diff path for shape JSON). Search highlighting is suppressed while the diff renders to keep the markup readable. Toggling the checkbox calls `refreshActivePreview`, which re-renders whichever snapshot is currently hovered or committed.

**Notebook mode.** Snapshot creation rides the existing 2 s notebook autosave: after a successful `save_file` in `notebook-bridge.js::saveNotebook()`, the bridge calls `create_snapshot` with the same JSON content. Search filters by the concatenated text-shape bodies (extracted by `extractSnapshotText` in `sidebar/notebook-snapshot-preview.js`). Preview is a thumbnail rendered from the JSON envelope: `notebook-snapshot-preview.js` decodes the envelope, fits a camera to the content bbox, and calls `renderForExport` (with the live notebook's theme/font/imageCache so it visually matches what the user sees). Drawing strokes are approximated as polylines because the bake-engine canvas only exists for the live notebook — fine for a thumbnail. Restore writes through `save_file` then calls `reloadNotebookShapes` on the bridge so the open canvas re-seeds without remounting.

### Focus Mode (`editor/plugins/focus-mode.js`)

CodeMirror ViewPlugin that dims all text except the current sentence to 50% opacity. Uses sentence-boundary detection from `sentence-navigator.js`. On empty lines, all text is dimmed.

### Zen Focus (`editor/zen-focus.js`, `styles/zen-focus.css`)

Fullscreen distraction-free overlay activated by `Cmd+Shift+S`. Available in three contexts: the main editor (doc mode), an active doc pane, or a notebook text-shape inline editor. The source surface picked at toggle time is the one whose handle matches first in that priority order.

**Shadow editor model.** Rather than reparenting the source's DOM into the overlay, Zen builds a fresh `EditorView` inside the overlay and seeds it with the source's content + cursor offset. The source editor sits dormant for the duration of Zen. On exit the new content + selection are pushed back to the source via a single replacement transaction (CodeMirror sources) or a textarea value+input dispatch (notebook text shape — text-editor.ts's input handler then updates `state.editingText`). The shadow approach sidesteps every category of bug we hit with reparenting: stale CodeMirror geometry, fights with the pane click-outside-deactivate handler, textarea positional weirdness.

**Focus mode lives here on purpose.** `createBaseExtensions()` deliberately omits `createFocusModePlugin` (panes don't want sentence-level dim inside them); the Zen module re-adds it to the shadow editor's extension list. Zen also auto-enables `state.focusMode` on entry and restores its prior value on exit, so surrounding-sentence dim works without a separate toggle. A `mode-changed` listener forwards a no-op dispatch to the zen view so toggling focus mode (`Cmd+Shift+Y`) from inside Zen wakes the shadow editor's focus-mode plugin.

**Centring + curtains.** A 50vh top/bottom padding on the shadow `.cm-scroller` lets every line — including the first and last — sit at the window's vertical centre. An `EditorView.updateListener` dispatches `EditorView.scrollIntoView(head, { y: "center" })` on every selection / doc / viewport change so the cursor's line tracks centre as the user types or arrows. Two `::before` / `::after` gradient curtains fade the top and bottom thirds of the overlay back to `--bg`, so the user works in the centre band.

**Hint pill.** A small `.zen-focus-hint` in the bottom-right shows the configured shortcut; opacity 0 by default, fades in on `mousemove` and out 1.5 s later.

**Settings.** `zenFocusFontSize` (Settings > Editor > Zen Focus, default 30 px) and `shortcutZenFocus` (Settings > Shortcuts > General, default `Mod+Shift+S`). Surrounding-sentence dim uses the user's existing `focusModeOpacity` slider — Zen reads through to it rather than introducing a parallel knob.

### Find & Replace (`editor/find-replace.js`)

Two modes:

- **`Cmd+F`** — Find/replace in current file. Floating bar with match count, prev/next, replace one/all. Pre-fills with selection.
- **`Alt+Shift+F`** — Search across all files. Results grouped by file with line numbers, click to navigate. Debounced (200ms).

### Sentence Navigator (`editor/sentence-navigator.js`)

Sentence-level navigation and editing, ported from [obsidian-sentence-navigator](https://github.com/laffan/obsidian-sentence-navigator). Detects boundaries using punctuation rules (`.` `!` `?`) with closing delimiter handling.

Commands: `selectSentence`, `reduceSentenceSelection`, `jumpToNextSentence`, `jumpToPrevSentence`, `shiftSelectionToNextSentence`, `shiftSelectionToPreviousSentence`, `moveSentenceForward`, `moveSentenceBack`, `deleteToSentenceEnd`, `jumpToNextParagraph`, `jumpToPrevParagraph`, `selectParagraph`, `joinLines`.

### Footnotes (`editor/plugins/footnotes.js`, `editor/plugins/footnotes-ui.js`)

CodeMirror plugin that decorates `[^id]` references with colored dots or underlines. `footnotes.js` handles parsing and the CodeMirror plugin. `footnotes-ui.js` renders overlays, marginalia, and the insertion command. Configurable font, size, colors, and margin placement.

### Callouts (`editor/plugins/callouts.js`)

Obsidian-style blockquote callouts (`> [!note]`, `> [!warning]`, etc.) with colored left borders. 25+ callout types with default colors.

### Formatting (`editor/formatting.js`)

Markdown toggle commands using a generic `toggleWrap(view, marker)`: `toggleBold` (`**`), `toggleItalic` (`*`), `toggleHighlight` (`==`), `toggleComment` (`%%`), `toggleStrikethrough` (`~~`).

### Link Decorator (`editor/plugins/link-decorator.js`)

Makes URLs in the editor clickable. Decorates detected links with click handlers.

### Encourage Typing (`editor/plugins/encourage-typing.js`)

Break timer that periodically nudges the user to keep writing. Configurable intervals and messages.

### Private Mode (`editor/plugins/private-mode.js`)

ViewPlugin with two modes, controlled by the `privacyMode` setting:

- **Blackout** (default) — Wraps every non-whitespace character in a `.hush-private-char` span with `color: transparent` and a solid `background` box. CSS forces all text in `.cm-line` to `color: transparent !important` so CodeMirror's inner syntax spans (heading colors, link colors) can't show through.
- **Dummy text** — Wraps every non-newline character in a `.hush-dummy-char` span. Each line gets a stable offset into the user-provided dummy text (`lineNumber * 997 % dummyLen`), so editing on one line doesn't shift other lines' dummy characters. The real text is invisible; a `::after` pseudo-element renders the dummy character.

When private mode is active, `applyModes()` adds `.private-mode` to `#app` (both modes) and `.dummy-mode` (dummy only). CSS hides footnotes, marginalia, and heading indent markers.

### Sticky Headers (`editor/plugins/sticky-headers.js`)

ViewPlugin that shows the current heading hierarchy pinned to the top of the editor (`position: fixed; top: 0`). Collects all headings above `viewport.from` and builds a nested stack. Clicking a header smooth-scrolls to that heading. Syncs left/right padding with the editor scroller. Controlled by the `stickyHeaders` setting.

### Word Count (`editor/plugins/word-count.js`)

Optional live word count pinned to the top of the text column. When `wordCountVisible` is true, a small pill (`#word-count-display`) is absolutely positioned relative to `.cm-scroller`, horizontally centered in the column, and stacked into the same vertical slot used by the Ratchet timer. When Ratchet mode is active the two elements coexist: the timer renders first and the word count renders directly below it, styled identically (same background, padding, typography, and theme variable hookups as `.ratchet-timer`). When Ratchet is off, the word count takes the slot alone.

Counting is debounced (~100ms) off the CodeMirror `docChanged` update and uses a whitespace-split after stripping comment markers (`%%...%%`), inline code fences, image markdown, and any text past the line containing the `---%` end-of-document gray-out marker — editorial notes don't inflate the total. In project mode the separators are skipped, and the `---%` strip is applied per segment (split on `---hush-separator---` first, trim each, rejoin) so a marker in one project doc doesn't drop the rest of the project's word count. Selection changes trigger a recompute too — partly so the project per-doc number tracks separator crossings, partly so a `.has-selection` class flips on the pill the moment the user has something selected. The plugin reads `wordCountVisible` from state and responds to `settings-changed` / `mode-changed` events; toggling is handled by the `toggleWordCount` command, bound by default to `Cmd+Shift+W` and surfaced in the command palette.

**Format.** `recompute()` builds a `[[count, label], …]` array and `formatCounts` joins each pair as `"<n> <label>"` with `" / "` between them. Each slot carries its own label so the pill is self-describing:

| Mode                            | No hover                          | Hover w/ selection                              |
|---------------------------------|-----------------------------------|-------------------------------------------------|
| Doc / notebook                  | `<n> words` (or `word` for 1)     | `<n> selected / <n> total`                      |
| Project (joined buffer)         | `<n> section / <n> total`         | `<n> selected / <n> section / <n> total`        |

`section` is the slice of the joined buffer between the separators surrounding the cursor (`sliceProjectSegmentAt`). The `word`/`words` switch only matters in the regular-doc, no-selection case — every other case uses fixed labels (`selected`, `section`, `total`).

**Selection hover.** The pill is `pointer-events: none` by default so the cursor passes through to the editor and editor drag-selects aren't interrupted. The `.has-selection` modifier (added by `recompute()` when `view.state.selection.main.from !== to`) flips it to `auto`, so the pill is hoverable only while a selection exists. `mouseenter` flips a module-level `showingSelection` flag and re-runs `recompute()`, which prepends the selection slot; `mouseleave` clears the flag and reverts. If the selection is cleared while hovering, the next `recompute()` (fired by the selection-set update listener) drops the flag automatically.

**Pane header chip.** Doc-mode floating panes carry their own word count (`.fp-wordcount`) next to the title — same setting (`wordCountVisible`), independent count per pane (each pane has its own editor). `pane-content.js` exports `countWords` from this module and refreshes the chip on every pane editor `docChanged` plus once on initial load. `pane-manager.js` listens for `settings-changed` and runs `syncAllPaneWordCounts()` so toggling the global flag updates every pane in lockstep. Notebook panes don't get a chip — their content is shapes, not prose.

### Proofread Mode (`editor/plugins/grammar-check.js`)

Single doc-only proofreading toggle surfaced via the command palette as **Proofread mode** (icon: capital + lowercase "Aa" with a shallow X — two near-flat lines mirrored about the horizontal axis — laid over the letters). Reads `state.proofreadMode`; flipping it goes through `state-modes.js::toggleProofread`, which emits `mode-changed` so the existing editor `mode-changed` listener forces a no-op dispatch and the plugin redecorates. Short-circuits when a notebook is open.

The mode toggle is **deliberately not persisted** between sessions. Harper's curated dictionary takes a few seconds to build on first call; resurrecting the mode at startup would gate the editor on that build. Each session starts with proofread off, the user re-enables when they want it, and the per-rule disable list (`proofreadDisabledRules`) does round-trip so individual rule preferences survive.

Earlier iterations had a separate `nspell` spellcheck plugin with bundled Hunspell dictionaries; that's gone. Harper ships its own `SpellCheck` rule and was finding everything nspell was finding, so a second pipeline was just redundant work.

**Plugin.** `createGrammarCheckPlugin(state)` calls the `check_grammar` Tauri command (`commands/grammar.rs`, `harper-core` crate). The very first run after toggling proofread on bypasses the debounce — harper's cold-start dictionary build is the long pole, and waiting 1.5 s before that work begins makes the mode feel broken; subsequent edits while the mode is on are debounced to 1.5 s as before. Results are cached per `EditorView` in a `WeakMap` so the buffer only re-lints after actual changes. The plugin tracks a per-view `runId` so a debounced run that finishes after a newer one started discards itself. Issues underline as a thick (3 px) solid orange line via `.hush-grammar-error` — the wavy variant was too thin to read at most font sizes. A module-level `_activeRunCount` drives `setProofreadLoadingModal(visible)`, which mounts a centered "Proofreading…" card on `<body>` (spinner + label, fixed centre via `position: fixed; top/left: 50%; transform: translate(-50%, -50%)`, fades in/out via the `.visible` class) for the entire span between toggling the mode on and the underlines actually painting. The runner yields two `requestAnimationFrame` ticks between mounting the modal and starting the IPC call (so the modal definitely paints before any scheduling spike) and one more after the redecorate dispatch (so the orange underlines visibly land before the spinner fades). A companion `createGrammarHoverTooltip(state)` reuses the same cache to surface a tooltip with the harper message + suggestions when the user hovers an underline. The plugin forwards `state.settings.proofreadDisabledRules` to the Rust command on every call so the Proofread settings tab affects results without a process restart.

**Offset translation.** harper returns spans in Unicode-scalar offsets (`Span<char>`); CodeMirror addresses positions in JavaScript UTF-16 code units. `char_to_utf16_range` in the Rust command does the conversion once on the way out so the JS frontend never has to re-walk the buffer per issue. ASCII / BMP prose is unaffected; emoji + supplementary-plane characters are handled correctly.

**Wiring.** The plugin is mounted only on the main editor (`editor/editor.js`) — `createBaseExtensions` (the pane factory) intentionally doesn't include it, keeping floating panes lean and matching the docs-only scope. The "Turn off Proofread mode" entry appears at the top of the command palette while the toggle is active, mirroring the existing `Turn off …` rows for Ratchet, Private, etc.

**Settings.** The Proofread tab (`settings/settings-tabs-proofread.js`) renders one checkbox per harper rule, reusing the existing `.settings-row` chrome from the D.R.Y. Detection block — name + description on the left, checkbox on the right, thin border-bottom between rows. The rule list comes from a Rust command (`list_grammar_rules`) returning a curated subset (~30 commonly-toggled rules — `LongSentences`, `OxfordComma`, `RepeatedWords`, `ThatWhich`, etc.) so the tab automatically picks up any rule renames in a future harper bump without a JS-side edit. Each row carries the humanized rule name (`humanizeRuleName` splits CamelCase boundaries) plus an 11 px description in `var(--sidebar-fg)` at 75% opacity from a static `RULE_DESCRIPTIONS` map. State lives on `proofreadDisabledRules: string[]` (default `["LongSentences"]`); checked = enabled, unchecked = disabled. The checker forwards the list on every grammar pass. CSS for the rule rows lives in `settings/settings-window.css` (not the main `proofreading.css` bundle) because the settings window runs in its own Tauri WebviewWindow with a separate CSS pipeline — the modal styling stays in `proofreading.css` since that's loaded by the main editor window.

**Backend.** `commands::grammar::check_grammar(text, disabled_rules)` is declared `async` and hops to the blocking thread pool via `tauri::async_runtime::spawn_blocking` for the actual lint. A synchronous Tauri command would run on the WebView's main thread and freeze the JS UI for the multi-second cold-start dictionary build (beach ball + invisible modal). Inside the closure it builds `LintGroup::new_curated(FstDictionary::curated(), Dialect::American)` against `Document::new_markdown_default_curated(&text)`, then iterates `disabled_rules` calling `linter.config.set_rule_enabled(rule, false)` (no-op for unknown keys, so harper version drift is safe). Each `Lint` is serialised to `{ from, to, message, suggestions }` with `Suggestion::ReplaceWith(Vec<char>)` / `Suggestion::InsertAfter(Vec<char>)` flattened to strings (`Suggestion::Remove` is dropped since there's no replacement text to surface in the tooltip). `commands::grammar::list_grammar_rules()` returns the curated rule names so the Proofread tab can render its checkbox grid without hard-coding a list. The FST dictionary is held in a static `Arc` inside harper, so back-to-back lints of edited buffers don't repay the dictionary build cost.

### Typewriter Mode (`editor/plugins/typewriter.js`)

Locks cursor to a fixed screen position (default 60% from top). Draggable boundary line for repositioning. Extra padding so first/last lines can reach the boundary. Also handles ratchet scroll (pins last line to 50% center).

### Project View (`editor/plugins/project-view.js`)

CodeMirror plugin for project mode. `createProjectViewField` (StateField) replaces `---hush-separator---` lines with non-editable dashed widgets. `createSeparatorFilter` (transactionFilter) blocks edits touching separator lines.

### File Drop (`editor/file-drop.js`)

Four context-aware drop targets. When the sidebar panel is open, an "Import file" overlay appears inside `#panel-overlay` — dropping creates a new document. In doc mode, drops on the editor append text content for `.md`/`.txt` files; image drops (PNG/JPG/GIF/WebP/SVG/etc.) are routed through `state.createImageFromFile()` which saves the binary via `save_image` and inserts a standard `![alt](filename.png)` reference at the cursor coordinate (see "Doc Images" below). In notebook mode, the canvas handles drops natively (images become image shapes, text files become text shapes); holding Cmd/Ctrl while dropping plain text wraps it in a markdown blockquote and creates the resulting TextShape at 14 px instead of the default 18. Doc panes get their own drop wiring via `attachPaneTextDrop` (in `pane/pane-editor.js`) — the main editor's drop net only covers `#editor-container` so without this drops on a floating doc pane fell through. The two payload-classification helpers (`hasAcceptableDragPayload`, `readDragText`) are shared exports of `file-drop.js`. Tauri's built-in drag-drop is disabled so DOM events reach the webview.

### Doc Images (`editor/plugins/image-decorator.js`, `editor/image-preview.js`, `state/state-images.js`)

**Storage model.** Image binaries live at `{data_dir}/files/images/{filename}` under the user's original filename; the Rust `ImageManager` auto-suffixes on collision (`brown-cow.png`, `brown-cow (2).png`, ...). A tree node with `type: "image"` and `fileId === filename` records each one. The Images folder is a pinned special node (`__images__`) that sits directly above Trash and only accepts image children; `files-panel.js`' `canDrop` and the generic `canDropIntoParent` check in `sortable-list/drag-drop.js` reject any attempt to drag an image out.

**Reference syntax.** Standard markdown — `![alt](filename.png)` — with two extensions: an optional caption after a pipe (`![alt | caption](filename.png)`) renders italic below the image, and URLs containing spaces or parens are wrapped in double quotes (`![alt]("brown-cow (2).png")`) so the parser can unambiguously recover the filename. `IMAGE_MD_RE` in `state-images.js` is the shared regex (bare or quoted URL, capture groups 1=alt, 2=quoted URL, 3=bare URL) consumed by the decorator, the export path, the rename rewriter, and the delete purger so every caller agrees on syntax.

**Inline rendering.** `createImageDecoratorPlugin` replaces a resolved ref with an inline `<img>` wrapper whenever no cursor overlaps it; cursor-inside reveals the raw markdown for editing. CSS enforces `max-width: 100%` (editor column-bounded) and `max-height: 50vh`, and narrower images are centered. Data URLs are lazy-loaded via the Rust `load_image` command and cached by filename. The plugin re-runs `buildDecorations` when `state` fires `files-changed` by dispatching an annotated transaction — this is how a pane opened before the image existed still picks it up when the tree updates.

**Interactions.** Hovering an `image` row in the Files panel shows the full image in a floating tooltip (`attachImageHoverTooltip` in `editor/image-preview.js`; the tooltip hides immediately when its source row leaves the DOM via a `requestAnimationFrame` connectivity watch). Clicking either the sidebar row or the editor-rendered image opens `openImagePreviewModal`, a centered lightbox dismissed on Escape or backdrop click.

**Rename + delete.** Renaming an image calls `rename_image` in Rust (renames on disk, auto-suffixes on collision, preserves the original extension if the user drops it) and then `rewriteImageRefs` walks every document in the tree, updating both bare and quoted URL forms — including the currently-open editor buffer. Deleting an image (soft or permanent) first runs `removeImageRefs` to purge every matching markdown ref from every doc; solo-line refs consume their line so no blank line is left behind. `findImageNode` also skips the Trash subtree so a manually-typed ref to a trashed image won't resolve.

**Drag routing.** One unified pipeline handles all image transfers:
- *Desktop → doc / notebook*: `editor/file-drop.js` (docs) and the notebook's own drop handler detect image files and save via `save_image`.
- *Sidebar → doc / notebook*: the sortable list's new `forceDragOutside(item)` config hook lets image rows escape the panel without a modifier. `files-panel.js`' `onDragOutside` routes them to `dropSidebarImageAt(filename, x, y)` in `pane/text-drag.js`, which `elementsFromPoint`-scans for a CodeMirror editor or registered notebook canvas and inserts markdown or adds an `ImageShape` accordingly.
- *Doc ↔ pane*: `attachImageDrag` hands the markdown ref to `startTextDrag`; the receiving editor re-decorates it on drop.
- *Doc → notebook via Cmd-drag*: when `startTextDrag`'s drop target is a notebook canvas and the payload is a single local image ref, it resolves the data URL and adds an `ImageShape` instead of a text shape.
- *Notebook → doc*: `attachNotebookImageShapeDrag` initiates a drag with a `{ dataUrl, name, width, height }` image payload; the drop handler invokes `save_image` (reusing the auto-suffix logic), creates an image tree node, and inserts `![alt](filename.png)` at the drop coordinate.
- *Notebook → notebook* with an image payload clones the shape at the drop point. The drag ghost shows a thumbnail for image payloads.

**Export.** `collectImageRefs` walks the current document for local image refs; `export_with_images` (Rust) writes `text.md` + `images/<filename>` into a user-chosen folder, and `rewriteImageRefsForExport` rewrites each ref to the relative `images/` path (quoting URLs when they need it).

### Floating Panes (`pane/`)

Draggable reference windows that float above the editor or notebook canvas. Created by Cmd-dragging a file from the sidebar files panel past the panel boundary into the editing area. The subsystem is split across nine modules; **`pane-state.js`** is the shared state hub (the `panes` Map + accessors for the lazy notebook bridge, the active pane id, etc.) so siblings can read/mutate without circular imports against `pane-manager.js`.

**`pane-manager.js`** — Lifecycle entry point: create, close, focus, theme/style sync, ratchet lock. Imports the worker modules below; owns the public API (`initPaneManager`, `createPane`, `closePane`, `focusPane`, etc.). The title-bar DOM (icons, buttons, collapse/attach/pin toggles) lives in **`pane-toolbar.js`**, and the positioning helpers (`getInitialPanePosition`, `fitActivePaneToGap`, `centerPaneInViewport`) live in **`pane-layout.js`** — both extracted to keep `pane-manager.js` under the line limit. `pane-toolbar.js` receives `{ closePane, focusPane, createPane, getCurrentContext, onContextChange }` from `pane-manager.js` at build time so it doesn't need a back-import.

**`pane-editor.js`** — Factory that calls `createBaseExtensions()` from `editor/editor.js` so pane editors share the identical plugin, shortcut, and theme setup as the main editor. Exposes `setEditable(bool)` via an `EditorView.editable` compartment — inactive panes are locked non-editable to prevent input leaks.

**`pane-content.js`** — Load + save + bidirectional sync with the main editor / notebook canvas. Includes `loadDocumentPane`, `loadNotebookPane`, `savePaneContent`, `autosaveAllPanes`, and the four `syncDoc*` / `syncNotebook*` functions. The sync flag is held in pane-state and protected by try/finally guards so a thrown handler can't permanently jam the channel.

**`pane-attach-sync.js`** — Anchoring loop. `startCanvasSync` drives a per-frame `requestAnimationFrame` that converts the pane's canvas world coords to screen coords through the active camera (also applying `transform: scale(zoom)` so the pane shrinks/grows with the surrounding shapes). `startScrollSync` listens to `scrollDOM.scroll` for doc-mode panes. `stopAttachSync` cleans up both flavours.

**`pane-drag.js`** — `setupPaneDrag` (titlebar) + `setupPaneResize` (edge / corner handles). Notebook-attached panes translate screen deltas into world coords via the camera zoom.

**`pane-size-popover.js`** — Per-pane font-size override via a CSS custom property on the pane root that CodeMirror's `hushTheme` reads. The "A" affordance in the titlebar opens a popover with `−` / `+` (Cmd-click applies to all open panes).

**`pane-persistence.js`** — Serialise the open pane set into `AppSettings.persistedPanes` on a 300 ms debounce; restore on app start. `restorePanes` takes `buildPaneDOM` + `onContextChange` callbacks as deps so it doesn't have to import pane-manager.js (which would be circular). Beyond the obvious geometry / anchoring / pinned fields, the persisted record carries `editorScrollTop` (the per-pane CodeMirror scroll offset) so reopening a pane lands the reader where they left off — `pane-content.js` wires a 200 ms-debounced scroll listener via the editor's `onScroll` API and applies the saved offset on next mount one rAF after `setContent` has populated the buffer.

**Pane object:** `{ id, fileId, fileName, fileType, collapsed, attached, pinned, dirty, editor, notebook, el, width, height, x, y, ownerContext, localSync, zotero, editorScrollTop }`. `fileType` is one of `"document"`, `"notebook"`, or `"zotero-highlights"`. The third type is a fileless pane (no underlying tree node, no `editor` / `notebook` instance) used by the Zotero highlight browser; the `zotero` field carries `{ itemKey, attKey, title, authors, year }` once the user has chosen an attachment. See "Highlight browser pane" under Zotero Integration for the load / persist branches.

**Attach vs Pin:**

- **Attach** — Anchors the pane to content. In notebooks, converts screen position to canvas world coordinates and syncs every frame via `requestAnimationFrame`. In docs, records `scrollRelY` (pane Y + scrollTop) and updates on the editor's scroll event. Dragging a canvas-attached pane converts screen deltas to canvas deltas (dividing by zoom).
- **Pin** — Marks the pane as global (`.pinned` class — blue **border** with a thin matching shadow ring; header coloring stays normal). Pinned panes stay visible across all document switches. Unpinning triggers `onContextChange()` so the pane returns to its original context. Attach and pin are mutually exclusive — toggling one while the other is active shows a confirmation dialog.

**Duplicate** — Creates a new pane for the same file with `ownerContext` set to the current document (not the source's context). The duplicate check in `createPane` scopes by context, so the same file can have panes in different documents.

**Content sync:** Document panes fire `syncDocFromPane` on every `docChanged`, pushing content to the main editor if the same file is open (with `_syncPulling` flag to suppress `markDirty`). The reverse direction uses a `doc-content-changed` event from `main.js`. Notebook panes sync shapes via `loadShapes()` with a `_syncing` guard reset via double `queueMicrotask` to account for `DrawingState`'s batched change events.

**Input isolation:** The notebook's window `keydown` and document `paste` handlers skip processing when `document.activeElement` is inside a `.floating-pane`. Inactive pane content gets `pointer-events: none` via CSS, and the editor is set to non-editable. A window-level capture-phase `pointerdown` listener deactivates panes when clicking outside.

**Z-index layering:** `#pane-container` is `z-index: var(--z-pane)` (90 — above editor content at 0–80, below sidebars). The notebook container has no z-index to avoid creating a stacking context, allowing the shelf panel (`var(--z-shelf)` — 150) to render above panes. The full scale is documented in `base.css`; see "CSS Structure" below.

**Locked styles.** When a document or notebook was saved with "Lock Style to Document" enabled, its tree node stores a `lockedStyleId`. A pane whose `fileId` resolves to a file with a locked style applies that style scoped to the pane element (theme compartment reconfigure for the CodeMirror instance; theme resolve + `HUSH_TO_NOTEBOOK_THEME` lookup for notebook panes) rather than the session-active style. Pane creation and `file-opened` updates both consult the locked style; `style-changed` events only affect panes whose file is unlocked. The scoping lives on `.floating-pane[data-locked-style]` via CSS custom-property overrides so the main editor's style is untouched.

**Drag-from-sidebar integration:** `sortable-list/drag-drop.js` has an `onDragOutside(item, x, y)` callback. In `finishDrag`, the callback fires instead of the normal reorder drop when the pointer is right of the panel overlay AND either Cmd/Ctrl is held (real `metaKey`/`ctrlKey` OR the virtual `window.__hushCmdHeld` flag from Touch mode's ⌘ pill) OR `forceDragOutside(item)` returns true. `files-panel.js` uses the modifier path for documents and notebooks (creating a floating pane via `createPane()`) and `forceDragOutside` for image rows so they escape the panel without a modifier — `onDragOutside` then calls `dropSidebarImageAt` in `pane/text-drag.js` to insert markdown into the editor or add an `ImageShape` to the notebook under the pointer. `canDropIntoParent` also runs `canDrop` for sibling reorders and root-level drops (not just "drop into" targets), which is how the images-stay-in-Images rule is enforced.

### Zotero Integration (`zotero.js`, `zotero-snapshot.js`, `zotero-annotations.js`, `zotero/highlight-pane.js`)

Citation management plus a highlight browser pane. Connects to the Zotero Web API with a user key, downloads references (and their attachments) with progress tracking, caches the result locally. The shared fuzzy search (`fuzzySearch` in `zotero.js`) is matched against title / shortTitle / authors / year / item key.

Two surfaces consume the cache:

- **Insert reference modal** (`openZoteroModal` in `zotero.js`, palette label "Zotero: Insert reference", default `⌘⇧I`) — modal that picks an item or attachment and inserts a `[Title](zotero://...)` link, with an optional page anchor and optional PDF snapshot.
- **Highlight browser pane** (`openZoteroHighlightPane` in `zotero/highlight-pane.js`, palette label "Zotero: Create highlight browser") — a new pane fileType, see "Highlight browser pane" below.

**Insertion contexts.** A single helper, `resolveInsertContext(view, notebookTextHandle, state)`, decides where the citation lands:

1. **Active notebook text-shape edit** — modal captures the inline textarea handle on open (see "Notebook text shapes" below), routes citation through `TextEditor.insertAtSelection()`.
2. **Notebook canvas with no active edit** — `state.currentNotebookFileId` takes priority over the always-mounted-but-hidden CodeMirror view, so inserts here drop a new `TextShape` at the viewport centre rather than silently landing in the hidden doc.
3. **Doc** — `view.dispatch({ changes })` at the cursor.

**Notebook text shapes.** Opening the search modal blurs the inline textarea overlay (`notebook/ui/text-editor.ts`), which would normally commit the shape and tear down the editor before the citation could be inserted. `text-editor.ts` exports `suspendCommitOnBlur()` / `resumeCommitOnBlur()` / `insertAtSelection(text)` plus a `getActiveNotebookTextEditor()` accessor (also mirrored on `window.__activeNotebookTextEditor` for synchronous lookup from focus-stealing UI like the command palette). The modal suspends the commit on open, inserts the citation through the textarea handle on confirm, and resumes blur-commit on close.

**PDF snapshots.** When a PDF attachment is selected, the detail panel reveals an **Insert snapshot** checkbox + page selector. On confirm, `renderPdfPage()` in `zotero-snapshot.js` lazy-loads `pdfjs-dist`, rasterizes the chosen page to a `<canvas>` at the configured render height, and emits a WebP data URL via `canvas.toDataURL("image/webp", quality)`. The result is inserted alongside the citation:

- **Notebook (edit or canvas)** — the data URL is embedded directly on a new `ImageShape` placed flush to the right of the text. It does *not* go through `createImageFromDataUrl` — the bytes already round-trip inside the notebook's JSON envelope, and surfacing every snapshot in the global Images folder felt like clutter. A Cmd-drag from the canvas into a doc still promotes the shape via `text-drag.js`.
- **Doc** — `state.createImageFromDataUrl(dataUrl, filename)` saves the binary to `Images/`, returns the (possibly auto-suffixed) final filename, and the modal inserts `![alt](filename.webp)` after the citation. Filenames containing whitespace/parens (collisions emit `name 2.webp`) are wrapped in double quotes per the convention enforced by `IMAGE_MD_RE`, otherwise the doc image decoder silently ignores the markdown.

**PDF download.** Zotero's `/users/{id}/items/{key}/file` endpoint returns a 302 to a presigned S3 URL whose CORS policy rejects the webview's `null` origin, so a webview-side fetch fails after the redirect. The `download_zotero_pdf` Tauri command (`commands/zotero.rs`) does the request server-side via `reqwest` (with redirect following enabled), persists the bytes to `{data_dir}/zotero_pdfs/{itemKey}.pdf` keyed on a sanitised attachment id, and returns them. Subsequent renders of other pages from the same paper read from the cache without re-fetching.

**Settings.** The Zotero tab carries credentials (User ID + API key) plus a **PDF Snapshots** group: render height (default 1500 px), display height on canvas (default 300 px), and WebP quality (default 90, 1–100). All three round-trip through `AppSettings` (`zotero_snapshot_render_height`, `zotero_snapshot_display_height`, `zotero_snapshot_quality`).

**Highlight browser pane.** A third pane fileType — `"zotero-highlights"` — surfaces a paper's PDF annotations next to the editor. The pane is fileless: it has no underlying tree node, so `pane-content.js` skips the doc/notebook load path and calls `mountZoteroHighlightPane(pane, appState)` instead, `pane-manager.js::buildPaneDOM` skips the font-size button and the title-link's open-in-main-view handler, and `savePaneContent` is a no-op for the type. The chosen attachment is persisted on `pane.zotero = { itemKey, attKey, title, authors, year }` and serialised by `pane-persistence.js` so a restart lands directly back in annotations mode.

The pane has three internal modes that swap the body:

1. **Search** — fuzzy search over the local reference cache (`loadReferences` + `fuzzySearch` re-exported from `zotero.js`).
2. **Pick attachment** — only entered when the chosen item has 2+ PDFs. With exactly one PDF the pane jumps straight to mode 3; with zero, the search step shows an inline message.
3. **Annotations** — header with a Zotero deep-link title (clickable, opens the PDF at page 1), authors/year, a back arrow, and a refresh button. The back arrow (`zh-back-arrow-btn`) sits to the left of `↻`, shares its pill style, and on click clears `pane.zotero`, restores the default title, persists, then renders mode 1 again so a different paper can be picked. Below the header is an annotation search input, then a two-column body: a 30 px column of 15 px color swatches (with an empty-circle "All" filter at top), and the filtered annotation list. Empty-text annotations (typically ink / image annotations) are filtered out — those don't surface usefully here and would otherwise dilute the color buckets.

Each annotation row's `p. N` label is itself a Zotero deep link. Tauri webviews don't navigate plain anchors with custom schemes, so an `attachExternalLinkHandler` helper intercepts the click and routes through `@tauri-apps/plugin-opener::openUrl` (with a `window.open` fallback for browser dev). Drag-out reuses `pane/text-drag.js::startTextDrag` — `pointerdown` on a row formats the annotation as a markdown blockquote with comment + a `zotero://open-pdf?page=N` citation suffix and hands it to the existing pipeline. A re-entrancy guard on `_fetching` prevents overlapping network calls during rapid refreshes / reloads.

**Annotation cache.** `src/zotero-annotations.js` exposes `getAnnotations(attKey, userId, apiKey, { forceRefresh })` and `groupByColor(annotations)`. The fetch goes through the `fetch_zotero_annotations` Tauri command (server-side, paginated), which hits `/users/{id}/items/{attKey}/children?itemType=annotation` — note the `/children` endpoint, not `/items?parentItem=…`; the latter doesn't actually scope by parent and returns the entire library. Results are cached at `{data_dir}/zotero_annotations/{attKey}.json` via `save_zotero_annotations`, and `load_zotero_annotations` returns `Option<String>` so a missing cache is distinct from an empty array. The pane reads cache-first and only re-fetches when the user hits `↻`.

**Cross-device pane sync.** Highlight panes participate in the same `.hush/panes.json` sync as documents and notebooks (`src/sync/pane-sync.js`). They follow exactly the same rules as every other pane type — default = floating in their creation context, attach = anchored to canvas/scroll within that context, pin = global. The only zotero-specific deviation is the cross-device identity: a local `fileId` like `zotero:<uuid>` is per-install and means nothing on another device, so `serializePanesForSync` writes `remoteFileId = "zotero:" + attKey` plus an inline `zotero` payload, and `applyRemotePanes` keys de-dup on `attKey` instead of `fileId` for this fileType (via the `matchKey` helper). All other apply behavior — owner resolution, anchoring updates, soft-state propagation — runs through the standard branches. Annotation cache files are *not* synced; each device hits Zotero on first open and builds its own.

**Pane sync wire fields.** `serializePanesForSync` carries `attached`, `pinned`, `collapsed`, `canvasX`/`canvasY`, `scrollRelY`, `width`, `height`, `editorScrollTop`, `fontSize`, plus the `remoteFileId` / `ownerRemoteId` translation. Position (`x`, `y`) is intentionally NOT synced — different device classes have wildly different viewports, so each device picks its own placement and the `recoverOffscreenPanes` pass nudges any pane that landed off-screen back into view. Size, anchor, and editor scroll all round-trip so a deliberately-laid-out reading layout survives a device hop. On apply, an existing pane gets its anchor + soft-state + (if non-zero) `width` / `height` / `editorScrollTop` patched in place; a new pane is minted via `createPaneFn` with the same fields, and the editor scroll position is applied one rAF after `setContent` so CodeMirror has laid out its viewport before being asked to scroll.

A long-standing bug in `applyPanesFile`'s signature (`(payload)` instead of the dispatcher protocol's `(state, payload)`) caused the AppState object to be passed where the JSON string was expected, which silently failed `JSON.parse` and meant nothing applied. Fixed in 2026-04 alongside the highlight-pane work; once corrected, all pane types — docs, notebooks, and zotero highlights — sync via the same pipeline.

### Dropbox Integration (`sync/dropbox.js`, `sync/dropbox-browser.js`)

Dropbox OAuth PKCE integration for syncing files. `dropbox.js` handles the full OAuth flow (authorize → token exchange → auto-refresh) and all Dropbox API operations via direct `fetch` calls (no SDK). `dropbox-browser.js` provides a folder browser modal for selecting the sync target folder. Build-time config via env vars: `VITE_DROPBOX_APP_KEY` (required) and `VITE_DROPBOX_REDIRECT_URI` (defaults to `hushwriter://auth/callback`, set to `http://localhost:5173/oauth-callback.html` for dev). The `oauth-callback.html` page relays the auth code to the `hushwriter://` deep-link scheme. Tokens are loaded on demand from settings (`ensureTokens()`) so they survive across window contexts.

### Sync (`sync/`)

Full-library Dropbox synchronization. All documents, folders, and projects are mirrored to a single Dropbox folder. Documents sync as `.md` files (named from document's first line, max 50 chars, special chars stripped). Projects sync as directories containing their child documents plus a `.hushproject` JSON metadata file with ordering. Folder merging handles special nodes (Inbox, Trash) by matching name and ID. Sync is optional — users connect via OAuth in Settings > Sync and can disconnect at any time, choosing to keep or remove Dropbox files.

**Architecture (rewritten 2026-04).** Sync state lives in a SQLite database (`sync.db`, sibling of `snapshots.db`) with four tables: `synced_files` (per-file mapping with `remote_id` and `last_known_rev`), `dropbox_cursor` (per-folder cursor for incremental delta queries), `pending_ops` (durable queue for outbound mutations), `sync_orphans` (entries set aside during the JSON → SQLite migration when duplicate paths were detected; surfaced for manual review). On first launch after the rewrite, the legacy `sync_map.json` is migrated into `synced_files` and renamed to `.bak`. See `src-tauri/src/sync_db.rs`.

**Outbound (UI → Dropbox).** Renames, deletes, file creations, and folder creations enqueue rows in `pending_ops` instead of calling Dropbox directly. The drain worker (`op-log.js`) executes them serially in insertion order with idempotent semantics — each executor calls `getMetadata` at the destination first so a partially-completed previous attempt collapses to success without producing a duplicate. Ops outlive offline windows. Per-edit content uploads go through `syncFileToExternal` (a single `uploadFile` call); the response's `rev` is recorded as `last_known_rev`. `executeUpload` recomputes the destination path from the live tree at drain time when the file has no `synced_files` row yet — without this, a rename that fired between `syncCreateFile` enqueueing and the drain (common when first-line auto-rename catches the user mid-typing) lands the file at the stale name on Dropbox, since `syncRenameNode` silently no-ops while info is null.

**Initial sync** (`sync/initial-sync.js`). One-shot bulk push/pull triggered when the user picks a Dropbox folder for the first time. It lists Dropbox via `listFolderRecursive` (which surfaces each entry's `id` + `rev`) *before* the upload pass so it can detect path collisions and suffix the local name to `Foo (2)` instead of clobbering an existing remote file — the rename flows through `rename_file` so the local tree, Tauri DB, and the upload path all line up. Both uploaded and downloaded entries register via `register_synced_file_full` carrying the Dropbox `id` + `rev`; the cursor seed that runs immediately after recognises them via `find_synced_file_by_remote_id` and echo-suppresses cleanly. Without the full registration the seed treated each just-downloaded file as a fresh "created" event and turned every entry into a duplicate Tauri file plus a duplicate tree node.

**Push gates.** Three layers of "don't push unchanged content" sit on every outbound write so a no-op autosave can't mint a fresh Dropbox rev that other devices would then pull back: (1) `_runUpload` in `sync-state.js` and `executeUpload` in `op-log.js` SHA-256 the local content and compare against `SyncedFileInfo.lastSyncedHash`, returning early on equality. (2) `enqueueMetaUpload` in `meta-sync.js` keeps a per-filename hash of the last enqueued payload (`panes.json`, `projects.json`, `styles.json`, `desk.json`) and drops identical re-enqueues. (3) The hashing helper `sha256Hex` matches the Rust `SyncedFileInfo.last_synced_hash` format (lowercase hex over UTF-8 bytes) so the two sides compare directly without an extra Tauri round-trip.

**Inbound (Dropbox → UI).** A single `pullDropboxCursor` call (`dropbox-cursor.js`) drives `/2/files/list_folder/continue` to get only the entries that changed since the last cursor. Events are matched by Dropbox's stable `id` (which doesn't change on rename), so a remote rename is reported as one event with the old `id` and a new `path_display` — we update the path in the sync map without creating a duplicate internal file. Cursor expiry (>90 days or server-side reset) is detected as a 409 with `reset` and triggers a clean reseed. Polling cadence is 10 seconds.

**Echo suppression.** Two layers protect against pulling our own writes back. The SQLite-backed `last_known_rev` is the per-file slot updated on every successful upload — most echoes match against it. But that slot is single-valued, and a fast type → push → type → push sequence can bump it past the rev Dropbox eventually reports back (Dropbox's index is eventually-consistent; the cursor delta can carry the older rev after a newer one has overwritten the slot). The recent-revs ring in `meta-sync.js::markOurFileRev` / `wasOurFileRev` keeps the last 16 revs we wrote per file, and `dropbox-cursor.js::processEntries` accepts a match against either source as our own write. Meta files (`.hush/*.json`) use the parallel global `markOurRev` / `isOurRev` ring since they aren't tracked in `synced_files`.

**Editor pull lock.** `state.acquirePullLock(fileId)` is held across the full async pull (download + persist + setContent), not just the synchronous edit. While the lock is held for the editor's current file, both `markDirty` and `saveCurrentFile` bail — a keystroke or autosave during the pull window can't upload a pre-pull buffer back over what just arrived. Other files save freely.

**Conflict policy.** "Most recent wins" with the Versions panel as a safety net. The cursor consumer pulls remote changes; local writes overwrite remote changes that occurred since the last cursor. Anything overwritten can be recovered from version history.

> **Note on image sync.** Doc images round-trip through Dropbox: the manifest emits each image node as `Images/<filename>` (the `Images/` prefix mirrors the pinned `__images__` folder), the cursor consumer recognises image extensions and dispatches them to `applyCreated` (image branch), and `performInitialSync` uploads existing images via `uploadBinary`. Bytes flow through `save_image_bytes` and `load_image_bytes` Tauri commands so we never base64-round-trip them. Sync metadata uses the same `synced_files` table as documents — for images the `internal_id` is the filename and `last_synced_hash` is `SHA256(bytes)`. Image binaries are treated as immutable per filename (collisions auto-suffix at save time), so the cursor consumer's `onContentChanged` skips them.
>
> **Local Sync uses a different model:** sibling-file resolution. A `.md` file mounted via Local Sync references images that live next to it on disk (`![](cow.png)` resolves to `<mount>/<dir>/cow.png`), not to the global Hush Images store. `local_sync.rs::SUPPORTED_EXTENSIONS` accepts standard image extensions so PNG/JPG/etc. surface in the sidebar listing alongside `.md` files; `local_sync_read_file_bytes` and `local_sync_write_file_bytes` (the latter auto-suffixes on collision) handle the binary IO. Image refs are resolved through a "source context" plumbed into the editor: `getImageDataUrl(filename, context)` and `isLocalImageRef(state, url, context)` accept an optional `{ kind: "localSync", folderId, baseDir }` shape, and `createImageDecoratorPlugin(state, getContext)` threads a per-editor resolver so the main editor reads `state.currentLocalSync` while pane editors read their own `pane.localSync`. The cache key in `state-images.js::dataUrlCache` incorporates the context so a sibling `cow.png` doesn't shadow the global one. Image drops into a Local Sync doc go through `editor/file-drop.js::insertImagesAtDrop`, which writes the binary as a sibling file via `writeFileBytes` and inserts a relative ref. Sidebar image rows skip the text-editor open path and instead show a hover preview / open the preview modal on click — both read through the same context-aware `getImageDataUrl`.

### Local Sync (`sync/local-sync.js`, Rust `sync.rs` watchers)

Desktop-only direct-filesystem folder mounting. A **Local Sync** section in Settings > Sync (rendered below the Dropbox Sync controls) exposes an **Add folder** button plus a list of currently mounted folders. Each mounted folder appears in the files panel as a top-level node with its own icon — a circle bisected by a horizontal line — distinct from regular folders and from the Dropbox root.

Local Sync folders are **outside the internal version-control system**: their contents are not copied into `{data_dir}/files/`, they do not receive `fileId`s in the SQLite snapshot DB, and `snapshots.rs` is never consulted for them. The tree node type for a Local Sync root is `local-sync`; children are resolved lazily from disk on expand. Reads and writes go through Tauri file-system commands (`tauri-plugin-fs`) using the stored absolute path.

**Watchers.** Each mounted folder registers a `notify`-crate watcher in Rust (reusing the infrastructure added for external sync). File-system events emit a `local-sync-changed` Tauri event that the frontend listens to; on receipt, the affected subtree is re-read and the sidebar node is re-rendered. If the currently-open document lives under that subtree, its buffer is updated in place (preserving selection/scroll when the incoming content was produced by the Hush write itself — guarded by a short write-origin flag).

**Unsync behavior.** Removing a Local Sync entry detaches the watcher, removes the root node from the tree, and is strictly non-destructive on disk: no files are deleted, renamed, or modified. This is the key invariant that separates Local Sync from Dropbox Sync's unsync flow (which offers a "keep or remove" choice).

**Settings.** `AppSettings.local_sync_folders: Vec<LocalSyncFolder>` — each entry carries `{ id, path, name, added_at }`. The list persists across restarts; watchers are re-armed on startup. Paths are stored verbatim (not made relative) since the feature is desktop-only and assumes the mount location is stable.

### Multiple Windows (`multi-window.js` + `src-tauri/src/multi_window.rs` + `commands/multi_window.rs`)

Desktop-only. The command palette's **Open in new window** entry calls `openInNewWindow(fileId, fileType)`, which spawns a fresh `WebviewWindow` whose URL hash carries the file the user was viewing (`index.html#file=<id>&type=<type>`). The new window's `state.init()` reads the hash via `getInitialFileFromHash()` and seeds `currentFileId` / `currentNotebookFileId` / `currentProjectId` from it instead of restoring `lastFileId` from settings.

**Window registry.** A small Rust-side `WindowRegistry` (`Mutex<HashMap<label, WindowInfo>>` where `WindowInfo = { label, number, fileId, fileType }`) lives on the managed `AppState`. Each window calls `register_window` on init to claim a sequential 1-indexed `number`, and `set_window_file` whenever its active file changes. `WindowEvent::Destroyed` (handled in `lib.rs::on_window_event`) drops the entry; the JS-side `beforeunload` handler also fires `unregister_window` so closed windows vanish from the badge layer immediately. After every mutation the registry emits `windows-updated` carrying the full sorted list, which `setupMultiWindow` patches into `state.windowList` and re-emits as `windows-changed` so `sidebar.js` re-renders the files panel.

**Per-window numeral badges.** When `state.windowList.length >= 2`, `files-panel.js::windowBadgesHtml` paints one `.tree-window-badge` chip per matching window beside each row. Documents and notebooks key off `fileId`; projects off the tree-node `id`. CSS sets `background: var(--fg); color: var(--bg)` so the chip inverts cleanly under whatever theme/style is active. The chip is a 3 px-radius rectangle, 9 px bold, sized to its digit so multi-digit numbers stay legible.

**Cross-window state sync.** `state.updateSettings` and `state.saveFileTree` call `_broadcastCrossWindow(kind)` after every disk write, which routes through the Rust `broadcast_state_change(kind, originator)` command. The originator label is embedded in the payload so each window can ignore its own echo. Receivers re-fetch fresh values from disk and apply them — but `setupMultiWindow.onStateChanged` re-pins this window's per-window keys (`lastFileId`, `lastNotebookId`, `lastProjectId`, `scrollPosition`, `typewriterMode`, `dryMode`) on top of the merge so a sibling can't blow away local session state.

**Live document + notebook sync.** Two further Rust commands — `broadcast_doc_changed(fileId, content, originator)` and `broadcast_notebook_changed(fileId, content, originator)` — fan editor buffers across windows. `setupMultiWindow` listens to `doc-content-changed` (fired by the patched `markDirty` on every keystroke) and broadcasts the latest editor content debounced at 250 ms; the notebook side rides the existing 2 s autosave by re-emitting the `saveNotebook()` envelope through `notebook-cross-window-broadcast`. Receivers run `applyRemoteDocChange` (selection-preserving `setContent` under the existing pull lock) and `applyRemoteNotebookChange` (`reloadNotebookShapes`) — both wrapped in `acquirePullLock` / `releasePullLock` so the resulting `docChanged` round-trip can't loop back through the broadcaster. Conflict policy is last-write-wins; OT/CRDT is out of scope.

**Setup ordering matters.** `setupMultiWindow` subscribes to every cross-window event *before* it calls `register_window` / `set_window_file`, so the broadcasts those calls trigger feed back through the same pipe and populate `state.windowList` without a separate `fetchWindowList` round-trip — which previously left this window's own entry stale after the initial push.

**Per-window settings persistence.** `state.isSecondaryWindow` flips on for any window whose label isn't `"main"`. In `updateSettings`, secondary windows skip the disk write entirely when the partial only touches per-window keys; on shared-key writes they read fresh per-window values from disk and overlay them onto what they save, so a child window's `Open file` doesn't clobber the main window's `lastFileId`. The main window keeps its existing "overwrite full settings" behaviour.

**Capabilities.** `src-tauri/capabilities/default.json` widens its `windows` allow-list from `["main", "settings"]` to `["main", "settings", "window-*"]` — the glob covers every secondary editor window, all of which are spawned with a `window-<uuid>` label.

### Tauri Bridge (`tauri-bridge.js`)

Global shortcut registration via `@tauri-apps/plugin-global-shortcut`. Shortcuts registered on startup and re-registered on settings change. Old shortcuts unregistered first.

### Settings Window (`settings/`)

Runs in a separate Tauri WebviewWindow (desktop) or modal overlay (iOS). Loads/saves settings via IPC, notifies main window via events.

**Tabs:** General (color scheme, visibility, always-on-top, tooltips, iOS Touch mode), Editor (themes, fonts, headers, panes — pane shift direction lives here, footnotes, typewriter, sizes), Shortcuts (customizable with conflict detection), D.R.Y. (detection range, stopwords), Proofread (per-rule checkboxes for harper-core), Flags (outline view settings), Privacy (blackout vs dummy mode, dummy text input), Sync (Dropbox OAuth connect/disconnect, folder selection, sync preview, unsync with keep/remove), Zotero (API credentials, reference management, PDF snapshot render/display heights + WebP quality).

**iPad detection.** `isIOSSettings()` (and `isIOS` in `settings-ui.js`, `isIOSDevice` in `cmd-button.js`) accepts any platform whose userAgent matches `iPad|iPhone|iPod`, OR whose `navigator.platform` matches `Mac` AND `navigator.maxTouchPoints > 0`. The `> 0` threshold is intentional — iPadOS 13+ reports as Macintosh and some WKWebView versions only expose a single touch point even though the device handles multi-touch fine; real Macs always expose `0`.

**Pane direction.** `Settings > Editor > Panes` carries both `makeSpaceForPanes` (existing) and `makeSpaceDirection` ("right" default | "left"). When a doc pane is visible and the layout has room, `editor/modes.js::applyColumnLayout` shifts the editor column away from the chosen side so the panes can slide in from the opposite edge.

**Header underline.** `Style.underlineHeaders` (and the global `underlineHeaders` setting for the Default style) flows through `getMarkdownHighlight(nh, color, scale, { underline })` as `text-decoration: underline` on every heading tag. The style modal previews it live alongside the colour and size sliders. The header colour override path (`resolveHeaderColorOverride`) was simplified at the same time so a colour set on the Default style (which lives in `defaultLightColors` / `defaultDarkColors`) actually applies to the editor — it had previously been preview-only.

Tab rendering is split into `settings-tabs.js` to keep file sizes under 700 lines. The three largest tabs were lifted further into siblings — `settings-tabs-shortcuts.js` (categories, conflict detection, search-filtered render), `settings-tabs-sync.js` (Dropbox states + Local Sync), and `settings-tabs-zotero.js` (credentials, references, PDF snapshot tuning). `settings-tabs.js` re-exports them so `settings-window.js` can keep its single barrel import.

### Themes (`themes/`)

Each built-in theme lives in its own file under `src/themes/` (e.g. `dracula.js`, `ayu-light.js`). The data was lifted out of the `thememirror` npm package — the dependency is gone, and adding or tuning a theme is now a one-file edit. Each file calls a local `createTheme({ variant, settings, styles })` helper (`_create-theme.js`) that wraps `EditorView.theme()` + `HighlightStyle.define()` exactly as thememirror used to.

`settings` carries the seven CodeMirror surface colours (`background`, `foreground`, `caret`, `selection`, `lineHighlight`, `gutterBackground`, `gutterForeground`). `styles` is intentionally minimal — only `t.comment` is preserved so HTML comments inside markdown still get a theme-tinted colour. The long tail of language-mode tags (keyword, typeName, className, etc.) was dropped during extraction; Hush is markdown-only, so the only affected surface is fenced-code-block syntax (which now renders in the foreground colour). Markdown-token typography (heading colour, bold, italic, link underline, etc.) is owned by `getMarkdownHighlight()` in `editor/editor.js`, layered on top.

`themes/index.js` exports the `themeList` array of `{ id, name, type, extension, headingColor }` and the `getActiveTheme()` resolver, which considers the active style's theme overrides and the current appearance setting.

**Light:** Ayu Light, Clouds, Noctis Lilac, Rose Pine Dawn, Solarized Light, Smoothy
**Dark:** Amy, Barf, Bespin, Birds of Paradise, Boys and Girls, Cobalt, Cool Glow, Dracula, Espresso, Tomorrow

### CSS Structure

Per-module CSS files under `src/styles/`, imported via `src/styles/main.css`:

`base.css`, `editor.css`, `sidebar.css`, `files-panel.css`, `styles-panel.css`, `longview.css`, `versions-panel.css`, `ratchet.css`, `private-mode.css`, `typewriter.css`, `find-replace.css`, `footnotes.css`, `focus-mode.css`, `dry-highlight.css`, `callouts.css`, `file-drop.css`, `zotero.css`, `sync-conflict.css`, `sortable-list.css`, `project-view.css`, `settings-modal.css`, `sticky-headers.css`, `command-palette.css`, `notebook.css`, `floating-pane.css`, `image-preview.css`, `proofreading.css`, `utility.css`.

The settings window has its own standalone `src/settings/settings-window.css` since it runs in a separate WebviewWindow.

**Design tokens.** `base.css` defines the cross-cutting token set: appearance colours (`--bg`, `--fg`, `--cursor`, `--accent`, panel + sidebar variants per theme), typography (`--font-family`, `--font-size`, `--line-height`, `--padding`, `--column-width`), and a documented z-index scale:

```
--z-pane: 90            floating reference panes above editor content
--z-shelf: 150          notebook shelf panel
--z-sidebar: 200        left sidebar column + floating toggle
--z-overlay: 300        find-replace, action sheets, sidebar tooltip
--z-popover: 400        footnote popover, command palette, image hover
--z-modal: 500          full-screen modal backdrops + standard modals
--z-modal-content: 510  modal content layer above its own backdrop
--z-modal-top: 9999     dropdowns above modals (ratchet duration grid,
                        zotero search, sync conflict, swatch picker)
--z-modal-topmost: 10001 footnote popover above an open style modal
--z-drag-ghost: 2147483647  text-drag chip; must escape every stacking context
```

Per-component literals (1, 5, 10, 80, 89, 95, 100, 101, 250) are local stacking-context tweaks and stay as numbers. Anything modal or higher must use a token. The settings window duplicates the small subset it needs (`--z-modal-top`) since it runs in its own WebviewWindow without `base.css`.

## Backend (Rust)

### `lib.rs` — Core

Defines the Tauri app setup:

- **AppState** — `Mutex<AppSettings>` + `Mutex<FileManager>` + `Mutex<ImageManager>` + `Mutex<SnapshotManager>` + `Mutex<SyncManager>` + `Mutex<ZoteroManager>` + `LocalSyncManager`, managed by Tauri's state system
- **Top-level types** — `FileEntry`, `TreeNode` (the wire shapes the JS frontend sees)
- **`run()`** — plugin registration, state setup, deep-link listener, tray icon + menu wiring, window-close hide behaviour, the `invoke_handler!` list
- **macOS activation policy** — `Regular` (dock) or `Accessory` (menu bar only) based on `visibility` setting

### `atomic.rs` — Atomic file writes

Tiny helper used by every long-lived JSON / binary store. `write_atomic(&Path, &[u8])` and `write_atomic_str(&Path, &str)` both write to `<path>.tmp` in the same directory, `sync_all()` to flush dirty buffers, then `fs::rename` (atomic on the same filesystem). Worst case on crash or power loss is "the previous version" — never a partial write. Used by `files.rs` (`save_file_tree`, `create_file`, `save_file`, `rename_file`), `settings.rs::save`, `images.rs::save_from_data_url`, `sync.rs` (sync map + external folder writes + project metadata), `local_sync.rs::write_file`, and `zotero.rs::save_references`.

### `commands/` — Tauri command surface

Command handlers are grouped by domain. Each module exports `pub fn` items decorated with `#[tauri::command]`; `lib.rs::run()` references them as `commands::<group>::<name>` in the `invoke_handler!` list.

- **`commands/settings.rs`** — `get_settings`, `save_settings`
- **`commands/files.rs`** — file CRUD + tree ops + project/notebook creation. Owns the `NotebookCreated` wire shape returned by `create_notebook`
- **`commands/images.rs`** — image CRUD, `export_with_images`, `write_binary_file` + path normalization helpers (iOS `file://` URLs, percent-decoding). `save_image_bytes` and `load_image_bytes` are the raw-byte siblings used by the Dropbox sync layer to upload / download image binaries without round-tripping through a base64 data URL. `write_binary_file` also runs `ensure_path_in_safe_root()` — defence-in-depth on top of the dialog plugin's access controls — that requires absolute paths under home / data / cache / temp dirs (plus `/private/var/folders` on macOS) and rejects literal `..` components
- **`commands/snapshots.rs`** — `create_snapshot`, `get_snapshot`, `get_snapshots`, `delete_document_snapshots`
- **`commands/local_sync.rs`** — `local_sync_add` / `_remove` / `_list` / `_read_dir` / `_read_file` / `_write_file` / `_read_file_bytes` / `_write_file_bytes`. The byte variants surface image binaries that live next to a Local Sync `.md` file (`_write_file_bytes` auto-suffixes on collision, mirroring `ImageManager::unique_filename`). Includes the local-only `find_local_sync_folder` helper and a small `uuid_like()` ID generator
- **`commands/zotero.rs`** — `save_zotero_references`, `load_zotero_references`, `save_zotero_pdf`, `load_zotero_pdf`, `zotero_pdf_exists`, `download_zotero_pdf` (server-side fetch + cache for the snapshot pipeline), `save_zotero_annotations`, `load_zotero_annotations` (Option-returning), `fetch_zotero_annotations` (server-side paginated fetch + cache for the highlight browser pane)
- **`commands/window.rs`** — `set_always_on_top` (desktop), `set_activation_policy`
- **`commands/backup.rs`** — `backup_app_data(destination)` zips the contents of `{data_dir}` into a single archive at the user-chosen path (using the `zip` crate, `Deflated` compression). `snapshots.db`, `.tmp`, and `.bak` files are excluded so the backup is self-contained authored content + settings + Zotero / sync metadata, not version history. Per-file progress is reported to the JS frontend via `app.emit("backup-progress", { processed, total, currentFile })`
- **`commands/grammar.rs`** — `check_grammar(text, disabled_rules)` is an `async` Tauri command that hops to the blocking thread pool via `tauri::async_runtime::spawn_blocking`, builds `LintGroup::new_curated(FstDictionary::curated(), Dialect::American)` over `Document::new_markdown_default_curated(&text)`, disables every rule named in `disabled_rules` via `LintGroup::config.set_rule_enabled(rule, false)`, and returns `Vec<GrammarIssue>` (`{ from, to, message, suggestions }`). The async + spawn_blocking shape keeps the JS UI thread free for the multi-second cold-start dictionary build — a sync command would freeze the WebView (beach ball cursor) and prevent the loading modal from painting. Spans are converted from harper's Unicode-scalar offsets to UTF-16 code-unit offsets so the JS frontend can apply them directly to CodeMirror positions without re-walking the buffer. `list_grammar_rules()` returns a curated rule list so the Proofread settings tab can render checkboxes without hard-coding rule names

`sync_commands.rs` (Dropbox / external sync) lives at the crate root rather than under `commands/` because it owns enough internal helpers to merit its own module.

### `settings.rs` + `settings/defaults.rs`

`AppSettings` struct with `serde rename_all = "camelCase"` for JS interop. All fields use `#[serde(default)]` for backward compatibility. Persisted as JSON at `{data_dir}/settings.json`. Default-value functions for the ~75 fields that need non-zero defaults (visibility, themes, shortcuts, notebook settings) live in `settings/defaults.rs` and are pulled in via `mod defaults; use defaults::*;` so `#[serde(default = "default_x")]` paths still resolve.

**Important:** Every setting used by the JS frontend must have a corresponding field in `AppSettings`. Serde silently drops unknown fields during deserialization, so missing fields cause settings to be lost on save/load round-trips.

Key fields beyond basics: `privacy_mode` (String: "blackout" or "dummy"), `dummy_text` (String), `block_cursor` (bool), `block_cursor_color` (Option), `sticky_headers` (bool), shortcut fields for all customizable bindings, notebook-specific fields (`notebook_background_pattern`, `notebook_grid_spacing`, `notebook_grid_opacity`, `notebook_font_size`, `shortcut_nb_*`).

`Style` struct: `{ id, name, theme_id, font_family, font_size, line_height, color_overrides, light/dark variants, block_cursor overrides, header suppression flags }`.

### `files.rs`

Files stored as individual JSON files (`{uuid}.json`) in `{data_dir}/files/`. Each: `{ id, name, content, modified }`.

**File tree:** `{data_dir}/file_tree.json`. Each `TreeNode`: `{ id, name, type, fileId?, children[] }` where type is `document`, `notebook`, `folder`, `project`, or `image`. Documents and notebooks have a `fileId` pointing to `files/{uuid}.json`; image nodes have a `fileId` pointing to `files/images/{uuid}.{ext}` (see `images.rs`). Auto-migrates from flat file list on first load.

`save_to_external()` writes `.md` to a user-chosen folder, tracking ID mappings in a `.hush/` subdirectory for Obsidian vault integration.

### `images.rs`

Binary image storage for the doc image feature. `ImageManager::save_from_data_url()` parses a `data:image/*;base64,...` payload and writes the raw bytes to `{data_dir}/files/images/{filename}`, keeping the caller-supplied filename as-is and auto-suffixing with ` (2)`, ` (3)`, ... on collision. The filename *is* the stable id: markdown refs use the bare filename (or a double-quoted URL when the filename contains spaces or parens) and the Rust `load_image` command reads directly by name. `save_from_data_url` and `save_from_bytes` share a private `save_bytes_with_mime` core; the latter is what Dropbox image sync calls so a downloaded binary can land without first being base64-encoded.

The Tauri command layer exposes `save_image` (data-URL ingest, returns the possibly-suffixed final filename), `save_image_bytes` (raw-byte ingest, used by Dropbox download path), `load_image` (returns a data URL), `load_image_bytes` (returns raw bytes, used by Dropbox upload path), `delete_image`, `rename_image` (renames on disk, auto-suffixes on collision, preserves the original extension if the new name drops it), `list_images`, and `export_with_images` (writes `text.md` + `images/<filename>` into a user-chosen folder).

### `snapshots.rs`

Document version history stored in SQLite (`{data_dir}/snapshots.db`). Creates timestamped snapshots of file content. Supports listing, loading, and restoring snapshots.

### `sync.rs`

External folder synchronization. Uses SHA256 hashing for change detection, file system watching via `notify` crate (FSEvents on macOS), and conflict detection when both local and external copies change. `SyncManager::hash_bytes` (and the parallel `register_image` / `update_image_hash` methods) extend the same `SyncedFileInfo` map to image binaries — the on-disk hash is just a hex string, so text and binary entries coexist without a discriminator. For images the `internal_id` field stores the filename (matching how the rest of the app addresses images) instead of a UUID.

### `zotero.rs`

Persists Zotero reference data, downloaded PDF binaries, and per-attachment annotation snapshots locally. References live in `{data_dir}/zotero_references.json` (offline citation search). PDFs land in `{data_dir}/zotero_pdfs/{itemKey}.pdf` keyed on a sanitised attachment id (alphanumeric + `-_` only) and are written via `write_atomic` so a crashed download leaves the previous copy intact. Annotations land in `{data_dir}/zotero_annotations/{attKey}.json` under the same sanitisation rule and the same atomic write path; the highlight browser pane reads cache-first and only re-fetches on explicit refresh. All three directories are local-only — they aren't part of any sync folder.

## Build

### Development

```sh
npm run tauri dev
```

Vite dev server on `:5173` with Tauri hot reload.

### Production

```sh
npm run tauri build
```

Vite builds to `dist/` (esbuild minification, ES2021/Safari 15+ target). Tauri bundles Rust binary with frontend.

### iOS

```sh
npm run ios:init    # Initialize Xcode project
npm run build:ios   # Build for iOS
```

Open the Xcode project to configure signing before building.

### Configuration

- **`vite.config.js`** — Two Rollup inputs (`index.html`, `settings.html`), port 5173, ES2021 target
- **`src-tauri/tauri.conf.json`** — App identifier `com.hushwriter.app`, transparent window, hidden title bar overlay, system tray, macOS private API, `dragDropEnabled: false`

## Data Storage

```
{data_dir}/com.hush.app/
├── settings.json
├── file_tree.json
├── snapshots.db
├── files/
│   ├── {uuid}.json
│   └── .hush/
├── zotero_references.json
├── zotero_pdfs/
└── zotero_annotations/
```

Platform paths:
- **macOS**: `~/Library/Application Support/com.hush.app/`
- **Linux**: `$XDG_DATA_HOME/com.hush.app/`

## Keyboard Shortcuts

All shortcuts are customizable in Settings > Shortcuts. Organized into three categories.

### General

| Action | Default |
|--------|---------|
| Toggle editor | `Cmd+Shift+H` (global) |
| Open fullscreen | `Cmd+Shift+F` (global) |
| Toggle private mode | `Cmd+Shift+P` (global) |
| Command palette | `Cmd+P` (hardcoded) |
| Toggle sidebar | `Cmd+\` |
| Toggle outline view | `Cmd+Shift+\` |
| Toggle typewriter mode | `Cmd+Shift+T` |
| Toggle D.R.Y. highlighting | `Cmd+Shift+R` |
| Toggle focus mode | `Cmd+Shift+Y` |
| Toggle Zen Focus | `Cmd+Shift+S` |
| Toggle word count | `Cmd+Shift+W` |
| New file | `Cmd+N` |
| Find / replace | `Cmd+F` |
| Find across files | `Alt+Shift+F` |
| Zotero search | `Cmd+Shift+I` |
| Open settings | `Cmd+,` (hardcoded) |

### Editing

| Action | Default |
|--------|---------|
| Select sentence | `Cmd+L` |
| Select paragraph | `Cmd+Shift+L` |
| Reduce sentence selection | `Alt+Shift+L` |
| Select next instance | `Cmd+D` |
| Select previous instance | `Cmd+Shift+D` |
| Jump to next sentence | `Cmd+Right` |
| Jump to previous sentence | `Cmd+Left` |
| Jump to next paragraph | `Cmd+Down` |
| Jump to previous paragraph | `Cmd+Up` |
| Shift selection next | `Cmd+Shift+Right` |
| Shift selection previous | `Cmd+Shift+Left` |
| Move sentence forward | `Alt+Cmd+Right` |
| Move sentence back | `Alt+Cmd+Left` |
| Delete to sentence end | `Alt+Shift+Backspace` |
| Join lines (pull up) | `Cmd+J` |

### Formatting

| Action | Default |
|--------|---------|
| Bold | `Cmd+B` |
| Italic | `Cmd+I` |
| Highlight | `Cmd+=` |
| Comment | `Cmd+/` |
| Strikethrough | `` Cmd+` `` |
| Insert footnote | `Cmd+Shift+M` |

### Notebooks

| Action | Default |
|--------|---------|
| Select tool | `1` |
| Text tool | `T` |
| Drag Area tool | `A` |
| Toggle Brainstorm | `B` |
| Delete selected | `Backspace` |
| Undo | `Cmd+Z` |
| Redo | `Cmd+Shift+Z` |
| Group shapes | `Cmd+G` |
| Ungroup shapes | `Cmd+Shift+G` |
| Pan canvas | `Space` (hold) |

Drawing tools (Lasso, Erase, Slice, brush slots) are reached through the always-visible top pill rather than keyboard shortcuts. Two-finger tap = undo, three-finger tap = redo, two-finger drag = pan. See [README-DRAWING.md](README-DRAWING.md).

## Tauri Plugins

- `tauri-plugin-global-shortcut` — System-wide keyboard shortcuts
- `tauri-plugin-positioner` — Window positioning (tray icon support)
- `tauri-plugin-dialog` — Native file/folder dialogs
- `tauri-plugin-fs` — File system read/write
- `tauri-plugin-shell` — Shell commands and URL opening (mailto, https, zotero://, obsidian://)
- `tauri-plugin-opener` — OS file/URL opener
- `tauri-plugin-deep-link` — Custom URL scheme handling (`hushwriter://`) for OAuth callbacks
