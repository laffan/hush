# Hush

A minimal, distraction-free writing app for macOS. Hush lives in your menu bar and gives you a clean space to write — no window chrome, no clutter, just text.

## Features

**Editor** — A Markdown editor with inline syntax highlighting (headings, bold, italic, links, code), adjustable column width, and 16 color themes across light, dark, and sepia appearances.

**Styles** — Combine theme, font, font size and line height in to specific "styles" that you can easily create and move between using sidebar controls.

**Ratchet Mode** — Forward-only writing. Pick a duration (5–30 minutes) and the editor locks out deletion, selection, and all navigation. The current line is pinned to the center of the screen with previous lines scrolling up above it (typewriter-style). The cursor is always at the end of the document. The timer persists across app restarts.

**Private Mode** — Replaces all characters with opaque boxes so you can write without anyone reading over your shoulder. Toggle with `⌘⇧P`.

**Typewriter Mode** — Locks the cursor to a fixed line on screen. Drag the boundary to reposition it. The document scrolls to keep the cursor in place.

**Notebooks** — Canvas-based visual notes with an infinite pan-and-zoom surface. Create text, images, and drag areas on a freeform canvas. Features brainstorm mode (rapid sequential text entry), a pocket shelf for stashing shapes, camera bookmarks, and 16 matching color themes. Notebooks autosave alongside documents and share the same organizational structure.

**Floating Panes** — Cmd-drag any document or notebook from the files sidebar into the editor area to open it as a floating reference pane. Panes are fully functional editors (same markdown features, shortcuts, and syntax highlighting) that float above the main content. Resize from edges or corners, drag via the title bar, collapse to just the header, or close. Panes stay with their parent document and reappear when you return.

- **Attach** — Anchors a pane to the document scroll (docs) or canvas position (notebooks) so it moves with the content.
- **Pin** — Keeps a pane visible across document switches (blue header). Unpinning returns it to its original document.
- **Duplicate** — Creates a copy of a pane owned by the current document. Useful for bringing a pinned reference into a new context.
- **Real-time sync** — Edits in a pane propagate to the main editor if the same file is open, and vice versa.

**File Management** — Multiple files with automatic 2-second autosave. Organize documents and notebooks in folders and projects with drag-and-drop reordering.

**Dropbox Sync** — Optional full-library sync to Dropbox. Connect via OAuth in Settings > Sync, choose a folder, and all documents, projects, and folders are mirrored automatically. Works across macOS and iOS. Documents sync as `.md` files, projects as `.hushproject` metadata. Sync is bidirectional with automatic conflict resolution.

**Keyboard-First** — Global shortcuts work even when the app is hidden:

**Command Palette** — Press `⌘P` to open a searchable command palette with quick access to all modes and major actions. Active modes appear at the top as "Turn off" entries for fast toggling.

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
cp .env.example .env   # Configure Dropbox App Key (optional)
npm run tauri dev
```

### Dropbox Sync Setup

To enable Dropbox sync during development:

1. Create a Dropbox app at [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps)
2. Add `http://localhost:5173/oauth-callback.html` as a redirect URI in the app settings
3. Copy the App Key to your `.env` file as `VITE_DROPBOX_APP_KEY`
4. For production builds, also add `hushwriter://auth/callback` as a redirect URI and set `VITE_DROPBOX_REDIRECT_URI` accordingly

## Building

### macOS
```sh
npm run tauri build
```
### iOS

```sh
npm run ios:init
# Open xcode project and set up signing
npm run build:ios
```



## Data

Files and settings are stored in:
- **macOS**: `~/Library/Application Support/com.hush.app/`
- **Linux**: `$XDG_DATA_HOME/com.hush.app/`
