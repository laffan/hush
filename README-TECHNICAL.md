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
├── settings-ui.js
├── settings-window.js
├── themes.js
├── find-replace.js
├── private-mode.js
├── sentence-navigator.js
└── formatting.js
```

The frontend and backend communicate via Tauri's `invoke` IPC for commands (settings, file CRUD) and `emit`/`listen` for events (settings updates, fullscreen toggle).

## Development Rules

There is a STRICT rule that no code file may be longer than 700 lines.  Always begin and end each session confirm that this is the case and refactoring where necessessary to make sure it stays the case. 

## Frontend

### Entry Points

- **`index.html`** — Main editor window. Loads `src/main.js`.
- **`settings.html`** — Settings window (separate Tauri WebviewWindow). Loads `src/settings-window.js`.

Both are built by Vite as separate Rollup inputs.

### State Management (`state.js`)

`AppState` is the single source of truth. It holds settings, file list, mode flags, and the editor reference. It uses a simple event emitter pattern (`on`/`off`/`emit`) to notify the UI of changes.

Key events: `mode-changed`, `fullscreen-changed`, `files-changed`, `file-opened`, `settings-changed`, `theme-changed`, `style-changed`, `style-preview`, `style-preview-end`, `toggle-files-panel`.

On Tauri, state loads from the Rust backend via `invoke("get_settings")` and `invoke("list_files")`. In the browser (dev without Tauri), it falls back to localStorage.

### Editor (`editor.js`)

The CodeMirror 6 instance is configured with:

- **Markdown language** with inline syntax highlighting via `HighlightStyle` (headings get scaled font sizes, syntax characters are dimmed to 40% opacity)
- **Custom inline parsers** for `%%comments%%` (dimmed to 40% opacity) and `==highlighted text==` (yellow background)
- **Heading normalization** — `normalizeHeaders` setting removes scaled heading sizes, keeping only font weight
- **Theme compartment** for live theme swapping without recreating the editor
- **Highlight compartment** for reconfiguring heading styles on settings change
- **Ratchet keymap** (`Prec.highest`) that intercepts all deletion, navigation, selection, undo, redo, and cut keys when ratchet mode is active
- **Global keymap** for Cmd+,, Cmd+Shift+P, Cmd+\, Cmd+T, Cmd+N, Cmd+F, Cmd+Shift+F, Cmd+D, plus sentence navigation and formatting shortcuts (see below)
- **Transaction filter** that blocks deletions and non-end insertions in ratchet mode
- **Mouse filter** that blocks mousedown in ratchet mode
- **Private mode plugin** (ViewPlugin) that decorates every non-whitespace character with a CSS class
- **Typewriter mode** — locks cursor to a fixed screen position (default 60% from top). A draggable boundary line lets the user reposition. Extra padding is added so the first/last line can reach the boundary.
- **Ratchet scroll** — pins the current (always last) line to vertical center (50%) of the window

Column width is managed by dynamically setting `paddingLeft`/`paddingRight` on `.cm-scroller`. Draggable resizer elements are positioned at the column edges. When the sidebar panel is open in inset mode, the column re-centers within the remaining space.

### Sidebar (`sidebar.js`)

The sidebar is a fixed 50px column on the left edge with icon buttons. It's hidden by default (`opacity: 0; pointer-events: none`) and revealed by a JS hover trigger element appended inside `#app`. It can be pinned open with Cmd+\.

**Buttons (top to bottom):**
- New file — creates a file and closes any open panel
- Files — opens the file list panel
- Styles — opens the styles panel
- Ratchet mode — shows a duration dropdown (5–30 min), toggles off if active
- Private mode — toggles private mode
- Typewriter mode — toggles typewriter mode
- Save location — opens the autosave/Obsidian panel
- Export — exports the current file as `.md` via native save dialog

Panels (file list, styles, autosave settings) render into `#panel-overlay`, a fixed div to the right of the sidebar. The panel layout is responsive: when the window is wide enough (sidebar + panel ≤ available padding), the panel insets beside the content; otherwise it overlays as a modal.

### Styles (`sidebar.js`, `main.js`)

Styles are named presets that combine a theme, font, font size, line height, and optional color overrides (background, text, cursor) into a single switchable configuration. They are managed entirely through the sidebar's Styles panel.

**Style data model:**
```
{ id, name, themeId, fontFamily, fontSize, lineHeight, colorOverrides: { bg, fg, cursor } }
```

- **List view** — shows all saved styles plus a "Default" option. Click to activate, hover to live-preview.
- **Inline editor** — accordion-style form that opens below the "New Style" button or below the style being edited. Includes custom dropdowns for theme and font selection, sliders for size/height, and color pickers with reset buttons.
- **Live preview** — every form change emits a `style-preview` event that temporarily applies the style to the editor. On cancel or mouse-leave, `style-preview-end` restores the actual settings.
- **Color overrides** take precedence over theme colors. They're applied directly to CSS variables (`--bg`, `--fg`, `--cursor`) and the `.cm-editor` background.
- **`applyActiveStyle()`** in `main.js` handles applying/removing style overrides, including theme switching, font changes, and color variable updates.

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

### Formatting (`formatting.js`)

Markdown formatting toggle commands. Uses a generic `toggleWrap(view, marker)` function that handles three cases:
1. **No selection** — inserts `marker + marker` with cursor between them
2. **Already wrapped** — detects markers immediately outside the selection (or inside if the selection includes them) and removes them
3. **Wrap** — wraps the selection with the marker on both sides

Exports: `toggleBold` (`**`), `toggleItalic` (`*`), `toggleHighlight` (`==`), `toggleComment` (`%%`).

### Tauri Bridge (`tauri-bridge.js`)

Handles global shortcut registration via `@tauri-apps/plugin-global-shortcut`. Shortcuts are registered on startup and re-registered whenever settings change. Old shortcuts are unregistered first to avoid stale handlers.

### Settings Window (`settings-window.js`)

Runs in a separate Tauri WebviewWindow. Loads settings via `invoke("get_settings")`, saves via `invoke("save_settings")`, and notifies the main window via `emit("settings-updated", settings)`.

**Tabs:**
- **General** — visibility (menu bar / dock / both), always-on-top
- **Editor** — appearance (light/dark/auto), default light and dark themes, font family (3 built-in + system fonts), normalize headers toggle, font size (12–36px), line height (1.0–2.5)
- **Shortcuts** — all customizable shortcuts organized into three categories (General, Editing, Formatting) with conflict detection. Click a shortcut to record a new one; conflicts auto-swap.

### Themes (`themes.js`)

Wraps the [thememirror](https://github.com/vadimdemedes/thememirror) library. Exports a `themeList` array of `{ id, name, type, extension }` objects — 6 light themes and 10 dark themes. `getActiveTheme(settings)` resolves the current theme: if a style is active and has a `themeId`, that takes priority; otherwise it resolves based on appearance (light/dark/auto) and the user's default theme selection.

**Light:** Ayu Light, Clouds, Noctis Lilac, Rosé Pine Dawn, Solarized Light, Smoothy
**Dark:** Amy, Barf, Bespin, Birds of Paradise, Boys and Girls, Cobalt, Cool Glow, Dracula, Espresso, Tomorrow

## Backend (Rust)

### `lib.rs` — Core

Defines the Tauri app setup:

- **AppState** — `Mutex<AppSettings>` + `Mutex<FileManager>`, managed by Tauri's state system
- **Tauri commands** — `get_settings`, `save_settings`, `list_files`, `load_file`, `save_file`, `create_file`, `delete_file`, `rename_file`, `check_obsidian_vault`, `set_always_on_top`, `set_activation_policy`
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
    color_overrides: HashMap<String, String>,  // keys: "bg", "fg", "cursor"
}
```

`AppSettings` includes `styles: Vec<Style>` and `active_style_id: Option<String>` to track the user's style presets and current selection.

### `files.rs`

`FileManager` stores files as individual JSON files (`{uuid}.json`) in `{data_dir}/files/`. Each file contains id, name, content, and modified timestamp.

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
- **`src-tauri/tauri.conf.json`** — App identifier `com.hush.app`, transparent window, hidden title bar overlay, system tray icon, macOS private API enabled

## Data Storage

```
{data_dir}/com.hush.app/
├── settings.json          # App settings (including styles array)
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

The Comment shortcut overrides CodeMirror's default HTML comment toggle, wrapping text in Obsidian-flavored markdown comments (`%%text%%`) instead.

## Plugins

Tauri plugins used:
- `tauri-plugin-global-shortcut` — System-wide keyboard shortcuts
- `tauri-plugin-positioner` — Window positioning helpers
- `tauri-plugin-dialog` — Native file/folder dialogs
- `tauri-plugin-fs` — File system read/write
- `tauri-plugin-shell` — Shell command execution

## One last thing
Remember the development rules. 700 lines.
