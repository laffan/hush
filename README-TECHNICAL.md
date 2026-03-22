# Hush — Technical Overview

## Architecture

Hush is a [Tauri v2](https://v2.tauri.app/) desktop app with a JavaScript frontend and Rust backend. The frontend uses [CodeMirror 6](https://codemirror.net/) for the editor and vanilla JS for everything else — no framework.

```
Frontend (JS/CSS)          Backend (Rust/Tauri)
─────────────────          ────────────────────
main.js          ←──IPC──→ lib.rs (commands)
├── editor.js              ├── settings.rs
├── sidebar.js             └── files.rs
├── state.js
├── tauri-bridge.js
├── files-panel.js
├── project-view.js
├── sortable-list/
│   ├── sortable-list.js
│   ├── rendering.js
│   ├── drag-drop.js
│   ├── keyboard-nav.js
│   └── utils.js
├── settings-ui.js
├── settings-window.js
├── settings-window.css
├── themes.js
├── find-replace.js
├── private-mode.js
├── focus-mode.js
├── dry-highlight.js
├── sentence-navigator.js
├── footnotes.js
├── formatting.js
└── file-drop.js
```

The frontend and backend communicate via Tauri's `invoke` IPC for commands (settings, file CRUD) and `emit`/`listen` for events (settings updates, fullscreen toggle).

## Development Rules

There is a STRICT rule that no code file may be longer than 700 lines.

## Frontend

### Entry Points

- **`index.html`** — Main editor window. Loads `src/main.js`.
- **`settings.html`** — Settings window (separate Tauri WebviewWindow). Loads `src/settings-window.js`.

Both are built by Vite as separate Rollup inputs.

### Fonts

Google Fonts are bundled locally via `@fontsource` npm packages for offline use. Font CSS is imported from `main.js` (JS imports, not CSS `@import`) so Vite can resolve npm package paths correctly.

**Built-in fonts:** Source Sans Pro (default), Source Serif Pro, Libre Franklin, Libre Baskerville, Karla, Lora, EB Garamond, Inter, Fira Code, Helvetica (system).

Font fallback chains are defined in `main.js` via the `fontFallbacks` object.

### State Management (`state.js`)

`AppState` is the single source of truth. It holds settings, file list, mode flags, and the editor reference. It uses a simple event emitter pattern (`on`/`off`/`emit`) to notify the UI of changes.

Key events: `mode-changed`, `fullscreen-changed`, `files-changed`, `file-opened`, `settings-changed`, `theme-changed`, `style-changed`, `style-preview`, `style-preview-end`, `show-files-panel`, `hide-panel`.

On Tauri, state loads from the Rust backend via `invoke("get_settings")`, `invoke("list_files")`, and `invoke("get_file_tree")`. In the browser (dev without Tauri), it falls back to localStorage.

**File tree state:** `AppState.fileTree` holds the nested tree of documents, folders, and projects. Each node has `{ id, type, name, fileId?, children[] }`. The tree is persisted via `file_tree.json` (backend) or `localStorage` (web). Methods: `createFolder()`, `createProject()`, `deleteTreeNode()`, `renameTreeNode()`, `duplicateTreeNode()`, `saveFileTree()`.

**Project state:** When a project is selected (`currentProjectId` is set), the editor shows all documents in the project joined by separator markers. `projectDocIds` tracks the ordered document file IDs. `openProject()` loads and concatenates content; `saveProjectContent()` splits on separators and saves each part back to its file.

### Editor (`editor.js`)

The CodeMirror 6 instance is configured with:

- **Markdown language** with inline syntax highlighting via `HighlightStyle` (headings get scaled font sizes, syntax characters are dimmed to 40% opacity)
- **Custom inline parsers** for `%%comments%%` (dimmed to 40% opacity) and `==highlighted text==` (yellow background)
- **Heading normalization** — `normalizeHeaders` setting removes scaled heading sizes, keeping only font weight
- **Theme compartment** for live theme swapping without recreating the editor
- **Highlight compartment** for reconfiguring heading styles on settings change
- **Ratchet keymap** (`Prec.highest`) that intercepts all deletion, navigation, selection, undo, redo, and cut keys when ratchet mode is active
- **Global keymap** for Cmd+,, Cmd+Shift+P, Cmd+\, Cmd+T, Cmd+Shift+R, Cmd+Shift+Y, Cmd+Up/Down, Cmd+N, Cmd+F, Cmd+Shift+F, Cmd+D, plus sentence navigation and formatting shortcuts (see below)
- **Transaction filter** that blocks deletions and non-end insertions in ratchet mode
- **Mouse filter** that blocks mousedown in ratchet mode
- **Private mode plugin** (ViewPlugin) that decorates every non-whitespace character with a CSS class. Also hides footnote decorations and marginalia.
- **D.R.Y. highlighting plugin** (ViewPlugin) that highlights repeated words/phrases within a configurable range
- **Focus mode plugin** (ViewPlugin) that dims all text except the current sentence to 50% opacity
- **Footnote plugin** (ViewPlugin) that decorates `[^id]` references with colored dots or underlines, and shows definitions as overlays or marginalia
- **Typewriter mode** — locks cursor to a fixed screen position (default 60% from top). A draggable boundary line lets the user reposition. Extra padding is added so the first/last line can reach the boundary.
- **Ratchet scroll** — pins the current (always last) line to vertical center (50%) of the window

Column width is managed by dynamically setting `paddingLeft`/`paddingRight` on `.cm-scroller`. Draggable resizer elements are positioned 10px outside the column edges. After any padding change, `view.requestMeasure()` is called so CodeMirror reflows all lines. When the sidebar panel is open in inset mode, the column re-centers within the remaining space.

### Sidebar (`sidebar.js`)

The sidebar is a fixed 50px column on the left edge with icon buttons. It's hidden by default (`opacity: 0; pointer-events: none`) and revealed by a JS hover trigger element appended inside `#app`. It can be pinned open with Cmd+\.

**Buttons (top to bottom):**
- New file — creates a file and closes any open panel
- Files — opens the file tree panel
- Styles — opens the styles panel
- Ratchet mode — shows a duration dropdown (5–30 min), toggles off if active
- Private mode — toggles private mode
- Typewriter mode — toggles typewriter mode
- D.R.Y. highlighting — toggles repeated-word highlighting
- Focus mode — toggles focus mode (crosshair icon)
- Save location — opens the autosave/Obsidian panel
- Export — exports the current file/project as `.md` via native save dialog. For projects, separator markers are replaced with `---` for a clean export.
- Settings — (iOS only) opens settings as a modal overlay

Panels (file tree, styles, autosave settings) render into `#panel-overlay`, a fixed div to the right of the sidebar. The panel layout is responsive: when the window is wide enough (sidebar + panel ≤ available padding), the panel insets beside the content; otherwise it overlays as a modal.

### Files Panel (`files-panel.js`)

Replaces the former flat file list with a nested tree view supporting three node types:

- **Documents** (portrait rectangle icon) — Markdown files, same as before. Click to open in editor.
- **Folders** (circle icon) — Containers for organizing documents, projects, and other folders. Drag-and-drop to reorder. Deleting shows a confirmation modal listing all contents.
- **Projects** (triangle icon) — Opinionated folders with ordered contents. Click to open in the editor, which shows all child documents as a single document with dashed separators between them. The project tracks document ordering. Export treats the project as one file.

The panel has three "New" buttons (Doc, Folder, Project) at the top. All three types share the same hover menu (rename, duplicate, delete). The active item is displayed bold and underlined. The tree is rendered via the `SortableList` component, enabling drag-and-drop reordering and nesting. Reordering documents within a project refreshes the editor to reflect the new order.

### Sortable List (`sortable-list/`)

A drag-and-drop nested list engine adapted from [ratchet-list-sort](https://github.com/laffan/ratchet-list-sort) and broken into sub-modules:

- **`sortable-list.js`** — Main `SortableList` class. Constructor accepts `data`, `renderItem`, `canNest`, `onChange`, `onClick` and other config. Public API: `setData()`, `getData()`, `destroy()`, `render()`.
- **`rendering.js`** — Recursive DOM rendering. Builds `<li>` elements with fold arrows, item labels, and nested `<ul>` children.
- **`drag-drop.js`** — Pointer event handlers. Implements hold-to-drag (200ms delay), ghost element, hysteresis-based drop zone detection (before/inside/after), auto-expand of collapsed containers, and parent highlighting. Clicks on interactive elements (buttons, inputs, links) inside items do not trigger `onClick`.
- **`keyboard-nav.js`** — Arrow key selection, M to enter/confirm move mode, Q to cancel. Collapse/expand with Left/Right.
- **`utils.js`** — Path parsing, comparison, ancestor checks, deep clone, tree traversal.

### Project View (`project-view.js`)

CodeMirror 6 plugin for project mode. When `state.currentProjectId` is set:

- **`createProjectViewField`** — `StateField` that finds `---hush-separator---` lines and replaces them with a `SeparatorWidget` (a non-editable dashed horizontal line). Uses `EditorView.decorations.from(field)` because block-level decorations require a `StateField`, not a `ViewPlugin`.
- **`createSeparatorFilter`** — `EditorState.transactionFilter` that blocks any edit that touches a separator line, preventing users from deleting or modifying separators.

Footnotes remain at the bottom of their respective sections (above the separator), preserving per-document footnote isolation.

### Styles (`sidebar.js`, `main.js`)

Styles are named presets that combine a theme, font, font size, line height, and optional color overrides (background, text, cursor, selection) into a single switchable configuration. They are managed entirely through the sidebar's Styles panel.

**Style data model:**
```
{ id, name, themeId, fontFamily, fontSize, lineHeight, colorOverrides: { bg, fg, cursor, selection } }
```

- **List view** — shows all saved styles plus a "Default" option. Click to activate, hover to live-preview.
- **Inline editor** — accordion-style form that opens below the "New Style" button or below the style being edited. Includes custom dropdowns for theme and font selection, sliders for size/height, and color pickers with reset buttons.
- **Live preview** — every form change emits a `style-preview` event that temporarily applies the style to the editor. On cancel or mouse-leave, `style-preview-end` restores the actual settings.
- **Color overrides** take precedence over theme colors. They're applied directly to CSS variables (`--bg`, `--fg`, `--cursor`, `--selection`) and the `.cm-editor` background.
- **Selection color** override controls both `::selection` and `.cm-selectionBackground` via the `--selection` CSS variable.
- **`applyActiveStyle()`** in `main.js` handles applying/removing style overrides, including theme switching, font changes, and color variable updates.

### Focus Mode (`focus-mode.js`)

A CodeMirror ViewPlugin that dims all text except the current sentence to 50% opacity. Uses the same sentence-boundary detection logic as `sentence-navigator.js`. Toggled via `Cmd+Shift+Y` or the crosshair sidebar icon. When the cursor is on an empty line, all text is dimmed.

### Find & Replace (`find-replace.js`)

Two search modes, both triggered from the editor keymap:

- **`Cmd+F`** — find/replace within the current file. Opens a floating bar with find input, prev/next buttons, match count, replace input, and replace one/all buttons. Pre-fills with current selection. Enter advances to next match, Escape closes.
- **`Cmd+Shift+F`** — find across all files. Opens a panel that searches all files (loading each via IPC), showing results grouped by file with line numbers. Clicking a result opens that file and navigates to the line. Search is debounced (200ms).

### Sentence Navigator (`sentence-navigator.js`)

Sentence-level navigation and editing commands for CodeMirror 6, ported from the [obsidian-sentence-navigator](https://github.com/laffan/obsidian-sentence-navigator) Obsidian plugin. The module is self-contained with no Obsidian dependencies.

**Core logic:** `findSentenceStart()` and `findSentenceEnd()` detect sentence boundaries within a single line using punctuation rules (`.` `!` `?`) and handle closing delimiters (`"` `)` `]` etc.) and trailing whitespace. Line/ch positions are used internally and converted to CM6 offsets at the API boundary.

**Exported commands** (each takes an `EditorView` and returns `true`):
- `selectSentence` — select the current sentence; repeat to expand by one sentence
- `reduceSentenceSelection` — shrink selection by one sentence from the tail
- `jumpToNextSentence` / `jumpToPrevSentence` — move cursor to the start of the next/previous sentence
- `shiftSelectionToNextSentence` / `shiftSelectionToPreviousSentence` — move the selection window to an adjacent sentence
- `moveSentenceForward` / `moveSentenceBack` — swap the current sentence with its neighbor (handles paragraph breaks by moving across them without swapping)
- `deleteToSentenceEnd` — delete from cursor to the end of the current sentence
- `jumpToNextParagraph` / `jumpToPrevParagraph` — jump cursor to the first word of the next/previous paragraph

### File Drop (`file-drop.js`)

Handles `.md` and `.txt` files dragged into the app window. When a file is dragged over the app, a full-screen overlay appears with two drop zones:

- **Import file** (left zone, 40%) — creates a new document with the file's content
- **Copy file into current** (right zone, fills remaining space) — inserts the file's text into the active document

Uses standard HTML5 drag-and-drop events. Tauri's built-in drag-drop handler is disabled (`dragDropEnabled: false` in `tauri.conf.json`) so that DOM events reach the webview. Global `dragover` and `drop` listeners on the document (capture phase) call `preventDefault()` to ensure the browser never navigates to a dropped file — which would replace the app content and look like a crash. The overlay is appended to `document.body` (not `#app`) so it renders above all app layers including the sidebar panel-overlay.

### Formatting (`formatting.js`)

Markdown formatting toggle commands. Uses a generic `toggleWrap(view, marker)` function that handles three cases:
1. **No selection** — inserts `marker + marker` with cursor between them
2. **Already wrapped** — detects markers immediately outside the selection (or inside if the selection includes them) and removes them
3. **Wrap** — wraps the selection with the marker on both sides

Exports: `toggleBold` (`**`), `toggleItalic` (`*`), `toggleHighlight` (`==`), `toggleComment` (`%%`), `toggleStrikethrough` (`~~`).

### Tauri Bridge (`tauri-bridge.js`)

Handles global shortcut registration via `@tauri-apps/plugin-global-shortcut`. Shortcuts are registered on startup and re-registered whenever settings change. Old shortcuts are unregistered first to avoid stale handlers.

### Settings Window (`settings-window.js`)

Runs in a separate Tauri WebviewWindow (desktop) or as a modal overlay (iOS/iPadOS). Loads settings via `invoke("get_settings")`, saves via `invoke("save_settings")`, and notifies the main window via `emit("settings-updated", settings)`. On iOS, the modal uses a direct callback instead of cross-window emit.

**Tabs:**
- **General** — visibility (menu bar / dock / both), always-on-top
- **Editor** — appearance (light/dark/auto), default light and dark themes, font family (10 built-in + system fonts), normalize headers toggle, footnote settings (font size, font family, colors, margin placement), font size (12–36px), line height (1.0–2.5)
- **Shortcuts** — all customizable shortcuts organized into three categories (General, Editing, Formatting) with conflict detection. Click a shortcut to record a new one; conflicts auto-swap.
- **D.R.Y.** — detection range (paragraph/two paragraphs/document), ignore proper nouns, include base word repeats, customizable stopwords list with search/add/remove/reset

### Themes (`themes.js`)

Wraps the [thememirror](https://github.com/vadimdemedes/thememirror) library. Exports a `themeList` array of `{ id, name, type, extension }` objects — 6 light themes and 10 dark themes. `getActiveTheme(settings)` resolves the current theme: if a style is active and has a `themeId`, that takes priority; otherwise it resolves based on appearance (light/dark/auto) and the user's default theme selection.

**Light:** Ayu Light, Clouds, Noctis Lilac, Rosé Pine Dawn, Solarized Light, Smoothy
**Dark:** Amy, Barf, Bespin, Birds of Paradise, Boys and Girls, Cobalt, Cool Glow, Dracula, Espresso, Tomorrow

### CSS Structure

CSS is organized into per-module files under `src/styles/`, imported via `src/styles/main.css`:

- `base.css` — reset, CSS variables, root theme definitions (light/dark/sepia)
- `editor.css` — CodeMirror editor styling, selection color, column resizers
- `sidebar.css` — sidebar and panel layout
- `files-panel.css` — files tree panel
- `styles-panel.css` — styles editor panel
- `ratchet.css` — ratchet mode timer and dropdown
- `private-mode.css` — private mode decorations
- `typewriter.css` — typewriter boundary line
- `find-replace.css` — find/replace dialog
- `utility.css` — utility classes
- `dry-highlight.css` — D.R.Y. highlighting styles
- `footnotes.css` — footnote styling
- `settings-modal.css` — settings modal (iOS)
- `sortable-list.css` — draggable list
- `project-view.css` — project view styling
- `focus-mode.css` — focus mode dim effect
- `file-drop.css` — file drag-and-drop overlay zones

The settings window has its own standalone stylesheet at `src/settings-window.css` (outside the `styles/` directory) since it runs in a separate WebviewWindow with its own DOM.

## Backend (Rust)

### `lib.rs` — Core

Defines the Tauri app setup:

- **AppState** — `Mutex<AppSettings>` + `Mutex<FileManager>`, managed by Tauri's state system
- **Tauri commands** — `get_settings`, `save_settings`, `list_files`, `load_file`, `save_file`, `create_file`, `delete_file`, `rename_file`, `get_file_tree`, `save_file_tree`, `create_folder`, `create_project`, `load_project_content`, `check_obsidian_vault`, `set_always_on_top`, `set_activation_policy`
- **System tray** — Menu with Toggle Editor, Fullscreen, Settings, Quit. Tray icon click toggles window visibility.
- **macOS activation policy** — Applied on startup based on the `visibility` setting. `Regular` shows in dock, `Accessory` hides from dock.
- **Window close behavior** — Main window hides on close (prevented via `CloseRequested`); settings window closes normally.

### `settings.rs`

`AppSettings` struct with serde `rename_all = "camelCase"` for JS interop. All fields have `#[serde(default)]` with named default functions for backward compatibility when new fields are added. Persisted as pretty-printed JSON at `{data_dir}/settings.json`.

`Style` struct stores style presets:
```rust
struct Style {
    id: String,
    name: String,
    theme_id: Option<String>,
    font_family: Option<String>,
    font_size: Option<u32>,
    line_height: Option<f64>,
    color_overrides: HashMap<String, String>,  // keys: "bg", "fg", "cursor", "selection"
}
```

`AppSettings` includes `styles: Vec<Style>` and `active_style_id: Option<String>` to track the user's style presets and current selection.

### `files.rs`

`FileManager` stores files as individual JSON files (`{uuid}.json`) in `{data_dir}/files/`. Each file contains id, name, content, and modified timestamp.

**File tree:** The tree structure (folders, projects, documents) is stored in `{data_dir}/file_tree.json`. Each `TreeNode` has `{ id, name, type, fileId?, children[] }` where `type` is `"document"`, `"folder"`, or `"project"`. On first load, if no tree exists, it auto-migrates from the flat file list.

**Tree operations:** `get_file_tree()`, `save_file_tree()`, `create_folder()`, `create_project()`. Tree helpers handle recursive insertion, lookup, and document collection.

**Project content:** `load_project_content()` finds a project node by ID, collects all descendant document file IDs in order, loads each, and returns them as an ordered `Vec<FileEntry>`.

`save_to_external()` writes a `.md` file to a user-chosen folder and tracks the ID mapping in a `.hush/` subdirectory. This enables Obsidian vault integration.

`derive_name()` extracts the first line (stripping markdown `#` prefixes) as the file name, truncated to 20 characters.

## Build

### Development

```sh
npm run tauri dev
```

Vite dev server on `:5173` with Tauri hot reload. Debug sourcemaps enabled via `TAURI_DEBUG`.

### Production

```sh
npm run tauri build
```

Vite builds to `dist/` (esbuild minification, ES2021 target, Safari 15+). Tauri bundles the Rust binary with the frontend.

### Configuration

- **`vite.config.js`** — Two Rollup inputs (`index.html`, `settings.html`), port 5173
- **`src-tauri/tauri.conf.json`** — App identifier `com.hushwriter.app`, transparent window, hidden title bar overlay, system tray icon, macOS private API enabled, `dragDropEnabled: false` for HTML5 file drop support

## Data Storage

```
{data_dir}/com.hush.app/
├── settings.json          # App settings (including styles array)
├── file_tree.json         # Tree structure (folders, projects, documents)
└── files/
    ├── {uuid}.json        # File entries (id, name, content, modified)
    └── .hush/             # External sync ID mappings
```

Platform paths:
- **macOS**: `~/Library/Application Support/com.hush.app/`
- **Linux**: `$XDG_DATA_HOME/com.hush.app/`

## Keyboard Shortcuts

All shortcuts are customizable in Settings > Shortcuts tab. Shortcuts are organized into three categories.

### General

| Action | Default | Scope |
|--------|---------|-------|
| Toggle editor | `Cmd+Shift+H` | Global (system-wide) |
| Open fullscreen | `Cmd+Shift+F` | Global |
| Toggle private mode | `Cmd+Shift+P` | Global / Editor |
| Toggle sidebar | `Cmd+\` | Editor |
| Toggle typewriter mode | `Cmd+T` | Editor |
| Toggle D.R.Y. highlighting | `Cmd+Shift+R` | Editor |
| Toggle focus mode | `Cmd+Shift+Y` | Editor |
| New file | `Cmd+N` | Editor |
| Find / replace | `Cmd+F` | Editor |
| Find across files | `Cmd+Shift+F` | Editor |
| Open settings | `Cmd+,` | Editor (hardcoded) |

### Editing

Sentence-level navigation and editing, ported from [obsidian-sentence-navigator](https://github.com/laffan/obsidian-sentence-navigator). Sentence boundaries are detected within individual lines using punctuation rules (`.` `!` `?` followed by optional closing delimiters and whitespace).

| Action | Default | Scope |
|--------|---------|-------|
| Select sentence | `Cmd+L` | Editor |
| Reduce sentence selection | `Cmd+Shift+L` | Editor |
| Select next instance | `Cmd+D` | Editor |
| Select previous instance | `Cmd+Shift+D` | Editor |
| Jump to next sentence | `Cmd+Right` | Editor |
| Jump to previous sentence | `Cmd+Left` | Editor |
| Jump to next paragraph | `Cmd+Down` | Editor |
| Jump to previous paragraph | `Cmd+Up` | Editor |
| Shift selection to next sentence | `Cmd+Shift+Right` | Editor |
| Shift selection to previous sentence | `Cmd+Shift+Left` | Editor |
| Move sentence forward | `Alt+Cmd+Right` | Editor |
| Move sentence back | `Alt+Cmd+Left` | Editor |
| Delete to sentence end | `Alt+Shift+Backspace` | Editor |

### Formatting

Markdown formatting toggles. Each command wraps the current selection in the corresponding markdown syntax. If the selection is already wrapped, the markers are removed (toggle behavior). With no selection, inserts marker pairs with the cursor between them.

| Action | Default | Scope |
|--------|---------|-------|
| Bold | `Cmd+B` | Editor |
| Italic | `Cmd+I` | Editor |
| Highlight | `Cmd+=` | Editor |
| Comment | `Cmd+/` | Editor |
| Strikethrough | `` Cmd+` `` | Editor |
| Insert footnote | `Cmd+Shift+M` | Editor |

The Comment shortcut overrides CodeMirror's default HTML comment toggle, wrapping text in Obsidian-flavored markdown comments (`%%text%%`) instead.

## Plugins

Tauri plugins used:
- `tauri-plugin-global-shortcut` — System-wide keyboard shortcuts
- `tauri-plugin-positioner` — Window positioning helpers
- `tauri-plugin-dialog` — Native file/folder dialogs
- `tauri-plugin-fs` — File system read/write
- `tauri-plugin-shell` — Shell command execution
