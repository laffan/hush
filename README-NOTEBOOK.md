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
  renderer-background.ts  Grid / dot-grid / lined / isometric background pattern
  input-handler.ts        DOM event wiring → state methods; reads shortcuts from Hush settings
  external-content.ts     Clipboard / drag-drop / file helpers
  file-io.ts              Save/open .note files (JSZip) — unused in Hush (kept for reference)
  markdown.ts             Inline markdown parser: headings, bold, italic, links, highlights
  themes.ts               16 canvas themes mirroring Hush's editor theme set
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
    tool-panel.ts          Drawing pill anchored to the bottom toolbar: Undo, brush slots, Slice, Erase, Lasso, lasso hold-time flyout, plus a gray hamburger drag-tab at the right end
    layers-panel.ts        Layers dropdown (notebook-level, used by every shape type)
    engine/                Stroke engine (ported; ~18 documented deltas — see README-DRAWING.md)
  pencil-bridge.js         Flips `setPencilOnly(true)` on iOS Tauri so finger contacts can't draw
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

- **Scope** — *Visible window* exports the current viewport crop at the current camera zoom. *All content* fits the bounding box of every non-pocketed shape, with a user-specified **margin** (in CSS px at 1×) padded on every side. The Scope toggle is hidden when `.hushnote` is the active format because the JSON envelope is always a complete snapshot of every shape and layer (`exportNotebook()` short-circuits the scope branch for that format).
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
  "flowEdges": [...],   // flowchart edges between text shapes
  "bookmarks": [...],   // optional camera bookmarks; same shape as DrawingState
  "camera":    {...}    // optional saved viewport — { x, y, zoom }
}
```

`decodeNotebookContent` parses this and also accepts the legacy bare `Shape[]` array form (older notebooks before the envelope migration) so existing files round-trip without rewriting on load. `bookmarks` was added later still and is treated as optional — older envelopes decode with `bookmarks = undefined` and the bridge skips the assignment. Every save / load / sync path goes through this pair (autosave in `notebook-bridge.js`, pane I/O in `pane/pane-content.js`, sync pull in `reloadNotebookShapes`, plus `.hushnote` export in `notebook-export.ts`) so the on-disk format stays consistent. Bookmark mutations call `state.notify("bookmarks")`, which `notes-canvas.ts` forwards as a `notebook-change` CustomEvent so the autosave pipeline picks it up alongside shape edits.

`camera` is the persisted pan + zoom; mounting a notebook restores it so the user lands where they left off. Pan / zoom changes ride a separate `notebook-camera-change` event into the bridge — autosave still writes the file (preserving the camera) but skips the version snapshot, since the viewport isn't content history. `reloadNotebookShapes` (the sync-pull entry point) deliberately ignores `snapshot.camera` so a remote device's view doesn't yank the local viewport around; per-device camera handling falls out naturally from there. Pane mounts also skip the saved camera and centre on the same world point the main canvas would, since pane viewports differ from the main canvas.

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

Draw sub-tools (Lasso, Erase, Slice, brush slots) are reached through the always-visible drawing pill attached to the right edge of the bottom toolbar — no keyboard shortcuts; the E/X hints in the button tooltips are placeholders. Hold space (or two-finger drag) to pan.

These appear in Settings > Shortcuts > Notebooks and are stored in `AppSettings` (Rust) alongside the editor shortcuts. The input handler reads them from Hush settings at mount time via the `NotebookShortcuts` interface.

Global shortcuts (`Cmd+P` command palette, `Cmd+,` settings, `Cmd+Shift+F` fullscreen) work in notebook mode through the window-level keydown handler in `main.js`.

### Command palette

The command palette is context-sensitive. When a notebook is open:

- **Shown**: New document, New notebook, Files, Styles, Versions, Export, Toggle fullscreen, Settings, **Open shelf**, **Start brainstorm**, **Insert Reference** (Zotero)
- **Hidden**: Ratchet mode, Private mode, Typewriter mode, Show repeats, Highlight sentence, Outline view, Word count

### Zotero references on the canvas

Insert Reference (Zotero search) supports three notebook contexts and is routed by `resolveInsertContext()` in `src/zotero.js`:

- **Active text-shape edit.** The modal captures the inline-editor handle on open (via `getActiveNotebookTextEditor()`), suspends the textarea's commit-on-blur, and routes the citation back through `TextEditor.insertAtSelection()` before resuming. Without this handshake the modal's focus change would commit the text shape and unmount the editor before the citation could land. `ui/text-editor.ts` exposes `suspendCommitOnBlur()` / `resumeCommitOnBlur()` / `insertAtSelection(text)` for this dance.
- **No active edit.** When invoked with no text-shape edit in flight, the modal drops a new `TextShape` containing the citation at the canvas viewport centre. `state.currentNotebookFileId` takes priority over the (always-mounted, hidden) CodeMirror view in the resolver — without that check, notebook inserts were silently routing into the hidden doc.
- **PDF snapshots.** When a PDF attachment is selected, the detail panel exposes an **Insert snapshot** checkbox plus a page selector. Picking the option downloads the PDF, rasterizes the chosen page to a WebP data URL at the configured render height, and adds an `ImageShape` flush to the right of the text shape (or side-by-side with a fresh `TextShape` in the no-edit case). The data URL lives only on the canvas — it does **not** populate the global Images folder, since the binary already round-trips inside the notebook's JSON envelope. A Cmd-drag from the canvas into a doc still promotes the shape to a global image via the existing `text-drag.js` flow.
- **Output format.** The detail panel carries a format dropdown with three options. `Title` produces `[Title](url)`. `Title (Author)` produces `[Title](url) (Author)` — the link wraps just the title so the author reads as adjacent context (this layout dodges a Hush link-decorator quirk where parens nested inside link text render ambiguously). `@citkey` produces `[@cite](url)`, a clickable Pandoc-style citation. Citation keys are read from Better BibTeX's `data.citationKey` or a `Citation Key:` line in `data.extra`; if neither is present we fall back to a `firstauthor + year` slug computed from the item's first creator. The selection round-trips between modal opens via `localStorage["hush_zotero_insert_format"]`.

PDF.js (`pdfjs-dist`) is lazy-loaded by `src/zotero-snapshot.js` so the worker bundle is only paid for by users who actually use the snapshot feature. The PDF binary itself is fetched server-side via the `download_zotero_pdf` Rust command (Zotero's `/file` endpoint redirects to a presigned S3 URL whose CORS policy rejects the webview's `null` origin) and cached at `{data_dir}/zotero_pdfs/{itemKey}.pdf` for instant re-renders of other pages without re-downloading. Render height, display height, and WebP quality are all on the Zotero settings tab.

### Drag and drop

File drops have three independent targets:

1. **Sidebar panel** — an "Import file" overlay appears inside `#panel-overlay` when it's open. Dropping creates a new document.
2. **Editor area** (doc mode) — `dragover`/`drop` on `#editor-container` appends text.
3. **Notebook canvas** — canvas-level `dragover`/`drop` in `input-handler.ts` handles images (→ image shapes) and text files (→ text shapes at drop position). Shelf drags also use canvas-level events. Cmd/Ctrl-dragging plain text wraps it in a markdown blockquote (`> …`) and creates the resulting TextShape at 14 px instead of the default 18 px — `addTextShapeAtPosition` accepts an `opts.fontSize` to support this.
4. **Floating panes** — Cmd-dragging a file from the sidebar past the panel edge creates a floating pane (see `pane/pane-manager.js`). Notebook panes can be attached to canvas coordinates. The notebook's `keydown` and `paste` handlers skip processing when `document.activeElement` is inside a `.floating-pane` to prevent input leaks.

### Touch handling

Pinch-zoom + two-finger pan are detected via `touchstart` / `touchmove` / `touchend` on the canvas element. The handlers count touches via `e.targetTouches.length` (touches whose `target` is the canvas) rather than `e.touches.length` (every touch on screen). That distinction matters with iOS Touch mode on: a finger holding the floating ⌘ pill in the bottom-left has the button as its target, so it isn't counted as a second canvas touch and doesn't kick the canvas into pinch-zoom while the other hand drags content out.

### Copy / paste

`Cmd+C` (or `Cmd+X`) inside a notebook serialises the current shape selection — plus any flowchart edges fully contained in it — into a `{ format: "steiner-clipboard", version: 1, shapes, flowEdges }` envelope and writes it to the OS clipboard via `navigator.clipboard.writeText(JSON.stringify(...))`. The same string is stashed on `window.__hushNotebookClipboard` so an immediate paste in the same session round-trips even when the OS clipboard write is rejected. `Cmd+V` first tries to parse the incoming clipboard text as a `hush-clipboard` / `steiner-clipboard` envelope (or falls back to the window stash) — on a match `state.pasteSerializedShapes(payload)` mints fresh ids for every shape, remaps `parentId` / `groupId` and flow-edge endpoints onto the new ids, attaches everything to the active layer, drops `pocketed`, and translates the cluster so its centre lands at the viewport centre (or at the supplied drop point). On no match we fall through to the existing "create a TextShape with the pasted text" path.

### Markdown lists in text shapes

`markdown.ts::parseLine` recognises `- `, `* `, `+ `, and `1. ` / `1)` numbered prefixes (and tolerates leading whitespace as a depth indicator). The parsed line carries `list: true`, `listMarker` (`"•"` or the literal number+dot), and `listDepth` (one step per two-space block). `renderer.ts` reserves a `1.5em` gutter for the marker and steps the indent by `1.2em` per depth level, so wrapped lines hang-indent under the first character of the text rather than reading as new entries. The first wrapped line draws the marker; continuation lines pass an empty `listMarker` so the indent is preserved without a duplicate bullet.

## Core Concepts

### State management

`DrawingState` extends `EventTarget`. All mutations go through its methods or property assignment + `notify(key)`. Notifications batch via `queueMicrotask` — multiple `notify()` calls in the same synchronous stack fire a single `"change"` event.

The `"change"` event carries `{ detail: { keys: string[] } }` so listeners can check what changed.

### Rendering

`renderer.ts` exports a single `render(canvas, state)` function called every frame via `requestAnimationFrame`. All draw functions are pure — they take a context and data, produce pixels, and return. The render state includes a `leftInset` field that shifts the pocket tray and pocketed shape cards to accommodate the sidebar, and a `dpr` field (device pixel ratio) injected by `notes-canvas.ts`'s render loop — the renderer no longer reads `window.devicePixelRatio` itself, so the file is genuinely free of global DOM state.

Two sibling files keep `renderer.ts` under the line limit while preserving purity: `renderer-selection.ts` (the dashed bbox + handle drawing for selected shapes, group-selection bounds, crop overlay, drag-selection box, plus the per-edge flowchart delete dot / X badge) and `renderer-background.ts` (background patterns: `dot-grid`, `grid`, `lined` — horizontal rules only, like notebook paper — and `isometric` — two sets of ±30° diagonals from horizontal, no vertical cross-line). All exports are pure functions called from `render()` and `renderForExport()`.

### Canvas themes

16 themes mirroring the Hush editor theme set (now self-contained under `src/themes/`), stored as flat objects with canvas-specific properties (`canvasBackground`, `foreground`, `headingColor`, `selection`, `accent`, `gridColor`, `uiBackground`, `uiBorder`). The active theme is resolved from the Hush editor style via `HUSH_TO_NOTEBOOK_THEME` in `notebook-bridge.js`.

### Shape types

| Type | Description |
|------|-------------|
| `TextShape` | Positioned text with markdown rendering, optional background color, auto-fit or manual width |
| `ImageShape` | Positioned image from base64 dataUrl, with optional non-destructive crop region |
| `DragAreaShape` | Dashed container box that parents shapes dropped inside it. Created by dragging out an area with the Drag Area tool, *or* by selecting 2+ shapes and clicking the Drag Area button in the bottom toolbar — the latter wraps the selection (16 px padding) and re-parents every selected shape into the new container in one shot. See `DrawingState.wrapSelectionInDragArea()` in `state.ts`. Holding `⌘` (or the Touch-mode `⌘` button) while dragging a child of a drag-area grows the area live to wrap the moving cluster (selection + group + flowchart descendants) with 20 px breathing room — `DrawingState.applyCmdHeldResize()` mutates the area's bounds each frame from the cmd-toggle key listeners in `input-handler.ts`. Releasing `⌘` contracts the area back, capped at the bounds it had at drag-start. |
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

- *Drag-to-connect.* Drag one or more text shapes and release them on top of another. Each dropped shape becomes a child of the target — its bounds snap to the right of the parent (with vertical stacking under any existing siblings) and its descendants follow by the same delta so the chain stays intact. The drop target is resolved from the live cursor position, not the selection centroid, so multi-select drops behave the same as single-shape drops.
- *Drag-to-merge (⌘ / Ctrl held).* Same gesture as above but holds Cmd/Ctrl on release: every dragged text shape's text is appended to the target (joined by blank lines), the originals are removed along with their flow edges, and the target re-fits its width if it wasn't manually sized. Useful for collapsing a cluster of fragments into one node without leaving arrows behind.
- *Edit-to-connect (⌘→ inside the inline text editor).* Commit the current edit, open a new editor positioned as a child of the just-edited node. The edge is wired by `commitText` once the user types something — `_pendingFlowParent` carries the parent id between the new-editor open and the eventual commit.
- *Edit-as-sibling (⌘↓).* Like ⌘→ but routes through the current node's parent (or, if there is no parent, opens a fresh editor below).

**Navigation.** ⌘← inside the inline editor jumps to the parent of the current node, ⌘↑ jumps back to the most-recently-edited node (a 16-entry MRU history kept on `DrawingState._recentEditIds`).

**Selection drag pulls descendants.** When the user drags one or more flowchart nodes, every transitive descendant moves with the selection so the layout remains coherent.

**Tidy.** When the selection contains any text shape that has flow children, a **Tidy subtree** button appears on the selection toolbar. Tidy keeps the root anchored at its current position and re-lays out every descendant so siblings can't overlap regardless of subtree depth or width — `tidyGapX` (default 150) sits between a parent's right edge and its children's left edges, `tidyGapY` (default 25) is the vertical gap between sibling subtree bounding boxes, and each parent is centered vertically against the block of its children. Implemented as `FlowchartLayer.tidy(rootId, shapes, opts?)` returning a `Map<id, {minX, minY}>`; `DrawingState.tidySubtree(id)` translates that into per-shape position deltas and records a single undo entry.

**Edge delete UI.** Every flowchart edge paints a small dot at its midpoint in screen space (`drawEdgeDeleteDot` in `renderer-selection.ts`) — a touch-friendly target that doesn't depend on hover. Tapping the dot, or hovering the curve with a mouse, sets `state.flowHoveredEdgeId`; the renderer then swaps the dot for a circular X badge (`drawEdgeDeleteButton`). Tapping the X removes the edge and records history; tapping anywhere else collapses the X back to the dot. The pointer-down hit-test in `state.ts::handlePointerDown` uses a 12 px screen-radius / zoom threshold against `getEdgeMidpoint`, so the dot, hover-X, and tap-to-confirm all share one target. Deleting a node removes every edge that referenced it (`flowchart.removeNode` is called from `deleteSelected`).

**Group anchoring.** `DrawingState` wires the flowchart layer with `getBounds: unionGroupBounds` so arrows anchor against the union of any group the endpoint belongs to (stroke clusters in particular). Without that the connect path elects one group member as the lead and the arrowhead lands inside the cluster — pointing at one stray stroke instead of the group's edge. Non-grouped shapes are unaffected: `unionGroupBounds` falls back to `getShapeBounds` when `groupId` is unset.

**Persistence.** Edges are JSON-serialised by `flowchart.serialize()` and round-trip through the same `notebook-content.ts` envelope used for shapes + layers (see "File storage" above). Legacy notebooks (bare `Shape[]` array) decode with `flowEdges = undefined`, which the deserialiser treats as "no edges" — no migration needed.

### Drawing

A drawing pill attached to the right edge of the bottom toolbar is always visible — it carries Undo, three brush slots, Slice, Erase, and Lasso. There is no "drawing mode" to enter — clicking any of those tools implicitly routes pointer input to the stroke engine by flipping `state.tool = "pen"` with the matching sub-tool. Clicking a non-drawing tool (Select, Text, Drag Area, Brainstorm) flips `state.tool` back and the pill visually dims. A small gray hamburger tab abuts the drawing pill's right edge; press-and-drag on it moves the entire combined toolbar (bottom + drawing pill) together via `state.drawingToolbarOffset`.

A long press during draw/erase promotes the in-flight stroke into a lasso pick. The hold duration is user-configurable from a slider in the Lasso flyout (500–2000 ms, default 500). Tapping the already-active Lasso button toggles the flyout open.

`DrawShape` instances are first-class shapes — they group, layer, pocket, route through the shelf, and participate in Hush's undo stack. Stroke rendering itself is delegated to a bake-to-canvas engine inside `src/notebook/drawing/`. Full architectural notes, the sync-shim invariants, and the engine deltas are in [README-DRAWING.md](README-DRAWING.md).

### Emoji stickers

Text shapes whose final content is *only* emoji (one or more grapheme clusters separated by whitespace) get rasterized into an `ImageShape` on commit. The detection lives in `src/notebook/emoji-sticker.ts` — `isEmojiOnly()` walks `Intl.Segmenter` grapheme clusters and matches each against an Extended Pictographic / Regional Indicator / keycap regex (so flags, ZWJ family sequences, and skin-tone modifiers all stay together). When the test passes, `emojiToDataUrl()` paints the string into a DPR-aware `<canvas>` at the platform's color emoji font and `commitText` swaps the new (or just-edited) shape over to an image of `STICKER_SIZE` × `STICKER_SIZE` (100 px). Stickers scale, crop, layer, pocket, and export like any other image; replacing an existing text shape with a sticker also drops it from the flowchart layer because images aren't flowable.

### Colors menu (text + background + saved styles)

Selecting any text or drag-area shape surfaces a single **Colors** button on the selection toolbar (`ui/selection-toolbar.ts::makeColorsMenu`). The popup stacks three sections, with the labels pinned to a fixed width so the swatch circles line up:

- **Text** — palette swatches mapped through `DrawingState.changeSelectedColor()`. Hidden when the selection has no text shape.
- **Bg** — palette swatches routed through `DrawingState.changeSelectedBackground()` (sets `backgroundColor` on text shapes; for drag-areas it derives matching stroke + 4 % fill).
- **Styles** — every saved `{color, backgroundColor, fontSize}` preset rendered as an `Aa` chip. Clicking a chip applies the preset via `DrawingState.applyTextStyle()`. **+ Style** snapshots the first selected text shape's combo and saves it. **Clear** resets text colour, background, and font size (back to the 18 px default). Hovering a chip reveals a small `×` for one-click delete. The Styles row is hidden when the selection has no text shape.

The popup is sticky — clicking a swatch or a saved chip applies the change but leaves the popup open so the user can iterate. Esc or a pointerdown outside closes it (both handled by document-level listeners installed once at toolbar mount).

Saved presets are **app-wide**, not per-notebook — they live in `AppSettings.notebookTextStyles` (`Vec<serde_json::Value>` on the Rust side, kept opaque so the JS owns the `{id, color, backgroundColor, fontSize}` shape) and round-trip through the standard `state.updateSettings({ notebookTextStyles })` path. The UI reads the list from `__hushState__.settings.notebookTextStyles` on each open, so newly-added entries appear without an explicit re-render path.

### Shelf panel

Right-side slide-out panel listing every shape organized by its drag-area container. Features search, #tag filtering, pin/unpin, and drag-to-restore. Themed to match the canvas theme.

- **Resizable** — the shelf's left edge is a hover-revealed drag handle (mirrors the sidebar's resizer pattern). The width is clamped to 200 px.. 60% of the viewport and persists in `notebookShelfWidth`. The shelf's open/close `transition: width 0.2s` is suspended for the duration of the drag so the rendered width tracks the cursor instead of chasing it.
- **Flowchart outline** — text shapes that participate in a flowchart edge are nested under their flow parent (depth = flow-tree depth) instead of rendering flat, with a small `→` marker on every flow node. Scoping is per drag-area, so a flow that spans drag-areas surfaces as multiple roots. Non-flow shapes still render at depth 0/1 as before.
- **Markdown formatting** — `buildLabel` strips a leading `#..######` heading marker (the row renders bold and picks up `theme.headingColor` so the shelf reads as a coloured outline) and a leading `> ` blockquote marker (the row renders italic — no extra chrome). Inline `==highlight==` runs are preserved in the label and `renderLabelInline` paints them with the same yellow background used by the search-snippet renderer. Originals still feed the search index.
- **Selection sync** — when a shape is selected on the canvas, its shelf row tints with the theme accent (background + 3 px left rail). The sync is automatic — the panel already re-renders on every `change` event, and `state.notify("selectedIds")` fires through the same channel.
- **Attached panes only** — `getNotebookCanvasPanes()` filters to `pane.attached === true`. Globally-pinned panes float across every document and aren't part of any one notebook's outline, so they're omitted from the shelf along with free-floating local panes. Clicking a pane row routes through `focusAndCenterPaneById()`, which reuses the search-result `centerPaneInViewport()` helper so the pane both pops to the front and recentres on screen.

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
