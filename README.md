# Hush

A minimal, distraction-free writing app for macOS. Hush lives in your menu bar and gives you a clean space to write — no window chrome, no clutter, just text.

## Features

**Editor** — A Markdown editor with inline syntax highlighting (headings, bold, italic, links, code), adjustable column width, and 16 color themes across light, dark, and sepia appearances. Heading `#` markers stay hidden unless your cursor is inside the heading being edited.

**Styles** — Combine theme, font, font size and line height in to specific "styles" that you can easily create and move between using sidebar controls.

**Ratchet Mode** — Forward-only writing. Pick a duration (5–30 minutes) and the editor locks out deletion, selection, and all navigation. The current line is pinned to the center of the screen with previous lines scrolling up above it (typewriter-style). The cursor is always at the end of the document. The timer persists across app restarts.

**Private Mode** — Replaces all characters with opaque boxes so you can write without anyone reading over your shoulder. Toggle with `⌘⇧P`.

**Word Count** — Optional live word count pinned to the top of the text column, horizontally centered just below where the Ratchet timer appears. When Ratchet mode is also active, the count stacks directly beneath the timer in the same pill style. Doc-mode floating panes carry their own word count next to the title (independent count per pane). Toggle with `⌘⇧W`.

**Typewriter Mode** — Locks the cursor to a fixed line on screen. Drag the boundary to reposition it. The document scrolls to keep the cursor in place.

**Notebooks** — Canvas-based visual notes with an infinite pan-and-zoom surface (25–100%). Create text, images, drag areas, and freehand drawings on a freeform canvas. A top draw-toolbar surfaces Lasso, Erase, Slice, and four brush slots; picking any of them implicitly routes input to the stroke engine — there is no separate "drawing mode" to enter. Strokes group, layer, pocket, and undo like every other shape. The bottom toolbar adds a Grab button for persistent pan (space bar is the keyboard equivalent, and two-finger drag also pans). Brainstorm mode (rapid sequential text entry), a pocket shelf for stashing shapes, camera bookmarks, and 16 matching color themes round it out. Notebooks autosave alongside documents and share the same organizational structure. Exporting a notebook opens a dedicated modal: pick scope (visible window or all content with a custom margin), format (`.hushnote`, PNG, JPG, PDF), scale (1×/2×/3×), and whether the canvas background is baked in.

**Flowchart connections** — Connect text shapes with directed arrows. Drop one text shape on top of another to make it a child (auto-snapped to the right of the parent, stacking under any siblings); from inside the inline text editor, `⌘→` commits and opens a new child, `⌘↓` opens a sibling, `⌘←` jumps to the parent, and `⌘↑` jumps back to the most-recently-edited node. Hover an arrow to surface a small `×` for one-click delete; deleting a node also removes every edge that touched it. Dragging a node pulls its descendants along so the chain stays intact.

**Floating Panes** — Cmd-drag any document or notebook from the files sidebar into the editor area to open it as a floating reference pane. Panes are fully functional editors (same markdown features, shortcuts, and syntax highlighting) that float above the main content. Resize from edges or corners, drag via the title bar, collapse to just the header, or close. Panes stay with their parent document and reappear when you return.

- **Attach** — Anchors a pane to the document scroll (docs) or canvas position (notebooks) so it moves with the content.
- **Pin** — Keeps a pane visible across document switches (blue border). Unpinning returns it to its original document.
- **Duplicate** — Creates a copy of a pane owned by the current document. Useful for bringing a pinned reference into a new context.
- **Real-time sync** — Edits in a pane propagate to the main editor if the same file is open, and vice versa.
- **Locked styles** — When a document or notebook has "Lock Style to Document" enabled, any pane showing that file adopts that locked style (theme, font, sizing) instead of the session's active style.

**File Management** — Multiple files with automatic 2-second autosave. Organize documents and notebooks in folders and projects with drag-and-drop reordering. Click anywhere on a folder row (including Inbox, Images, and Trash) to toggle it open. The sidebar uses a crosshair cursor while navigating and its width can be resized by dragging its right edge — the handle is invisible until you approach it, matching the editor's column resizers. Filenames use the full available width; per-row action buttons overlay the title only on hover and hide themselves during rename. The **Flagged** section of the outline view surfaces flagged items from nested folders so a flagged folder brings its children up with it.

**Doc Images** — Drag any image file from the desktop into a document to embed it at the drop point, or drag an entry from the **Images** folder in the sidebar into a document or notebook. The editor renders the image inline, capped at the column width and at half the window height; narrower images are centered. Image references use standard markdown (`![alt](brown-cow.png)`) with two extensions: an optional caption after a pipe (`![alt | caption](brown-cow.png)`) and double-quoted URLs for filenames that contain spaces or parens (`![alt]("brown-cow (2).png")`). Every image is stored in a top-level **Images** folder pinned above Trash under its original filename (auto-suffixed on collision). The Images folder icon is a photo frame with a single slash through it, and — like Trash — defaults to collapsed, opening only when the user explicitly clicks it. Hovering an image row in that folder shows a tooltip preview; clicking the row — or the image in the editor — opens a full-size modal. Images can be renamed from the Files panel and every reference across every doc is rewritten automatically; deleting an image purges its refs too. Cmd-drag moves image references between panes, docs, and notebooks (a doc image dropped on a notebook canvas becomes an ImageShape; a notebook ImageShape dropped on a doc becomes markdown). Exporting a doc that contains images produces a folder with `text.md` plus an `images/` subdirectory.

**Dropbox Sync** — Optional full-library sync to Dropbox. Connect via OAuth in Settings > Sync, choose a folder, and all documents, projects, and folders are mirrored automatically. Works across macOS and iOS. Documents sync as `.md` files, projects as `.hushproject` metadata. Sync is bidirectional with automatic conflict resolution.

**Local Sync** (desktop only) — A second Sync section lets you point Hush directly at one or more folders on disk. Click **Add folder** to pick a location; the folder and its contents appear in the sidebar under a dedicated icon (a circle with a horizontal line through it). Local Sync folders sit *outside* the version control system — Hush simply reflects the filesystem. Edits made from other apps propagate into Hush as soon as they hit disk, and edits inside Hush write straight back. Unsyncing a Local Sync folder removes it from the sidebar only; nothing is changed on disk.

**Keyboard-First** — Global shortcuts work even when the app is hidden:

**Command Palette** — Press `⌘P` to open a searchable command palette with quick access to all modes and major actions. Includes "New document" / "New notebook" plus "as pane" variants that open the new file as a floating reference without leaving the current view. Active modes appear at the top as "Turn off" entries for fast toggling. `⌘O` jumps straight to the file picker; `⌘⇧O` opens the picker in "as pane" mode.

All shortcuts are customizable in Settings.

**Window Behavior** — Floating window that stays out of the dock by default. Options to show in dock, menu bar, or both. Optional always-on-top. Fullscreen mode for immersive writing.

**Tooltips** — Off by default for a clean reading surface. Enable **Show tooltips** in Settings > General to surface labels + shortcut hints on every sidebar, pane header, and notebook toolbar button.

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
