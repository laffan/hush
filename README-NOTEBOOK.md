# Notebook — Technical Overview

The notebook is a canvas-based visual notes editor embedded within Hush. It lives in `src/notebook/` as vanilla TypeScript (transpiled by Vite) and shares the same window, sidebar, and settings infrastructure as the markdown editor. Originally developed as a standalone app ([tauri-drawing](https://github.com/laffan/tauri-drawing)), it has been adapted to run as an integrated file type.

## Architecture

```
src/notebook/
  notebook-bridge.js      Hush ↔ canvas lifecycle: mount, unmount, autosave, settings sync
  notes-canvas.ts         Public API class — orchestrates canvas, UI, render loop
  state.ts                DrawingState class — all canvas state + mutations
  state-helpers.ts        Pure helpers (find, resize, crop, link hit-test, pocket hit-test)
  renderer.ts             Canvas 2D draw functions (pure, no side effects)
  input-handler.ts        DOM event wiring → state methods; reads shortcuts from Hush settings
  external-content.ts     Clipboard / drag-drop / file helpers
  file-io.ts              Save/open .note files (JSZip) — unused in Hush (kept for reference)
  markdown.ts             Inline markdown parser: headings, bold, italic, links, highlights
  themes.ts               16 canvas themes mapped from Hush's thememirror themes
  types.ts                Shape types, constants, color palettes
  undo-manager.ts         Snapshot-based undo/redo (100 entries)
  utils.ts                Geometry, hit testing, text measurement, alignment, pocket layout
  ui/
    toolbar.ts             Bottom tool bar (tools, grid popup, bookmarks, undo/redo)
    selection-toolbar.ts   Context toolbar above selected shapes
    bookmarks-panel.ts     Camera bookmark dropdown
    shelf-panel.ts         Right-side hierarchical shape browser
    text-editor.ts         Inline textarea overlay for text shapes
    brainstorm-input.ts    Persistent input for brainstorm mode
    status-bar.ts          Zoom / shape count / selection count
    icons.ts               SVG icon system (currentColor theming)
    dom-helpers.ts         h() element builder, setStyles(), clearChildren()
    file-panel.ts          Standalone save/open — unused in Hush
    settings-panel.ts      Standalone settings modal — unused in Hush
```

### Integration with Hush

The notebook does **not** run as a separate window or webview. It mounts into the same `#app` DOM as the markdown editor, swapping visibility via the `.notebook-mode` CSS class on `#app` and `<body>`. All editor-specific chrome (CodeMirror, column resizers, drag region, outline panel, hover triggers) is hidden with `display: none !important` when `.notebook-mode` is active.

**notebook-bridge.js** is the JS glue layer between Hush's `AppState` and the notebook's `DrawingState`. It handles:

- **Mounting** — dynamically imports `NotesCanvas`, passes shortcut settings, loads shapes from the backing file.
- **Autosave** — the Hush 2-second autosave interval fires `notebook-autosave` events; the bridge serializes shapes to JSON and saves via the existing `save_file` Tauri command.
- **Settings sync** — appearance, theme, and font are derived from the current Hush editor style (with a camelCase → kebab-case theme ID mapping in `HUSH_TO_NOTEBOOK_THEME`). Grid pattern, spacing, and opacity use dedicated notebook settings.
- **Left inset** — a `MutationObserver` on the sidebar/panel DOM classes pushes the current sidebar width (0/50/350px) to `DrawingState.leftInset`, which offsets the pocket tray and toolbar position.

### File storage

Notebooks are stored identically to documents: as `files/{uuid}.json` in the app data directory. The `content` field holds a JSON array of `Shape` objects (the notebook's entire state). The file tree node has `type: "notebook"` and a `fileId` pointing to the backing file.

The standalone `.note` zip format (from tauri-drawing) is not used. `file-io.ts` is retained in the codebase for reference but not imported.

### Keyboard shortcuts

Notebook shortcuts are registered in the Hush shortcut system:

| Setting key | Default | Action |
|-------------|---------|--------|
| `shortcutNbSelect` | `1` | Select tool |
| `shortcutNbText` | `T` | Text tool |
| `shortcutNbDragArea` | `A` | Drag Area tool |
| `shortcutNbBrainstorm` | `B` | Toggle Brainstorm mode |
| `shortcutNbDelete` | `Backspace` | Delete selected shapes |
| `shortcutNbUndo` | `Mod+Z` | Undo |
| `shortcutNbRedo` | `Mod+Shift+Z` | Redo |
| `shortcutNbGroup` | `Mod+G` | Group selected shapes |
| `shortcutNbUngroup` | `Mod+Shift+G` | Ungroup selected shapes |

These appear in Settings > Shortcuts > Notebooks and are stored in `AppSettings` (Rust) alongside the editor shortcuts. The input handler reads them from Hush settings at mount time via the `NotebookShortcuts` interface.

Global shortcuts (`Cmd+P` command palette, `Cmd+,` settings, `Cmd+Shift+F` fullscreen) work in notebook mode through the window-level keydown handler in `main.js`.

### Command palette

The command palette is context-sensitive. When a notebook is open:

- **Shown**: New document, New notebook, Files, Styles, Versions, Export, Toggle fullscreen, Settings, **Open shelf**, **Start brainstorm**
- **Hidden**: Ratchet mode, Private mode, Typewriter mode, Show repeats, Highlight sentence, Outline view

### Drag and drop

File drops have three independent targets:

1. **Sidebar panel** — an "Import file" overlay appears inside `#panel-overlay` when it's open. Dropping creates a new document.
2. **Editor area** (doc mode) — `dragover`/`drop` on `#editor-container` appends text.
3. **Notebook canvas** — canvas-level `dragover`/`drop` in `input-handler.ts` handles images (→ image shapes) and text files (→ text shapes at drop position). Shelf drags also use canvas-level events.

## Core Concepts

### State management

`DrawingState` extends `EventTarget`. All mutations go through its methods or property assignment + `notify(key)`. Notifications batch via `queueMicrotask` — multiple `notify()` calls in the same synchronous stack fire a single `"change"` event.

The `"change"` event carries `{ detail: { keys: string[] } }` so listeners can check what changed.

### Rendering

`renderer.ts` exports a single `render(canvas, state)` function called every frame via `requestAnimationFrame`. All draw functions are pure — they take a context and data, produce pixels, and return. The render state includes a `leftInset` field that shifts the pocket tray and pocketed shape cards to accommodate the sidebar.

### Canvas themes

16 themes mirrored from Hush's thememirror set, stored as flat objects with canvas-specific properties (`canvasBackground`, `foreground`, `headingColor`, `selection`, `accent`, `gridColor`, `uiBackground`, `uiBorder`). The active theme is resolved from the Hush editor style via `HUSH_TO_NOTEBOOK_THEME` in `notebook-bridge.js`.

### Shape types

| Type | Description |
|------|-------------|
| `TextShape` | Positioned text with markdown rendering, optional background color, auto-fit or manual width |
| `ImageShape` | Positioned image from base64 dataUrl, with optional non-destructive crop region |
| `DragAreaShape` | Dashed container box that parents shapes dropped inside it |
| `DrawShape` | Freehand drawing (array of points + width) |

All shapes extend `ShapeBase`: `{ id, color, parentId?, groupId?, pocketed? }`.

### Pocket system

A temporary stash on the left edge of the canvas. Users hold-drag a shape for 1 second toward the left edge to pocket it. Pocketed items are drawn at fixed screen positions (independent of camera), shown on light-blue cards. The pocket tray, drop zone, and entries all offset by `DrawingState.leftInset` to stay clear of the sidebar.

### Undo/redo

`UndoManager` stores up to 100 shape array snapshots. `recordHistory()` is called after each completed user action (not during continuous drag/resize — only on pointer-up).

### Brainstorm mode

A rapid text-entry mode: each Enter creates a new text shape in an expanding spiral pattern around the click origin. Accessed via the `B` key or command palette.

### Shelf panel

Right-side slide-out panel listing all shapes organized by drag-area containers. Features search, #tag filtering, pin/unpin, and drag-to-restore. Themed to match the canvas theme.

## Development Rules

The same rules from the main Hush codebase apply:

- **No file may exceed 700 lines.**
- **No framework dependencies** in the notebook modules.
- **Pure rendering** — `renderer.ts` functions must not access global state or DOM.
- **State mutations go through DrawingState** — never mutate shapes from UI or input handlers directly.

### Adding a new shape type

1. Add the interface to `types.ts` extending `ShapeBase`, add it to the `Shape` union
2. Add bounds calculation to `getShapeBounds()` in `utils.ts`
3. Add hit testing to `hitTestShape()` in `utils.ts`
4. Add a draw function in `renderer.ts`
5. Add creation logic in `state.ts`
6. Add resize handling in `applyResize()` in `state-helpers.ts` if applicable

### Adding a new tool

1. Add the tool name to the `Tool` union in `types.ts`
2. Add pointer handling in `DrawingState.handlePointerDown/Move/Up`
3. Add the tool button in `ui/toolbar.ts` (in the `TOOLS` array)
4. Add a shortcut setting to `AppSettings` (Rust) and `shortcutCategories` (settings-tabs.js)
5. Add a cursor style in the `cursorMap` in `notes-canvas.ts`

### Adding a canvas theme

Add an entry to `THEMES` in `notebook/themes.ts` and a corresponding mapping in `HUSH_TO_NOTEBOOK_THEME` in `notebook-bridge.js`.
