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
  renderer-selection.ts   Selection / group / crop / lasso-bbox highlights
  renderer-background.ts  Grid + dot-grid background pattern
  input-handler.ts        DOM event wiring → state methods; reads shortcuts from Hush settings
  external-content.ts     Clipboard / drag-drop / file helpers
  file-io.ts              Save/open .note files (JSZip) — unused in Hush (kept for reference)
  markdown.ts             Inline markdown parser: headings, bold, italic, links, highlights
  themes.ts               16 canvas themes mapped from Hush's thememirror themes
  types.ts                Shape types, constants, color palettes
  undo-manager.ts         Snapshot-based undo/redo (100 entries)
  utils.ts                Geometry, hit testing, text measurement, alignment, pocket layout
  flowchart.ts            Portable flowchart layer (edges, drop-to-connect, bezier arrows)
  notebook-content.ts     Persistence envelope (encode/decode, legacy bare-array fallback)
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
  drawing/                 See README-DRAWING.md
    drawing-layer.ts       Engine-backed drawing layer + public API
    sync-shim.ts           state.shapes[] ↔ engine.strokes bridge
    brush-slots.ts         Toolbar slot row + brush-edit flyout
    tool-panel.ts          Top draw pill (always visible): Lasso, Erase, Slice, brush slots; owns the lasso hold-time flyout
    layers-panel.ts        Layers dropdown (notebook-level, used by every shape type)
    engine/                Stroke engine (ported; 8 documented deltas)
```

### Integration with Hush

The notebook does **not** run as a separate window or webview. It mounts into the same `#app` DOM as the markdown editor, swapping visibility via the `.notebook-mode` CSS class on `#app` and `<body>`. All editor-specific chrome (CodeMirror, column resizers, drag region, outline panel, hover triggers) is hidden with `display: none !important` when `.notebook-mode` is active.

**notebook-bridge.js** is the JS glue layer between Hush's `AppState` and the notebook's `DrawingState`. It handles:

- **Mounting** — dynamically imports `NotesCanvas`, passes shortcut settings, loads shapes from the backing file.
- **Autosave** — the Hush 2-second autosave interval fires `notebook-autosave` events; the bridge serializes shapes to JSON and saves via the existing `save_file` Tauri command.
- **Settings sync** — appearance, theme, and font are derived from the current Hush editor style (with a camelCase → kebab-case theme ID mapping in `HUSH_TO_NOTEBOOK_THEME`). Grid pattern, spacing, and opacity use dedicated notebook settings.
- **Left inset** — a `MutationObserver` on the sidebar/panel DOM classes pushes the current sidebar width (0/50/350px) to `DrawingState.leftInset`, which offsets the pocket tray and toolbar position.

### Export

Pressing **Export** while a notebook is open opens a dedicated modal (`src/sidebar/notebook-export-modal.js`) that collects four choices and hands them to `exportNotebook()` in `src/notebook/notebook-export.ts`:

- **Scope** — *Visible window* exports the current viewport crop at the current camera zoom. *All content* fits the bounding box of every non-pocketed shape, with a user-specified **margin** (in CSS px at 1×) padded on every side.
- **Format** — `.hushnote` (JSON wrapper around the shapes + layers, versioned), `PNG`, `JPG`, or `PDF` (single-page, JPEG-backed via a minimal inline PDF encoder — no external library).
- **Scale** — 1×, 2×, 3×. Ignored for `.hushnote`.
- **Include background** — when off, the raster is emitted with a transparent canvas (no theme background fill, no grid/dot pattern).

The raster pipeline reuses the notebook renderer via `renderForExport()` (shapes + optional background, no selection/pocket/creating chrome) and then blits the drawing layer's "done" canvas via `DrawingLayer.blitDoneCanvasAtWorldOrigin()` so engine strokes land on top of the shape layer — matching the live DOM z-order. Pocketed shapes are explicitly skipped: the pocket is workspace UI, not content. The sidebar's `export-current-file` handler routes to this modal only when `state.currentNotebookFileId` is set; doc exports continue to use the existing Markdown path.

### File storage

Notebooks are stored as `files/{uuid}.json` in the app data directory. The `content` field holds a JSON envelope built by `notebook-content.ts::encodeNotebookContent`:

```jsonc
{
  "format": "hushnote",
  "version": 1,
  "shapes":    [...],   // every shape on the canvas
  "layers":    [...],   // ordered, top-first
  "flowEdges": [...]    // flowchart edges between text shapes
}
```

`decodeNotebookContent` parses this and also accepts the legacy bare `Shape[]` array form (older notebooks before the envelope migration) so existing files round-trip without rewriting on load. Every save / load / sync path goes through this pair (autosave in `notebook-bridge.js`, pane I/O in `pane/pane-content.js`, sync pull in `reloadNotebookShapes`, plus `.hushnote` export in `notebook-export.ts`) so the on-disk format stays consistent.

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

Draw sub-tools (Lasso, Erase, Slice, brush slots) are reached through the always-visible top pill — no keyboard shortcuts; the E/X hints in the button tooltips are placeholders. Hold space to pan; the grab button in the bottom toolbar does the same thing persistently for pointer-only use.

These appear in Settings > Shortcuts > Notebooks and are stored in `AppSettings` (Rust) alongside the editor shortcuts. The input handler reads them from Hush settings at mount time via the `NotebookShortcuts` interface.

Global shortcuts (`Cmd+P` command palette, `Cmd+,` settings, `Cmd+Shift+F` fullscreen) work in notebook mode through the window-level keydown handler in `main.js`.

### Command palette

The command palette is context-sensitive. When a notebook is open:

- **Shown**: New document, New notebook, Files, Styles, Versions, Export, Toggle fullscreen, Settings, **Open shelf**, **Start brainstorm**, **Insert Reference** (Zotero)
- **Hidden**: Ratchet mode, Private mode, Typewriter mode, Show repeats, Highlight sentence, Outline view, Word count

### Zotero in text shapes

Insert Reference (Zotero search) works inside notebook text shapes. `ui/text-editor.ts` exposes a `suspendCommitOnBlur()` / `resumeCommitOnBlur()` pair and an `insertAtSelection(text)` method; the Zotero search modal calls the suspend hook when it opens, remembers the active text-editor instance, and routes the selected citation back through `insertAtSelection()` before resuming blur-commit. Without this handshake the modal's focus change was committing the text shape and unmounting the editor before the citation could land.

### Drag and drop

File drops have three independent targets:

1. **Sidebar panel** — an "Import file" overlay appears inside `#panel-overlay` when it's open. Dropping creates a new document.
2. **Editor area** (doc mode) — `dragover`/`drop` on `#editor-container` appends text.
3. **Notebook canvas** — canvas-level `dragover`/`drop` in `input-handler.ts` handles images (→ image shapes) and text files (→ text shapes at drop position). Shelf drags also use canvas-level events.
4. **Floating panes** — Cmd-dragging a file from the sidebar past the panel edge creates a floating pane (see `pane/pane-manager.js`). Notebook panes can be attached to canvas coordinates. The notebook's `keydown` and `paste` handlers skip processing when `document.activeElement` is inside a `.floating-pane` to prevent input leaks.

## Core Concepts

### State management

`DrawingState` extends `EventTarget`. All mutations go through its methods or property assignment + `notify(key)`. Notifications batch via `queueMicrotask` — multiple `notify()` calls in the same synchronous stack fire a single `"change"` event.

The `"change"` event carries `{ detail: { keys: string[] } }` so listeners can check what changed.

### Rendering

`renderer.ts` exports a single `render(canvas, state)` function called every frame via `requestAnimationFrame`. All draw functions are pure — they take a context and data, produce pixels, and return. The render state includes a `leftInset` field that shifts the pocket tray and pocketed shape cards to accommodate the sidebar, and a `dpr` field (device pixel ratio) injected by `notes-canvas.ts`'s render loop — the renderer no longer reads `window.devicePixelRatio` itself, so the file is genuinely free of global DOM state.

Two sibling files keep `renderer.ts` under the line limit while preserving purity: `renderer-selection.ts` (the dashed bbox + handle drawing for selected shapes, group-selection bounds, crop overlay, drag-selection box) and `renderer-background.ts` (the grid / dot-grid background pattern). Both export pure functions called from `render()` and `renderForExport()`.

### Canvas themes

16 themes mirrored from Hush's thememirror set, stored as flat objects with canvas-specific properties (`canvasBackground`, `foreground`, `headingColor`, `selection`, `accent`, `gridColor`, `uiBackground`, `uiBorder`). The active theme is resolved from the Hush editor style via `HUSH_TO_NOTEBOOK_THEME` in `notebook-bridge.js`.

### Shape types

| Type | Description |
|------|-------------|
| `TextShape` | Positioned text with markdown rendering, optional background color, auto-fit or manual width |
| `ImageShape` | Positioned image from base64 dataUrl, with optional non-destructive crop region |
| `DragAreaShape` | Dashed container box that parents shapes dropped inside it. Created by dragging out an area with the Drag Area tool, *or* by selecting 2+ shapes and clicking the Drag Area button in the bottom toolbar — the latter wraps the selection (16 px padding) and re-parents every selected shape into the new container in one shot. See `DrawingState.wrapSelectionInDragArea()` in `state.ts`. |
| `DrawShape` | Freehand stroke — array of points + brushId + size + mode. Rendered by the drawing engine (see [README-DRAWING.md](README-DRAWING.md)). |

All shapes extend `ShapeBase`: `{ id, color, parentId?, groupId?, pocketed?, layerId? }`.

### Layers

Layers are notebook-level and host every shape type, not just drawings. `state.layers` is an ordered array (top-first); every shape carries an optional `layerId` and legacy shapes fall back to the bottom layer on load. The renderer walks bottom-to-top and skips hidden layers. The layers UI (`drawing/layers-panel.ts`) is mounted on the bottom toolbar. See README-DRAWING.md for details.

### Pocket system

A temporary stash on the left edge of the canvas. Users hold-drag a shape for 1 second toward the left edge to pocket it. Pocketed items are drawn at fixed screen positions (independent of camera), shown on light-blue cards. The pocket tray, drop zone, and entries all offset by `DrawingState.leftInset` to stay clear of the sidebar.

### Undo/redo

`UndoManager` stores up to 100 shape array snapshots. `recordHistory()` is called after each completed user action (not during continuous drag/resize — only on pointer-up).

### Brainstorm mode

A rapid text-entry mode: each Enter creates a new text shape in an expanding spiral pattern around the click origin. Accessed via the `B` key or command palette.

### Flowchart

Portable layer ported from the Steiner project (`src/notebook/flowchart.ts`). Connects text shapes with directed bezier arrows; arrows render under the text (so the box always reads on top) and follow each connected node as it moves. The layer itself knows nothing about Hush's shape types — `DrawingState` configures it with `getBounds` / `isFlowable` callbacks so it only treats `TextShape` nodes as flowable.

**Three ways to connect.**

- *Drag-to-connect.* Drag a text shape and release it on top of another. The dropped shape becomes a child of the target — its bounds snap to the right of the parent (with vertical stacking under any existing siblings) and its descendants follow by the same delta so the chain stays intact.
- *Edit-to-connect (⌘→ inside the inline text editor).* Commit the current edit, open a new editor positioned as a child of the just-edited node. The edge is wired by `commitText` once the user types something — `_pendingFlowParent` carries the parent id between the new-editor open and the eventual commit.
- *Edit-as-sibling (⌘↓).* Like ⌘→ but routes through the current node's parent (or, if there is no parent, opens a fresh editor below).

**Navigation.** ⌘← inside the inline editor jumps to the parent of the current node, ⌘↑ jumps back to the most-recently-edited node (a 16-entry MRU history kept on `DrawingState._recentEditIds`).

**Selection drag pulls descendants.** When the user drags one or more flowchart nodes, every transitive descendant moves with the selection so the layout remains coherent.

**Edge delete UI.** Hovering an arrow tracks its id on `state.flowHoveredEdgeId`; the renderer paints a small circular X badge at the curve's midpoint in screen space (fixed-size regardless of zoom — `drawEdgeDeleteButton` in `renderer-selection.ts`). Clicking the badge removes that single edge and records history. Deleting a node removes every edge that referenced it (`flowchart.removeNode` is called from `deleteSelected`).

**Persistence.** Edges are JSON-serialised by `flowchart.serialize()` and round-trip through the same `notebook-content.ts` envelope used for shapes + layers (see "File storage" above). Legacy notebooks (bare `Shape[]` array) decode with `flowEdges = undefined`, which the deserialiser treats as "no edges" — no migration needed.

### Drawing

The top-centered pill is always visible and carries Lasso, Erase, Slice, and four brush slots. There is no "drawing mode" to enter — clicking any of those tools (or double-clicking an existing stroke) implicitly routes pointer input to the stroke engine by flipping `state.tool = "pen"` with the matching sub-tool. Clicking a non-drawing tool (Select, Text, Drag Area, Brainstorm) flips `state.tool` back and the pill visually dims.

A long press during draw/erase promotes the in-flight stroke into a lasso pick. The hold duration is user-configurable from a slider in the Lasso flyout (500–2000 ms, default 1500). Tapping the already-active Lasso button toggles the flyout open.

`DrawShape` instances are first-class shapes — they group, layer, pocket, route through the shelf, and participate in Hush's undo stack. Stroke rendering itself is delegated to a bake-to-canvas engine inside `src/notebook/drawing/`. Full architectural notes, the sync-shim invariants, and the engine deltas are in [README-DRAWING.md](README-DRAWING.md).

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

For drawing-mode sub-tools (Draw/Erase/Slice/Select siblings), see [README-DRAWING.md](README-DRAWING.md) — that path goes through the engine rather than `DrawingState.handlePointer*`.

### Adding a canvas theme

Add an entry to `THEMES` in `notebook/themes.ts` and a corresponding mapping in `HUSH_TO_NOTEBOOK_THEME` in `notebook-bridge.js`.
