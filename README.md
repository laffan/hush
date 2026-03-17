# Hush

A minimal, distraction-free writing app for macOS. Hush lives in your menu bar and gives you a clean space to write — no window chrome, no clutter, just text.

## Features

**Editor** — A Markdown editor with inline syntax highlighting (headings, bold, italic, links, code), adjustable column width, and 16 color themes across light, dark, and sepia appearances.

**Ratchet Mode** — Forward-only writing. Pick a duration (5–30 minutes) and the editor locks out deletion, selection, and backward navigation. Only the current line is visible, centered on screen. When the timer expires, the full document reappears.

**Private Mode** — Replaces all characters with opaque boxes so you can write without anyone reading over your shoulder. Toggle with `⌘⇧P`.

**Typewriter Mode** — Locks the cursor to a fixed line on screen. Drag the boundary to reposition it. The document scrolls to keep the cursor in place.

**File Management** — Multiple files with automatic 2-second autosave. Optionally save to an external folder or Obsidian vault.

**Keyboard-First** — Global shortcuts work even when the app is hidden:
- `⌘⇧H` — Toggle editor visibility
- `⌘⇧F` — Toggle fullscreen
- `⌘⇧P` — Toggle private mode
- `⌘,` — Open settings

All shortcuts are customizable in Settings.

**Window Behavior** — Floating window that stays out of the dock by default. Options to show in dock, menu bar, or both. Optional always-on-top. Fullscreen mode for immersive writing.

## Installation

Requires [Rust](https://rustup.rs/) and [Node.js](https://nodejs.org/).

```sh
npm install
npm run tauri build
```

The built app will be in `src-tauri/target/release/bundle/`.

## Development

```sh
npm run tauri dev
```

This starts Vite on port 5173 and launches the Tauri dev window with hot reload.

## Settings

Access via `⌘,` or the system tray menu. Options include:

- **Appearance** — Light, dark, or automatic (follows system)
- **Themes** — Separate light and dark theme selection
- **Font** — EB Garamond (serif), Inter (sans), or Fira Code (mono)
- **Font size** — 12–36px
- **Line height** — 1.0–2.5
- **Visibility** — Menu bar only, dock, or both
- **Always on top** — Keep window above all others
- **Shortcuts** — Rebind all global shortcuts

## Data

Files and settings are stored in:
- **macOS**: `~/Library/Application Support/com.hush.app/`
- **Linux**: `$XDG_DATA_HOME/com.hush.app/`
