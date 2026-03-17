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
└── private-mode.js
```

The frontend and backend communicate via Tauri's `invoke` IPC for commands (settings, file CRUD) and `emit`/`listen` for events (settings updates, fullscreen toggle).

## Frontend

### Entry Points

- **`index.html`** — Main editor window. Loads `src/main.js`.
- **`settings.html`** — Settings window (separate Tauri WebviewWindow). Loads `src/settings-window.js`.

Both are built by Vite as separate Rollup inputs.

### State Management (`state.js`)

`AppState` is the single source of truth. It holds settings, file list, mode flags, and the editor reference. It uses a simple event emitter pattern (`on`/`off`/`emit`) to notify the UI of changes.

Key events: `mode-changed`, `fullscreen-changed`, `files-changed`, `file-opened`, `settings-changed`, `theme-changed`.

On Tauri, state loads from the Rust backend via `invoke("get_settings")` and `invoke("list_files")`. In the browser (dev without Tauri), it falls back to localStorage.

### Editor (`editor.js`)

The CodeMirror 6 instance is configured with:

- **Markdown language** with inline syntax highlighting via `HighlightStyle` (headings get scaled font sizes, syntax characters are dimmed to 40% opacity)
- **Theme compartment** for live theme swapping without recreating the editor
- **Ratchet keymap** (`Prec.highest`) that intercepts Backspace, Delete, ArrowLeft, ArrowUp, Home, Cmd+A, Cmd+Z, Cmd+X when ratchet mode is active
- **Global keymap** for Cmd+,, Cmd+Shift+P, Cmd+Shift+F
- **Mouse filter** that blocks mousedown in ratchet mode
- **Private mode plugin** (ViewPlugin) that decorates every non-whitespace character with a CSS class

Column width is managed by dynamically setting `paddingLeft`/`paddingRight` on `.cm-scroller`. Draggable resizer elements are positioned at the column edges.

### Sidebar (`sidebar.js`)

The sidebar is a fixed 50px column on the left edge with icon buttons. It's hidden by default (`opacity: 0; pointer-events: none`) and revealed by a JS hover trigger element appended inside `#app`.

Panels (file list, autosave settings) render into `#panel-overlay`, a fixed div to the right of the sidebar. The sidebar stays visible while any panel is open.

### Tauri Bridge (`tauri-bridge.js`)

Handles global shortcut registration via `@tauri-apps/plugin-global-shortcut`. Shortcuts are registered on startup and re-registered whenever settings change. Old shortcuts are unregistered first to avoid stale handlers.

### Settings Window (`settings-window.js`)

Runs in a separate Tauri WebviewWindow. Loads settings via `invoke("get_settings")`, saves via `invoke("save_settings")`, and notifies the main window via `emit("settings-updated", settings)`.

Shortcut recording captures keydown events, builds a `CmdOrCtrl+Shift+Key` string, and saves it. The main window re-registers the global shortcut on the next `settings-changed` event.

### Themes (`themes.js`)

Wraps the [thememirror](https://github.com/vadimdemedes/thememirror) library. Exports a `themeList` array of `{ id, name, type, extension }` objects. `getActiveTheme(settings)` resolves the current theme based on appearance (light/dark/auto) and the user's theme selection.

## Backend (Rust)

### `lib.rs` — Core

Defines the Tauri app setup:

- **AppState** — `Mutex<AppSettings>` + `Mutex<FileManager>`, managed by Tauri's state system
- **Tauri commands** — `get_settings`, `save_settings`, `list_files`, `load_file`, `save_file`, `create_file`, `delete_file`, `check_obsidian_vault`, `set_always_on_top`, `set_activation_policy`
- **System tray** — Menu with Toggle Editor, Fullscreen, Settings, Quit. Tray icon click toggles window visibility.
- **macOS activation policy** — Applied on startup based on the `visibility` setting. `Regular` shows in dock, `Accessory` hides from dock.
- **Window close behavior** — Main window hides on close (prevented via `CloseRequested`); settings window closes normally.

### `settings.rs`

`AppSettings` struct with serde `rename_all = "camelCase"` for JS interop. All fields have `#[serde(default)]` with named default functions for backward compatibility when new fields are added. Persisted as pretty-printed JSON at `{data_dir}/settings.json`.

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
├── settings.json          # App settings
└── files/
    ├── {uuid}.json        # File entries (id, name, content, modified)
    └── .hush/             # External sync ID mappings
```

Platform paths:
- **macOS**: `~/Library/Application Support/com.hush.app/`
- **Linux**: `$XDG_DATA_HOME/com.hush.app/`

## Plugins

Tauri plugins used:
- `tauri-plugin-global-shortcut` — System-wide keyboard shortcuts
- `tauri-plugin-positioner` — Window positioning helpers
- `tauri-plugin-dialog` — Native file/folder dialogs
- `tauri-plugin-fs` — File system read/write
- `tauri-plugin-shell` — Shell command execution
