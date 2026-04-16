# Hush — Technical Overview

## Architecture

Hush is a [Tauri v2](https://v2.tauri.app/) desktop app with a vanilla JavaScript frontend and Rust backend. The editor is built on [CodeMirror 6](https://codemirror.net/) — no framework.

```
Frontend (src/)                        Backend (src-tauri/src/)
───────────                            ────────────────────
main.js                  ←──IPC──→     lib.rs (commands)
├── command-palette.js                 ├── settings.rs
├── theme-colors.js                    ├── files.rs
├── themes.js                          ├── snapshots.rs
├── tauri-bridge.js                    ├── sync.rs
├── zotero.js                          └── zotero.rs
│
├── editor/
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
│       ├── sticky-headers.js
│       └── typewriter.js
│
├── notebook/              (see README-NOTEBOOK.md)
│   ├── notebook-bridge.js
│   ├── notes-canvas.ts
│   ├── state.ts
│   ├── renderer.ts
│   ├── input-handler.ts
│   └── ui/
│       ├── toolbar.ts
│       ├── shelf-panel.ts
│       └── ...
│
├── pane/
│   ├── pane-manager.js
│   └── pane-editor.js
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

**Built-in fonts:** Source Sans Pro (default), Source Serif Pro, Libre Franklin, Libre Baskerville, Karla, Lora, EB Garamond, Inter, Fira Code, iA Writer Duo, iA Writer Mono, iA Writer Quattro, Helvetica (system). The iA Writer families are bundled from `src/assets/fonts/ia-writer-*` and registered via `src/styles/ia-writer-fonts.css`.

### State Management (`state/state.js`)

`AppState` is the single source of truth. It holds settings, file list, mode flags, and the editor reference. Uses a simple event emitter (`on`/`off`/`emit`) to notify UI of changes.

Key events: `mode-changed`, `fullscreen-changed`, `files-changed`, `file-opened`, `settings-changed`, `theme-changed`, `style-changed`, `style-preview`, `style-preview-end`, `show-files-panel`, `hide-panel`, `show-styles-panel`, `show-ratchet-dropdown`, `show-versions-panel`, `export-current-file`, `notebook-open`, `notebook-unmount`, `notebook-autosave`, `doc-content-changed`, `notebook-shapes-changed`.

**Notebook state:** When a notebook is open, `currentNotebookFileId` is set and `currentFileId` / `currentProjectId` are null. The notebook canvas has its own `DrawingState` (in `src/notebook/state.ts`), managed by `notebook-bridge.js`. See [README-NOTEBOOK.md](README-NOTEBOOK.md) for details.

On Tauri, state loads from the Rust backend via `invoke("get_settings")`, `invoke("list_files")`, and `invoke("get_file_tree")`. In the browser (dev without Tauri), it falls back to localStorage.

**File tree:** `AppState.fileTree` holds a nested tree of documents, folders, and projects. Each node: `{ id, type, name, fileId?, children[] }`. Persisted via `file_tree.json` (backend) or `localStorage` (web). Special nodes (Inbox, Trash) are auto-created if missing.

**Project state:** When a project is selected (`currentProjectId`), the editor shows all child documents joined by separator markers. `openProject()` loads and concatenates content; `saveProjectContent()` splits on separators and saves each part back.

Tree traversal utilities live in `state/tree-helpers.js` (`findNode`, `removeNode`, `collectDocumentIds`, `insertAfter`, etc.).

### Theme Colors (`theme-colors.js`)

Extracted from `main.js`. Contains `fontFallbacks` map, `themeBackgrounds` color table, `hexLuminance()`, `updatePrivateBoxColor()` (derives `--private-box`, `--theme-bg`, `--fg`, `--cursor`, panel colors from the active theme background), and `applyFontFamily()`.

### Editor (`editor/editor.js`, `editor/modes.js`)

The CodeMirror 6 instance is configured with:

- **Markdown language** with inline syntax highlighting (headings get scaled font sizes, syntax characters dimmed to 40% opacity)
- **Custom inline parsers** for `%%comments%%` and `==highlighted text==`
- **Heading indent plugin** — pulls `#` markers into the left margin via mark decorations (`position: absolute; right: 100%`) so heading text aligns with body text
- **Heading normalization** — optional setting to remove scaled heading sizes
- **Theme/highlight compartments** for live reconfiguration
- **Ratchet keymap** (`Prec.highest`) intercepting all deletion/navigation/selection keys when ratchet mode is active
- **Transaction filter** blocking deletions and non-end insertions in ratchet mode
- **Mouse filter** blocking mousedown in ratchet mode

**Plugins loaded:** private mode, D.R.Y. highlighting, footnotes, focus mode, callouts, project view (separators), flag highlighting, link decorator, heading indent, sticky headers, encourage typing.

**`createBaseExtensions(state, onChange)`** builds the shared extension set (theme, syntax highlighting, shortcuts, all plugins) used by both the main editor and floating pane editors. Returns compartment handles for theme, highlight, shortcut, and editable reconfiguration.

**`editor/modes.js`** contains mode application (`applyModes`, `applyFullscreen`), column width/resizer management (`updateColumnResizers`), and ratchet timer display (`updateRatchetTimer`). `applyModes` toggles CSS classes on `#app`: `ratchet-active`, `private-mode`, `typewriter-mode`, and `dummy-mode` (when private mode + dummy text is active).

Column width is managed by dynamically setting `paddingLeft`/`paddingRight` on `.cm-scroller`. Draggable resizer elements sit 10px outside the column edges. When the sidebar panel is open in inset mode, the column re-centers within remaining space.

### Command Palette (`command-palette.js`)

Centered overlay activated by `Cmd+P` (hardcoded in the fixed keymap). Lists all major commands with icons, labels, and keyboard shortcut keycaps. Supports arrow-key navigation, Enter to execute, Escape to dismiss, and text filtering.

Commands are context-sensitive: **shared** commands (New document, New notebook, Files, Styles, Toggle fullscreen, Settings, etc.) always appear; **doc-only** commands (Ratchet, Private mode, Typewriter, Show repeats, Highlight sentence, Outline view) are hidden when a notebook is open; **notebook-only** commands (Open shelf, Start brainstorm) appear only in notebook mode.

When toggle modes are active (ratchet, private, typewriter, D.R.Y., focus), "Turn off X" entries are prepended at the top of the list (doc mode only). Mouse hover selection is suppressed while keyboard-navigating to prevent conflicts.

### Sidebar (`sidebar/sidebar.js`)

Fixed 50px column on the left edge with icon buttons. Hidden by default (opacity 0, pointer-events none), revealed by a JS hover trigger. On viewports wider than 600px the side panel is simply open or closed — no pin button and no click-outside auto-close. On narrower viewports, the inset panel can still be pinned open.

**Buttons:** Files panel, Styles panel, Versions, Export, Settings (iOS only). Mode toggles (ratchet, private, typewriter, D.R.Y., focus, zotero) are accessed via the command palette (`Cmd+P`).

Panels render into `#panel-overlay`. Layout is responsive: when wide enough, panels inset beside content; otherwise they overlay as a modal.

### Files Panel (`sidebar/files-panel.js`)

Nested tree view with four node types:

- **Documents** — Markdown files. Click to open in the editor.
- **Notebooks** — Canvas-based visual notes. Click to open in the notebook view. See [README-NOTEBOOK.md](README-NOTEBOOK.md).
- **Folders** — Containers for organizing. Drag-and-drop reordering.
- **Projects** — Ordered containers whose children display as a single document with separators.

Four icon-only "New" buttons (Doc, Notebook, Folder, Project) at the top; the button type is surfaced via tooltip. All types share a hover menu (rename, duplicate, delete). Active item shown bold and underlined. Rendered via the `SortableList` component.

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

### Typewriter Mode (`editor/plugins/typewriter.js`)

Locks cursor to a fixed screen position (default 60% from top). Draggable boundary line for repositioning. Extra padding so first/last lines can reach the boundary. Also handles ratchet scroll (pins last line to 50% center).

### Project View (`editor/plugins/project-view.js`)

CodeMirror plugin for project mode. `createProjectViewField` (StateField) replaces `---hush-separator---` lines with non-editable dashed widgets. `createSeparatorFilter` (transactionFilter) blocks edits touching separator lines.

### File Drop (`editor/file-drop.js`)

Three context-aware drop targets. When the sidebar panel is open, an "Import file" overlay appears inside `#panel-overlay` — dropping creates a new document. In doc mode, drops on the editor append text content. In notebook mode, the canvas handles drops natively (images become image shapes, text files become text shapes). Tauri's built-in drag-drop is disabled so DOM events reach the webview.

### Floating Panes (`pane/`)

Draggable reference windows that float above the editor or notebook canvas. Created by Cmd-dragging a file from the sidebar files panel past the panel boundary into the editing area.

**`pane-manager.js`** — Core lifecycle: create, close, focus, collapse, resize, drag, autosave. Manages a `Map<id, pane>` of active panes with z-index stacking. Each pane stores an `ownerContext` string encoding the document/notebook/project that was active at creation time. On document switches (`file-opened`, `notebook-open`, `notebook-unmount`), non-pinned panes whose context doesn't match are hidden; when the user returns, they reappear.

**`pane-editor.js`** — Factory that calls `createBaseExtensions()` from `editor/editor.js` so pane editors share the identical plugin, shortcut, and theme setup as the main editor. Exposes `setEditable(bool)` via an `EditorView.editable` compartment — inactive panes are locked non-editable to prevent input leaks.

**Pane object:** `{ id, fileId, fileName, fileType, collapsed, attached, pinned, dirty, editor, notebook, el, width, height, x, y, ownerContext }`.

**Attach vs Pin:**

- **Attach** — Anchors the pane to content. In notebooks, converts screen position to canvas world coordinates and syncs every frame via `requestAnimationFrame`. In docs, records `scrollRelY` (pane Y + scrollTop) and updates on the editor's scroll event. Dragging a canvas-attached pane converts screen deltas to canvas deltas (dividing by zoom).
- **Pin** — Marks the pane as global (`.pinned` class, blue header). Pinned panes stay visible across all document switches. Unpinning triggers `onContextChange()` so the pane returns to its original context. Attach and pin are mutually exclusive — toggling one while the other is active shows a confirmation dialog.

**Duplicate** — Creates a new pane for the same file with `ownerContext` set to the current document (not the source's context). The duplicate check in `createPane` scopes by context, so the same file can have panes in different documents.

**Content sync:** Document panes fire `syncDocFromPane` on every `docChanged`, pushing content to the main editor if the same file is open (with `_syncPulling` flag to suppress `markDirty`). The reverse direction uses a `doc-content-changed` event from `main.js`. Notebook panes sync shapes via `loadShapes()` with a `_syncing` guard reset via double `queueMicrotask` to account for `DrawingState`'s batched change events.

**Input isolation:** The notebook's window `keydown` and document `paste` handlers skip processing when `document.activeElement` is inside a `.floating-pane`. Inactive pane content gets `pointer-events: none` via CSS, and the editor is set to non-editable. A window-level capture-phase `pointerdown` listener deactivates panes when clicking outside.

**Z-index layering:** `#pane-container` is `z-index: 90` (above editor content at 0–80, below sidebars at 100+). The notebook container has no z-index to avoid creating a stacking context, allowing the shelf panel (`z-index: 150`) to render above panes.

**Drag-from-sidebar integration:** `sortable-list/drag-drop.js` has an `onDragOutside(item, x, y)` callback. In `finishDrag`, when Cmd/Ctrl is held and the pointer is right of the panel overlay, the callback fires instead of the normal reorder drop. `files-panel.js` wires this to `createPane()`.

### Zotero Integration (`zotero.js`)

Citation management. Connects to Zotero API with user key, downloads references with progress tracking, caches locally. Search modal for finding and inserting citations.

### Dropbox Integration (`sync/dropbox.js`, `sync/dropbox-browser.js`)

Dropbox OAuth PKCE integration for syncing files. `dropbox.js` handles the full OAuth flow (authorize → token exchange → auto-refresh) and all Dropbox API operations via direct `fetch` calls (no SDK). `dropbox-browser.js` provides a folder browser modal for selecting the sync target folder. Build-time config via env vars: `VITE_DROPBOX_APP_KEY` (required) and `VITE_DROPBOX_REDIRECT_URI` (defaults to `hushwriter://auth/callback`, set to `http://localhost:5173/oauth-callback.html` for dev). The `oauth-callback.html` page relays the auth code to the `hushwriter://` deep-link scheme. Tokens are loaded on demand from settings (`ensureTokens()`) so they survive across window contexts.

### Sync (`sync/`)

Full-library Dropbox synchronization. All documents, folders, and projects are mirrored to a single Dropbox folder. Documents sync as `.md` files (named from document's first line, max 50 chars, special chars stripped). Projects sync as directories containing their child documents plus a `.hushproject` JSON metadata file with ordering. Folder merging handles special nodes (Inbox, Trash) by matching name and ID. Uses SHA256 hashing + timestamps for change detection with "most recent wins" conflict resolution. Polling runs every 10 seconds for content changes and every 60 seconds for structural diffs (new/deleted files). Sync log persists recent activity in settings. Sync is optional — users connect via OAuth in Settings > Sync and can disconnect at any time, choosing to keep or remove Dropbox files.

### Tauri Bridge (`tauri-bridge.js`)

Global shortcut registration via `@tauri-apps/plugin-global-shortcut`. Shortcuts registered on startup and re-registered on settings change. Old shortcuts unregistered first.

### Settings Window (`settings/`)

Runs in a separate Tauri WebviewWindow (desktop) or modal overlay (iOS). Loads/saves settings via IPC, notifies main window via events.

**Tabs:** General (visibility, always-on-top), Editor (appearance, themes, fonts, headers, footnotes, typewriter, sizes), Shortcuts (customizable with conflict detection), D.R.Y. (detection range, stopwords), Flags (outline view settings), Privacy (blackout vs dummy mode, dummy text input), Sync (Dropbox OAuth connect/disconnect, folder selection, sync preview, unsync with keep/remove), Zotero (API credentials, reference management).

Tab rendering is split into `settings-tabs.js` to keep file sizes under 700 lines.

### Themes (`themes.js`)

Wraps [thememirror](https://github.com/vadimdemedes/thememirror). Exports `themeList` array of `{ id, name, type, extension }`. `getActiveTheme()` resolves current theme considering active style overrides and appearance setting.

**Light:** Ayu Light, Clouds, Noctis Lilac, Rose Pine Dawn, Solarized Light, Smoothy
**Dark:** Amy, Barf, Bespin, Birds of Paradise, Boys and Girls, Cobalt, Cool Glow, Dracula, Espresso, Tomorrow

### CSS Structure

Per-module CSS files under `src/styles/`, imported via `src/styles/main.css`:

`base.css`, `editor.css`, `sidebar.css`, `files-panel.css`, `styles-panel.css`, `longview.css`, `versions-panel.css`, `ratchet.css`, `private-mode.css`, `typewriter.css`, `find-replace.css`, `footnotes.css`, `focus-mode.css`, `dry-highlight.css`, `callouts.css`, `file-drop.css`, `zotero.css`, `sync-conflict.css`, `sortable-list.css`, `project-view.css`, `settings-modal.css`, `sticky-headers.css`, `command-palette.css`, `notebook.css`, `floating-pane.css`, `utility.css`.

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

**Important:** Every setting used by the JS frontend must have a corresponding field in `AppSettings`. Serde silently drops unknown fields during deserialization, so missing fields cause settings to be lost on save/load round-trips.

Key fields beyond basics: `privacy_mode` (String: "blackout" or "dummy"), `dummy_text` (String), `block_cursor` (bool), `block_cursor_color` (Option), `sticky_headers` (bool), shortcut fields for all customizable bindings, notebook-specific fields (`notebook_background_pattern`, `notebook_grid_spacing`, `notebook_grid_opacity`, `notebook_font_size`, `shortcut_nb_*`).

`Style` struct: `{ id, name, theme_id, font_family, font_size, line_height, color_overrides, light/dark variants, block_cursor overrides, header suppression flags }`.

### `files.rs`

Files stored as individual JSON files (`{uuid}.json`) in `{data_dir}/files/`. Each: `{ id, name, content, modified }`.

**File tree:** `{data_dir}/file_tree.json`. Each `TreeNode`: `{ id, name, type, fileId?, children[] }` where type is `document`, `notebook`, `folder`, or `project`. Documents and notebooks both have a `fileId` pointing to `files/{uuid}.json` — documents store markdown text, notebooks store a JSON array of shapes. Auto-migrates from flat file list on first load.

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
| Command palette | `Cmd+P` (hardcoded) |
| Toggle sidebar | `Cmd+\` |
| Toggle outline view | `Cmd+Shift+\` |
| Toggle typewriter mode | `Cmd+Shift+T` |
| Toggle D.R.Y. highlighting | `Cmd+Shift+R` |
| Toggle focus mode | `Cmd+Shift+Y` |
| New file | `Cmd+N` |
| Find / replace | `Cmd+F` |
| Find across files | `Cmd+Shift+F` |
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

## Tauri Plugins

- `tauri-plugin-global-shortcut` — System-wide keyboard shortcuts
- `tauri-plugin-positioner` — Window positioning (tray icon support)
- `tauri-plugin-dialog` — Native file/folder dialogs
- `tauri-plugin-fs` — File system read/write
- `tauri-plugin-shell` — Shell commands and URL opening (mailto, https, zotero://, obsidian://)
- `tauri-plugin-opener` — OS file/URL opener
- `tauri-plugin-deep-link` — Custom URL scheme handling (`hushwriter://`) for OAuth callbacks
