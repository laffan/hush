# Hush

A minimal, distraction-free writing app for macOS and iPad. Hush lives in your menu bar and gives you a clean space to write — no window chrome, no clutter, just text. Everything is reachable from the keyboard, and almost everything happens through the command palette (`⌘P`).

Under the minimal surface is a full writing system: a Markdown editor, canvas-based visual notebooks, a flexible organizational model, research tools built around Zotero and PDFs, and file-based sync that works with any folder provider you already use.

## Writing

**The editor** is Markdown with inline rendering — headings, bold/italic, links, tables, images, footnotes, callouts, YAML properties, and `[[wikilinks]]` between notes. Sixteen color themes across light, dark, and sepia, and **Styles** that bundle theme + font + colors + optional post-processing effects (scanlines, glow) into presets you can switch, share, and import as JSON. Each style can also stack **Background Layers** — images, animatable multi-node gradients, WebGL effects, and caret effects that follow your cursor as you type (sparks, bubbles, ripples, a fading underline glow, a rotating sci-fi HUD, a phosphor flicker bar, and a liquid phosphor blob that sits on the cursor — each with its own light and dark colour, or set to match your caret, and an anti-alias toggle) — into a composite backdrop, each layer with its own blend mode, dragged into whatever order you like.

**Focus tools** keep you in the text:

- **Focus Mode** dims everything but the current sentence; **Typewriter Mode** pins the cursor to a fixed line.
- **Zen Focus** (`⌘⇧S`) is a fullscreen writing overlay with the current line centered and the edges of the screen faded away.
- **Private Mode** (`⌘⇧P`) replaces every character with opaque boxes so you can write in public.
- **Word count** (`⌘⇧W`), an optional live pill above the text column.

**Revision tools** help you rework what you wrote:

- **Selection Focus** opens the current selection alone in a fullscreen editor; edits write back as one undo step.
- **The Shuffle Editor** (`⌘⇧E`) explodes a selection into draggable sentences you can reorder, merge, strike, or comment, then compare against the original before committing.
- **Folding** collapses sections or selections behind small pills, like code folding for prose.
- Sentence-level navigation and editing shortcuts: jump, select, and move whole sentences from the keyboard.

**Ratchet Mode** is forward-only writing: pick a duration and the editor locks out deletion and navigation until the timer runs out. **Desk Ratchet** applies the same idea to a whole desk with no clock — committed text can be *rearranged* but never rewritten.

**Proofread** (grammar, via Harper) and **Spellcheck** modes underline issues inline with click-to-fix suggestions. Both run entirely on-device.

## Notebooks

Notebooks are infinite pan-and-zoom canvases for visual thinking: text shapes (with Markdown), images, freehand drawing with pressure-sensitive brushes, drag-area containers, layers, and camera bookmarks. Text shapes connect into **flowcharts** with directed arrows; a **shelf** panel lists every shape as an outline; a **pocket** stashes shapes off to the side; **Brainstorm mode** captures rapid-fire ideas.

On iPad, only the Apple Pencil draws — fingers pan, pinch, and tap to undo. Handwritten strokes can be **recognized into text** on-device (ML Kit on iPad; Apple Vision for images anywhere). Any selection can be **rasterized** into a single image that keeps tracking light/dark appearance.

Notebooks export as `.hushnote` (lossless), PNG, JPG, or PDF.

## Organizing

- **Desks** are top-level workspaces, each with its own Inbox, Archive, and Trash, its own style, and its own last-open file. A desk can live *anywhere on disk* as a plain folder — see Sync below.
- **Folders and projects** organize files; a project's documents concatenate into one continuous editor buffer with separators, so a long piece can live across many files. Projects convert to and from single tabbed documents, and a doc can be **split at its headings** into a project.
- **Stacks** lay out docs, notebooks, PDFs, and projects as side-by-side columns on one scrolling surface.
- **Desktops** show a project as a canvas of live file thumbnails you can arrange, pile, annotate, and connect — reading order drawn as arrows.
- **Floating panes** open any file as a reference window over your work: dock them to an edge, pin them across documents, attach them to canvas positions, or embed them inline under a wikilink. A **Gutter** docks a notebook beside a document, scroll-locked to it, for marginalia.
- **Sticky notes** are small scoped reminders (per file, project, desk, or global) that float above everything and never appear in the file tree.
- **YOU ARE HERE** — type `YOUAREHERE` anywhere and the sidebar pins a red resume-reading row that jumps straight back to the marker. One per desk.
- **Find** (`⌘F` in-document, `⌘⇧F` across the desk) with regex, whole-word, and replace; **Versions** keeps automatic snapshots of every doc and notebook with a diff view and one-click restore; flags, color tints, multi-select batch actions, and a per-desk Recent Files list round out the sidebar.

## Research

- **Zotero**: connect your library, search references from the editor (`⌘⇧I` or type `[@` for inline citations), save PDFs into Hush, browse a paper's highlights in a drag-out pane, and insert page snapshots.
- **PDF viewer**: fast, annotation-aware (Zotero highlights and ink render on the pages), with an annotation shelf, named colored **bookmarks** that work as deep links from your notes, a **folded view** that collapses a paper to just its annotated regions, and a gallery **shelf** view of any PDFs folder with full-text-ish search over titles, bookmarks, and highlight text.
- **Export**: documents and projects render to PDF through an embedded Typst pipeline (styles, line spacing, numbered headings, footnotes, and a real bibliography from your citations), plus Markdown, RTF, and one-shot Google Doc export.

## Google Docs

Pasting from Google Docs converts rich formatting to Markdown automatically, and **Copy as Google Doc** round-trips the other way. Beyond that, individual documents can be **linked** to a Google Doc for explicit push/pull sync — non-destructive pushes preserve comments and suggestions on untouched text, Google Docs *tabs* map to `---Tab---` markers, and pulled **comments and suggested edits** appear inline with hover cards and Resolve/Accept/Reject actions.

## Sync

There is no sync service. Every desk is a self-contained folder of ordinary files (`.md`, `.hushnote`, `.hushstack`), and a desk can operate from **any folder on disk** — point Hush at an iCloud Drive, Dropbox, or Syncthing folder and let your provider move the bytes. **Use Local Folder as Desk** (`⌘P`, or the New Desk popup) is both halves of that: pick a plain folder and it becomes a desk with whatever was already inside it, or pick the folder your other device already keeps a desk in and you join that desk — same files, same history. Outside changes fold back into the sidebar live; conflicted copies resolve automatically into version history; files a provider hasn't delivered yet are held, never dropped. **Local Folder** mounts give you the same direct-folder access without desk semantics, and archived desks zip into single shareable files. Automatic recovery snapshots protect synced desks, and **Backup App Data** zips everything.

## Everywhere you are

- **macOS**: menu-bar app, optional dock icon, always-on-top, fullscreen, hidden traffic lights.
- **iPad**: full app with Apple Pencil support, Files-app integration, real multi-window (Split View / Stage Manager), and touch-mode pills for keyboard-free use. iPhone gets a phone-tuned layout.
- **Multiple windows** on desktop and iPad — each window can sit on its own desk, and edits sync live between windows.
- **Keyboard-first**: every shortcut is rebindable in Settings, and **Show Shortcuts** displays a cheat sheet for whatever file type you're looking at.

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

Every desk is a folder of plain files inside that directory (or wherever you pointed a local desk), so your writing is never locked in.

---

*Technical documentation for contributors and coding agents: [README-TECHNICAL.md](README-TECHNICAL.md), with deep dives in [README-NOTEBOOK.md](README-NOTEBOOK.md), [README-DRAWING.md](README-DRAWING.md), and [README-SYNC.md](README-SYNC.md).*
