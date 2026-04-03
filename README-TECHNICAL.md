# Hush — Technical Overview

## Architecture

Hush is a [Tauri v2](https://v2.tauri.app/) desktop app with a vanilla JavaScript frontend and Rust backend. The editor is built on [CodeMirror 6](https://codemirror.net/) — no framework.

```
Frontend (src/)                        Backend (src-tauri/src/)
───────────                            ────────────────────
main.js                  ←──IPC──→     lib.rs (commands)
├── themes.js                          ├── settings.rs
├── tauri-bridge.js                    ├── files.rs
├── zotero.js                          ├── snapshots.rs
│                                      ├── sync.rs
├── editor/                            └── zotero.rs
│   ├── editor.js
│   ├── modes.js
│   ├── formatting.js
│   ├── sentence-navigator.js
│   ├── find-replace.js
│   ├── file-drop.js
│   └── plugins/
│       ├── callouts.js
│       ├── dry-highlight.js
│       ├── encourage-typing.js
│       ├── focus-mode.js
│       ├── footnotes.js
│       ├── footnotes-ui.js
│       ├── link-decorator.js
│       ├── private-mode.js
│       ├── project-view.js
│       └── typewriter.js
│
├── sidebar/
│   ├── sidebar.js
│   ├── files-panel.js
│   ├── styles-panel.js
│   ├── versions-panel.js
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
│   ├── settings-tabs.js
│   └── settings-ui.js
│
├── state/
│   ├── state.js
│   ├── state-project.js
│   └── tree-helpers.js
│
├── sync/
│   ├── sync-state.js
│   ├── sync-polling.js
│   ├── dropbox.js
│   └── dropbox-browser.js
│
└── styles/                            (CSS, per-module)
```

Communication: `invoke` IPC for commands (settings, file CRUD) and `emit`/`listen` for events (settings updates, fullscreen toggle).

## Development Rules

**No code file may exceed 700 lines.** If a module grows past this limit, split it.

## Frontend

### Entry Points

- **`index.html`** — Main editor window. Loads `src/main.js`.
- **`settings.html`** — Settings window (separate Tauri WebviewWindow). Loads `src/settings/settings-window.js`.

Both are built by Vite as separate Rollup inputs.

### Fonts

Google Fonts are bundled locally via `@fontsource` npm packages. Font CSS is imported from `main.js` (JS imports, not CSS `@import`) so Vite resolves npm paths correctly.

**Built-in fonts:** Source Sans Pro (default), Source Serif Pro, Libre Franklin, Libre Baskerville, Karla, Lora, EB Garamond, Inter, Fira Code, Helvetica (system).

### State Management (`state/state.js`)

`AppState` is the single source of truth. It holds settings, file list, mode flags, and the editor reference. Uses a simple event emitter (`on`/`off`/`emit`) to notify UI of changes.

Key events: `mode-changed`, `fullscreen-changed`, `files-changed`, `file-opened`, `settings-changed`, `theme-changed`, `style-changed`, `style-preview`, `style-preview-end`, `show-files-panel`, `hide-panel`.

On Tauri, state loads from the Rust backend via `invoke("get_settings")`, `invoke("list_files")`, and `invoke("get_file_tree")`. In the browser (dev without Tauri), it falls back to localStorage.

**File tree:** `AppState.fileTree` holds a nested tree of documents, folders, and projects. Each node: `{ id, type, name, fileId?, children[] }`. Persisted via `file_tree.json` (backend) or `localStorage` (web). Special nodes (Inbox, Trash) are auto-created if missing.

**Project state:** When a project is selected (`currentProjectId`), the editor shows all child documents joined by separator markers. `openProject()` loads and concatenates content; `saveProjectContent()` splits on separators and saves each part back.

Tree traversal utilities live in `state/tree-helpers.js` (`findNode`, `removeNode`, `collectDocumentIds`, `insertAfter`, etc.).

### Editor (`editor/editor.js`, `editor/modes.js`)

The CodeMirror 6 instance is configured with:

- **Markdown language** with inline syntax highlighting (headings get scaled font sizes, syntax characters dimmed to 40% opacity)
- **Custom inline parsers** for `%%comments%%` and `==highlighted text==`
- **Heading normalization** — optional setting to remove scaled heading sizes
- **Theme/highlight compartments** for live reconfiguration
- **Ratchet keymap** (`Prec.highest`) intercepting all deletion/navigation/selection keys when ratchet mode is active
- **Transaction filter** blocking deletions and non-end insertions in ratchet mode
- **Mouse filter** blocking mousedown in ratchet mode

**Plugins loaded:** private mode, D.R.Y. highlighting, footnotes, focus mode, callouts, project view (separators), flag highlighting, link decorator, encourage typing.

**`editor/modes.js`** contains mode application (`applyModes`, `applyFullscreen`), column width/resizer management (`updateColumnResizers`), and ratchet timer display (`updateRatchetTimer`).

Column width is managed by dynamically setting `paddingLeft`/`paddingRight` on `.cm-scroller`. Draggable resizer elements sit 10px outside the column edges. When the sidebar panel is open in inset mode, the column re-centers within remaining space.

### Sidebar (`sidebar/sidebar.js`)

Fixed 50px column on the left edge with icon buttons. Hidden by default (opacity 0, pointer-events none), revealed by a JS hover trigger. Can be pinned open.

**Buttons:** New file, Files panel, Styles panel, Ratchet mode (duration dropdown), Private mode, Typewriter mode, D.R.Y. highlighting, Focus mode, Save location, Export, Outline view, Zotero search, Settings (iOS only).

Panels render into `#panel-overlay`. Layout is responsive: when wide enough, panels inset beside content; otherwise they overlay as a modal.

### Files Panel (`sidebar/files-panel.js`)

Nested tree view with three node types:

- **Documents** — Markdown files. Click to open.
- **Folders** — Containers for organizing. Drag-and-drop reordering.
- **Projects** — Ordered containers whose children display as a single document with separators.

Three "New" buttons (Doc, Folder, Project) at the top. All types share a hover menu (rename, duplicate, delete). Active item shown bold and underlined. Rendered via the `SortableList` component.

### Sortable List (`sidebar/sortable-list/`)

Drag-and-drop nested list engine (5 modules):

- **`sortable-list.js`** — Main class. API: `setData()`, `getData()`, `destroy()`, `render()`.
- **`rendering.js`** — Recursive DOM rendering with fold arrows and nested `<ul>` children.
- **`drag-drop.js`** — Pointer events, hold-to-drag (200ms), ghost element, hysteresis drop zones, auto-expand.
- **`keyboard-nav.js`** — Arrow key selection, M to enter/confirm move, Q to cancel.
- **`utils.js`** — Path parsing, comparison, ancestor checks, tree traversal.

### Styles Panel (`sidebar/styles-panel.js`)

Named presets combining theme, font, font size, line height, and color overrides (bg, fg, cursor, selection). Managed through the sidebar's Styles panel.

Style data: `{ id, name, themeId, fontFamily, fontSize, lineHeight, colorOverrides: { bg, fg, cursor, selection } }`.

Live preview on hover/edit via `style-preview` / `style-preview-end` events. Color overrides take precedence over theme colors, applied directly to CSS variables.

### Outline View / Longview (`longview/`)

Right-side panel showing document structure. Parses headings and flagged items from the document. Features: heading hierarchy navigation, flag detection, callout tinting, paragraph preview tooltips, customizable display options via a dedicated settings tab (Flags).

### Versions Panel (`sidebar/versions-panel.js`)

Document snapshot history viewer. Shows timestamped snapshots with content preview. One-click restore to revert to a previous version. Backend storage via `snapshots.rs`.

### Focus Mode (`editor/plugins/focus-mode.js`)

CodeMirror ViewPlugin that dims all text except the current sentence to 50% opacity. Uses sentence-boundary detection from `sentence-navigator.js`. On empty lines, all text is dimmed.

### Find & Replace (`editor/find-replace.js`)

Two modes:

- **`Cmd+F`** — Find/replace in current file. Floating bar with match count, prev/next, replace one/all. Pre-fills with selection.
- **`Cmd+Shift+F`** — Search across all files. Results grouped by file with line numbers, click to navigate. Debounced (200ms).

### Sentence Navigator (`editor/sentence-navigator.js`)

Sentence-level navigation and editing, ported from [obsidian-sentence-navigator](https://github.com/laffan/obsidian-sentence-navigator). Detects boundaries using punctuation rules (`.` `!` `?`) with closing delimiter handling.

Commands: `selectSentence`, `reduceSentenceSelection`, `jumpToNextSentence`, `jumpToPrevSentence`, `shiftSelectionToNextSentence`, `shiftSelectionToPreviousSentence`, `moveSentenceForward`, `moveSentenceBack`, `deleteToSentenceEnd`, `jumpToNextParagraph`, `jumpToPrevParagraph`.

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

ViewPlugin that replaces every non-whitespace character with an opaque box via CSS class. Also hides footnote decorations and marginalia.

### Typewriter Mode (`editor/plugins/typewriter.js`)

Locks cursor to a fixed screen position (default 60% from top). Draggable boundary line for repositioning. Extra padding so first/last lines can reach the boundary. Also handles ratchet scroll (pins last line to 50% center).

### Project View (`editor/plugins/project-view.js`)

CodeMirror plugin for project mode. `createProjectViewField` (StateField) replaces `---hush-separator---` lines with non-editable dashed widgets. `createSeparatorFilter` (transactionFilter) blocks edits touching separator lines.

### File Drop (`editor/file-drop.js`)

Handles `.md`/`.txt` files dragged into the app. Full-screen overlay with two zones: "Import file" (creates new document) and "Copy into current" (inserts text). Tauri's built-in drag-drop is disabled so DOM events reach the webview.

### Zotero Integration (`zotero.js`)

Citation management. Connects to Zotero API with user key, downloads references with progress tracking, caches locally. Search modal for finding and inserting citations.

### Dropbox Integration (`sync/dropbox.js`, `sync/dropbox-browser.js`)

Dropbox OAuth integration for syncing files. `dropbox-browser.js` provides a file/folder browser modal for selecting sync targets.

### Sync (`sync/`)

External folder synchronization (Obsidian vaults, custom folders). Uses SHA256 hashing + timestamps for change detection. File system watcher polling. Conflict detection with resolution modal UI.

### Tauri Bridge (`tauri-bridge.js`)

Global shortcut registration via `@tauri-apps/plugin-global-shortcut`. Shortcuts registered on startup and re-registered on settings change. Old shortcuts unregistered first.

### Settings Window (`settings/`)

Runs in a separate Tauri WebviewWindow (desktop) or modal overlay (iOS). Loads/saves settings via IPC, notifies main window via events.

**Tabs:** General (visibility, always-on-top), Editor (appearance, themes, fonts, headers, footnotes, typewriter, sizes), Shortcuts (customizable with conflict detection), D.R.Y. (detection range, stopwords), Flags (outline view settings), Sync (folder sync, Dropbox), Zotero (API credentials, reference management).

Tab rendering is split into `settings-tabs.js` to keep file sizes under 700 lines.

### Themes (`themes.js`)

Wraps [thememirror](https://github.com/vadimdemedes/thememirror). Exports `themeList` array of `{ id, name, type, extension }`. `getActiveTheme()` resolves current theme considering active style overrides and appearance setting.

**Light:** Ayu Light, Clouds, Noctis Lilac, Rose Pine Dawn, Solarized Light, Smoothy
**Dark:** Amy, Barf, Bespin, Birds of Paradise, Boys and Girls, Cobalt, Cool Glow, Dracula, Espresso, Tomorrow

### CSS Structure

Per-module CSS files under `src/styles/`, imported via `src/styles/main.css`:

`base.css`, `editor.css`, `sidebar.css`, `files-panel.css`, `styles-panel.css`, `longview.css`, `versions-panel.css`, `ratchet.css`, `private-mode.css`, `typewriter.css`, `find-replace.css`, `footnotes.css`, `focus-mode.css`, `dry-highlight.css`, `callouts.css`, `file-drop.css`, `zotero.css`, `sync-conflict.css`, `sortable-list.css`, `project-view.css`, `settings-modal.css`, `utility.css`.

The settings window has its own standalone `src/settings/settings-window.css` since it runs in a separate WebviewWindow.

## Backend (Rust)

### `lib.rs` — Core

Defines the Tauri app setup:

- **AppState** — `Mutex<AppSettings>` + `Mutex<FileManager>` + `Mutex<SnapshotManager>`, managed by Tauri's state system
- **Tauri commands** — `get_settings`, `save_settings`, `list_files`, `load_file`, `save_file`, `create_file`, `delete_file`, `rename_file`, `get_file_tree`, `save_file_tree`, `create_folder`, `create_project`, `load_project_content`, `check_obsidian_vault`, `set_always_on_top`, `set_activation_policy`, snapshot commands, sync commands, Zotero commands
- **System tray** — Menu with Toggle Editor, Fullscreen, Settings, Quit. Tray click toggles window.
- **macOS activation policy** — `Regular` (dock) or `Accessory` (menu bar only) based on `visibility` setting.
- **Window close behavior** — Main window hides on close; settings window closes normally.

### `settings.rs`

`AppSettings` struct with `serde rename_all = "camelCase"` for JS interop. All fields use `#[serde(default)]` for backward compatibility. Persisted as JSON at `{data_dir}/settings.json`.

`Style` struct: `{ id, name, theme_id, font_family, font_size, line_height, color_overrides }`.

### `files.rs`

Files stored as individual JSON files (`{uuid}.json`) in `{data_dir}/files/`. Each: `{ id, name, content, modified }`.

**File tree:** `{data_dir}/file_tree.json`. Each `TreeNode`: `{ id, name, type, fileId?, children[] }` where type is `document`, `folder`, or `project`. Auto-migrates from flat file list on first load.

`save_to_external()` writes `.md` to a user-chosen folder, tracking ID mappings in a `.hush/` subdirectory for Obsidian vault integration.

### `snapshots.rs`

Document version history stored in SQLite (`{data_dir}/snapshots.db`). Creates timestamped snapshots of file content. Supports listing, loading, and restoring snapshots.

### `sync.rs`

External folder synchronization. Uses SHA256 hashing for change detection, file system watching via `notify` crate (FSEvents on macOS), and conflict detection when both local and external copies change.

### `zotero.rs`

Persists Zotero reference data locally for offline citation search.

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
└── zotero/
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
| Toggle sidebar | `Cmd+\` |
| Toggle outline view | `Cmd+Shift+\` |
| Toggle typewriter mode | `Cmd+Shift+T` |
| Toggle D.R.Y. highlighting | `Cmd+Shift+R` |
| Toggle focus mode | `Cmd+Shift+Y` |
| New file | `Cmd+N` |
| Find / replace | `Cmd+F` |
| Find across files | `Cmd+Shift+F` |
| Zotero search | `Cmd+Shift+Z` |
| Open settings | `Cmd+,` (hardcoded) |

### Editing

| Action | Default |
|--------|---------|
| Select sentence | `Cmd+L` |
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

### Formatting

| Action | Default |
|--------|---------|
| Bold | `Cmd+B` |
| Italic | `Cmd+I` |
| Highlight | `Cmd+=` |
| Comment | `Cmd+/` |
| Strikethrough | `` Cmd+` `` |
| Insert footnote | `Cmd+Shift+M` |

## Tauri Plugins

- `tauri-plugin-global-shortcut` — System-wide keyboard shortcuts
- `tauri-plugin-positioner` — Window positioning (tray icon support)
- `tauri-plugin-dialog` — Native file/folder dialogs
- `tauri-plugin-fs` — File system read/write
- `tauri-plugin-shell` — Shell commands and URL opening (mailto, https, zotero://, obsidian://)
- `tauri-plugin-opener` — OS file/URL opener
