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
  selection-raster.ts     Per-selection rasterizer (2×) + the Rasterize / Recognize toolbar actions
  perf-hud.ts             On-canvas perf diagnostics overlay + tracer singleton, gated behind Settings > Debug > Performance HUD (see NOTEBOOK-PERF.md)
  ui/
    toolbar.ts             Bottom tool bar (tools, grid popup, bookmarks, undo/redo)
    selection-toolbar.ts   Context toolbar above selected shapes
    selection-colors-menu.ts  Colors popup (text/bg/border rows + saved-style chips), split out of selection-toolbar
    bookmarks-panel.ts     Camera bookmark dropdown
    shelf-panel.ts         Right-side hierarchical shape browser
    shelf-label.ts         Shelf label/search helpers (pure) — split from shelf-panel.ts
    text-editor.ts         Inline textarea overlay for text shapes
    brainstorm-input.ts    Persistent input for brainstorm mode
    reorder-banner.ts      Top-of-canvas "Reorder mode" pill + Exit button
    status-bar.ts          Zoom / shape count / selection count
    icons.ts               SVG icon system (currentColor theming)
    dom-helpers.ts         h() element builder, setStyles(), clearChildren()
    file-panel.ts          Standalone save/open — unused in Hush
    settings-panel.ts      Standalone settings modal — unused in Hush
  drawing/                 See README-DRAWING.md
    drawing-layer.ts       Engine-backed drawing layer + public API
    sync-shim.ts           state.shapes[] ↔ engine.strokes bridge
    brush-slots.ts         Toolbar slot row + brush-edit flyout
    tool-panel.ts          Drawing-tools controller: appends the divider, brush slots, Slice, Erase, Lasso directly to the bottom toolbar so the assembly is one continuous bar, then mounts the single drag handle (a thin strip on the bar's canvas-facing edge), the three drag-to-snap drop zones (top / bottom / left), and the lasso hold-time flyout
    bg-settings-fixed-button.ts  Fixed bottom-right canvas-surface row: rotation readout (tap = reset) + rotate-gesture toggle + Background settings button (pattern / spacing / opacity); wraps bg-settings-popup.ts and anchors its flyout above + right-aligned so it never clips the window edge
    pocket-blit.ts         Pocket / done-canvas blit helpers (4 functions) extracted from drawing-layer.ts
    selection-drag.ts      Hush↔engine select-drag controller — pause-shim, hide-chrome, commit-on-release ladder
    flyout-styles.ts       Injects the shared flyout stylesheets — 15-px-thick slider chrome (brush + lasso flyouts, dark-aware track) and the brush panel's themed component classes
    mini-palette.ts        15-px-thick A/H/Red + size shortcut strip pinned to the active brush slot
    layers-panel.ts        Layers dropdown (notebook-level, used by every shape type)
    engine/                Stroke engine (ported; 31 documented deltas — see README-DRAWING.md)
  pencil-bridge.js         Flips `setPencilOnly(true)` on iOS Tauri so finger contacts can't draw
```

### Integration with Hush

The notebook does **not** run as a separate window or webview. It mounts into the same `#app` DOM as the markdown editor, swapping visibility via the `.notebook-mode` CSS class on `#app` and `<body>`. All editor-specific chrome (CodeMirror, column resizers, drag region, outline panel, hover triggers) is hidden with `display: none !important` when `.notebook-mode` is active.

**notebook-bridge.js** is the JS glue layer between Hush's `AppState` and the notebook's `DrawingState`. It handles:

- **Mounting** — dynamically imports `NotesCanvas`, passes shortcut settings, loads shapes from the backing file. `main-modes.js` switches `#app` into `.notebook-mode` *before* awaiting the (async) mount so a large notebook never leaves the doc editor's "Start writing…" placeholder on screen while shapes decode. When the decoded snapshot carries more than `LARGE_NOTEBOOK_SHAPE_COUNT` (60) shapes, `mountNotebook` mounts a "Loading Notebook…" overlay (`.notebook-loading-overlay`, themed background + indeterminate progress bar) **and awaits a paint** (`_nextPaint`, double-rAF) *before* the synchronous `loadShapes` engine-sync pass — that pass blocks the event loop, so without forcing the paint first the overlay would never render (a `setTimeout`-gated overlay can't fire while the main thread is busy). It's torn down once shapes are loaded and the first render is queued. Small notebooks skip the overlay entirely — they finish in a frame and it would only flash.
- **Lifecycle serialization + data-loss guards** — `mountNotebook` / `unmountNotebook` queue behind each other (`_serializedLifecycle`): the open paths fire `notebook-unmount` and the next mount as events whose async handlers race, and an unserialized mount could reset the bridge state (fresh empty canvas, new file id) while the outgoing unmount was still mid-save — which force-saved an empty canvas over the newly opened file. Two further guards defend the save path itself: `_saveNotebookInner` captures its canvas + file id at entry and aborts any write if a lifecycle change swapped them, and `saveNotebook` refuses (before the unmount force-bypass) to save a canvas that is empty with no user edits in its undo history while the file on disk had content or failed to load (`_loadedShapeCount`) — the state a failed load leaves behind. The `notebook-unmount` handler in main-modes only calls `showEditor()` when `currentNotebookFileId` is null, so a notebook→notebook switch doesn't yank the freshly mounted notebook back to the editor.
- **Autosave** — the Hush 2-second autosave interval fires `notebook-autosave` events; the bridge serializes shapes to JSON and writes via the raw-body `save_file_raw` Tauri command: a JSON-args invoke would `JSON.stringify` (escape) the whole multi-MB content on the webview's JS thread — a per-save frame stall that dropped stroke points — while a `TextEncoder` byte body rides the IPC protocol untouched. Version snapshots are throttled independently of the file write (at most one per ~45 s of active writing, `NOTEBOOK_SNAPSHOT_MIN_MS`, with a pending-flag so unmount flushes a final slot), and an eligible snapshot folds into the same `save_file_raw` invoke via a `with-snapshot` header so the payload never crosses the bridge twice. `save_file` / `save_file_raw` / `create_snapshot` / `load_file` are async Tauri commands (sync commands run on the app main thread, and a multi-MB `.hushnote` deflate froze the webview for the whole write), and `hushnote::pack` / `unpack` fast-path envelope-form content with no embedded images past their parse → re-serialize round trips. The bridge serializes saves behind an in-flight promise and gates them three ways: a quiet-moment gate (never save while a stroke is in flight, the camera moved in the last 400 ms, or content changed in the last 1.5 s; a 15 s starvation guard overrides only the content-quiet window — it never fires mid-stroke or mid-pan, since the serialize stall is exactly what the gate exists to prevent), a 20 s cap on camera-only saves, and adaptive backpressure (a save that took X ms doesn't run again for 4X, capped at 10 s). Skipped ticks keep the dirty flag so nothing is lost. Camera-only saves also skip the expensive half of the serialize: `encodeNotebookContent` is split into `encodeNotebookBody` (shapes / layers / flowEdges / bookmarks — the multi-MB part on stroke-heavy notebooks) + `assembleNotebookContent` (envelope header + camera + background), and the bridge caches the body fragment from the last encode, so persisting a pan position reassembles the envelope in microseconds instead of re-serializing every shape on the JS thread. Content dirtiness itself is scoped to real mutations: transient interaction state (a two-finger gesture canceling the first finger's marquee, the flowchart edge-hover badge) repaints through dedicated notify keys (`"interaction"`, `"flowHoveredEdgeId"`) instead of `"shapes"`, so pan-only sessions never mark the notebook content-dirty.
- **Settings sync** — appearance, theme, and font are derived from the current Hush editor style (with a camelCase → kebab-case theme ID mapping in `HUSH_TO_NOTEBOOK_THEME`). Grid pattern, spacing, and opacity use dedicated notebook settings.
- **Perf HUD** — when **Settings > Debug > Performance HUD** (`settings.debugPerfHud`, default off) is on, the bridge mounts the on-canvas diagnostics overlay (`perf-hud.ts`) on the main notebook; a `settings-changed` listener applies the toggle live, and both teardown paths unmount it. See NOTEBOOK-PERF.md for how to read its reports.
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
  "camera":    {...},   // optional saved viewport — { x, y, zoom, rotation? }
  "background": {...}   // optional per-notebook bg — { pattern, spacing, opacity, rotationEnabled? }
}
```

`decodeNotebookContent` parses this and also accepts the legacy bare `Shape[]` array form (older notebooks before the envelope migration) so existing files round-trip without rewriting on load. `bookmarks` was added later still and is treated as optional — older envelopes decode with `bookmarks = undefined` and the bridge skips the assignment. `background` is likewise optional (any subset of `pattern` / `spacing` / `opacity`): on mount the bridge applies the global notebook-settings defaults first, then overlays the saved per-notebook values, so a notebook reopens with its own background and a theme / style switch no longer resets it. The bg-settings popup fires a `notebook-bg-changed` document event that the bridge and pane I/O cache and write back on the next autosave. Every save / load / sync path goes through this pair (autosave in `notebook-bridge.js`, pane I/O in `pane/pane-content.js`, sync pull in `reloadNotebookShapes`, plus `.hushnote` export in `notebook-export.ts`) so the on-disk format stays consistent. Bookmark mutations call `state.notify("bookmarks")`, which `notes-canvas.ts` forwards as a `notebook-change` CustomEvent so the autosave pipeline picks it up alongside shape edits.

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
| `shortcutNbResetZoom` | `Mod+0` | Reset zoom to 100% |

Cmd + arrow keys align the current selection along the matching edge (Left/Right/Up/Down → left / right / top / bottom). Cmd + Shift + arrow keys distribute along the axis of the arrow — horizontal arrows distribute horizontally, vertical arrows vertically. These bindings live directly in `input-handler.ts` rather than the settings-driven shortcut table; the underlying state methods (`alignSelected`, `distributeSelected`) are the same ones the selection-toolbar's align flyout calls.

Draw sub-tools (Lasso, Erase, Slice, brush slots) are reached through the right half of the unified toolbar (past the divider) — no keyboard shortcuts; the E/X hints in the button tooltips are placeholders. Hold space (or two-finger drag) to pan.

These appear in Settings > Shortcuts > Notebooks and are stored in `AppSettings` (Rust) alongside the editor shortcuts. The input handler reads them from Hush settings at mount time via the `NotebookShortcuts` interface.

Global shortcuts (`Cmd+P` command palette, `Cmd+,` settings, `Cmd+Shift+F` fullscreen) work in notebook mode through the window-level keydown handler in `main.js`.

### Command palette

The command palette is context-sensitive. When a notebook is open:

- **Shown**: New document, New notebook, Files, Styles, Versions, Export, Toggle fullscreen, Settings, **Open shelf**, **Start brainstorm**, **Insert Reference** (Zotero)
- **Hidden**: Ratchet mode, Private mode, Typewriter mode (palette entry is doc-only, but the keyboard shortcut still toggles the flag so doc panes within a notebook can use it — the main boundary line is hidden via `body.notebook-mode` CSS), Show repeats, Highlight sentence, Outline view, Word count

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
3. **Notebook canvas** — canvas-level `dragover`/`drop` in `input-handler.ts` handles images (→ image shapes) and text files (→ text shapes at drop position). Shelf drags also use canvas-level events. Cmd/Ctrl-dragging plain text wraps it in a markdown blockquote (`> …`) and creates the resulting TextShape at 14 px instead of the configured default (`state.fontSize`, driven by Settings > Editor > Notebook text > Default size, 16 px out of the box) — `addTextShapeAtPosition` accepts an `opts.fontSize` to support that override and falls back to `state.fontSize` for every other call site.
4. **Floating panes** — Cmd-dragging a file from the sidebar past the panel edge creates a floating pane (see `pane/pane-manager.js`). Notebook panes can be attached to canvas coordinates. The notebook's `keydown` and `paste` handlers skip processing when `document.activeElement` is inside a `.floating-pane` to prevent input leaks.

### Touch handling

Pinch-zoom + two-finger pan are detected via `touchstart` / `touchmove` / `touchend` on the canvas element. The handlers count touches via `e.targetTouches.length` (touches whose `target` is the canvas) rather than `e.touches.length` (every touch on screen). Zoom engages only after the finger spread drifts past a 12 px dead-zone (`PINCH_ENGAGE_PX`, mirroring the drawing engine's `PINCH_START`); below it the gesture is a pure pan at locked zoom, so the natural wobble of two fingers no longer produces a stream of per-frame micro-zooms that rescale (and visibly shimmer) every stroke. On engage the start references rebaseline to the current frame so zoom ramps up with no jump. In pen mode the same gesture arrives through the drawing engine's recognizer instead (`gestures.js` — the SVG overlay owns the touches there); its pan/pinch evaluation is rAF-coalesced and its camera handler in `notes-canvas.ts` rebaselines at pinch engage, so pen-mode panning matches the canvas handler's feel (engine delta #24 in README-DRAWING.md).

**Canvas rotation (opt-in).** An icon-only rotate toggle sits beside the bottom-right background-settings button, with a live degree readout beside it while the option is on — tapping the readout snaps the rotation back to 0. When the toggle is on, twisting during a two-finger pan/zoom rotates the canvas about the finger midpoint — `Camera` gains an optional `rotation` (radians), applied between zoom and translation (`screen = c + R(rotation) · zoom · world`). Rotation engages with its own hysteresis (~8.6°) and every engagement rebaselines, so plain pans never wobble the horizon. All screen↔world math funnels through `screenToCanvas` / `canvasToScreen` in `utils.ts` (both rotation-aware); the renderer, background patterns, drawing-layer wrapper transform, re-anchor viewport math, minimap, and pinned-box compensation handle the rotated frame explicitly. Turning the toggle off — or `Mod+0` reset zoom — snaps rotation back to 0. Exports and gutter mode always render axis-aligned. The flag persists per-notebook as `background.rotationEnabled`. The drawing wrapper carries `will-change: transform` so the pan is a stable GPU-composited transform with no per-frame repaint of the baked strokes. That distinction matters with iOS Touch mode on: a finger holding the floating ⌘ pill in the bottom-left has the button as its target, so it isn't counted as a second canvas touch and doesn't kick the canvas into pinch-zoom while the other hand drags content out.

### Copy / paste

`Cmd+C` (or `Cmd+X`) inside a notebook serialises the current shape selection — plus any flowchart edges fully contained in it — into a `{ format: "steiner-clipboard", version: 1, shapes, flowEdges }` envelope and writes it to the OS clipboard via `navigator.clipboard.writeText(JSON.stringify(...))`. The same string is stashed on `window.__hushNotebookClipboard` so an immediate paste in the same session round-trips even when the OS clipboard write is rejected. `Cmd+V` first tries to parse the incoming clipboard text as a `hush-clipboard` / `steiner-clipboard` envelope (or falls back to the window stash) — on a match `state.pasteSerializedShapes(payload)` mints fresh ids for every shape, remaps `parentId` / `groupId` and flow-edge endpoints onto the new ids, attaches everything to the active layer, drops `pocketed`, and translates the cluster so its centre lands at the viewport centre (or at the supplied drop point). On no match we fall through to the existing "create a TextShape with the pasted text" path.

### Markdown lists in text shapes

`markdown.ts::parseLine` recognises `- `, `* `, `+ `, and `1. ` / `1)` numbered prefixes (and tolerates leading whitespace as a depth indicator). The parsed line carries `list: true`, `listMarker` (`"•"` or the literal number+dot), and `listDepth` (one step per two-space block). `renderer.ts` reserves a `1.5em` gutter for the marker and steps the indent by `1.2em` per depth level, so wrapped lines hang-indent under the first character of the text rather than reading as new entries. The first wrapped line draws the marker; continuation lines pass an empty `listMarker` so the indent is preserved without a duplicate bullet.

## Core Concepts

### State management

`DrawingState` extends `EventTarget`. All mutations go through its methods or property assignment + `notify(key)`. Notifications batch via `queueMicrotask` — multiple `notify()` calls in the same synchronous stack fire a single `"change"` event.

The `"change"` event carries `{ detail: { keys: string[] } }` so listeners can check what changed.

### Rendering

`renderer.ts` exports a single `render(canvas, state)` function. The render loop in `notes-canvas.ts` is **dirty-driven**, not free-running: every render-affecting mutation flows through `DrawingState.notify` (which fires a batched `change` event), so the loop subscribes to that, renders on change or while an interaction is in flight (drag / stroke / pan / selection box), and then parks itself (it stops rescheduling `requestAnimationFrame`) until the next change. An idle canvas therefore does zero redraws — the biggest power win for canvas-heavy sessions, multiplied across every live canvas (main view, panes, stack columns, gutters). Async-loaded images schedule a one-off repaint on decode so they still appear. All draw functions are pure — they take a context and data, produce pixels, and return. The render state includes a `leftInset` field that shifts the pocket tray and pocketed shape cards to accommodate the sidebar, a `dpr` field (device pixel ratio) injected by `notes-canvas.ts`'s render loop — the renderer no longer reads `window.devicePixelRatio` itself, so the file is genuinely free of global DOM state — and a `shadowHeaders` array (gutter panes only; see the gutter-pane section in `README-TECHNICAL.md`) consumed by `drawShadowHeaders` to paint faded doc-header labels with a horizontal rule above each.

Two sibling files keep `renderer.ts` under the line limit while preserving purity: `renderer-selection.ts` (the dashed bbox + handle drawing for selected shapes, group-selection bounds, crop overlay, drag-selection box, the per-edge flowchart delete dot / X badge, plus `drawShadowHeaders` for the gutter pane overlay) and `renderer-background.ts` (background patterns: `dot-grid`, `grid`, `lined` — horizontal rules only, like notebook paper — and `isometric` — two sets of ±30° diagonals from horizontal, no vertical cross-line). All exports are pure functions called from `render()` and `renderForExport()`.

`DrawingState` exposes a small surface for gutter mode that the canvas treats as no-ops outside of it: `gutterScrollDOM` (when set, vertical pan, wheel, and `focusShape` route to the host doc's scroller; zoom is disabled and `camera.y` tracks `-scrollTop`); `shadowHeaders` (the doc-heading list above). All gutter geometry, doc scanning, anchor reflow, and toolbar wiring live in `src/project/gutter.js` (gutter is owned by the `.hushproject` module).

### Canvas themes

16 themes mirroring the Hush editor theme set (now self-contained under `src/themes/`), stored as flat objects with canvas-specific properties (`canvasBackground`, `foreground`, `headingColor`, `selection`, `accent`, `gridColor`, `uiBackground`, `uiBorder`, plus an optional `linkColor`). The active theme is resolved from the Hush editor style via `HUSH_TO_NOTEBOOK_THEME` in `notebook-bridge.js`. The active style's colour overrides are layered on top in the `DrawingState.theme` getter: `foregroundOverride` (canvas text + toolbar icons), `headingColorOverride` (markdown headings), and `linkColorOverride` (links/wikilinks, falling back to `foreground`) — all threaded through `computeNotebookSettings` → `applySettings`.

### Shape types

| Type | Description |
|------|-------------|
| `TextShape` | Positioned text with markdown rendering, optional background color, auto-fit or manual width |
| `ImageShape` | Positioned image from base64 dataUrl, with optional non-destructive crop region. Appearance-aware images additionally carry `dataUrlDark` — `dataUrl` is the light-appearance raster and `dataUrlDark` the dark one; the image cache loads the variant matching the active theme and swaps `src` in place on appearance switches. Produced by rasterizing theme-tracking content. |
| `DragAreaShape` | Dashed container box that parents shapes dropped inside it. Created by dragging out an area with the Drag Area tool, *or* by selecting 2+ shapes and clicking the Drag Area button in the bottom toolbar — the latter wraps the selection (16 px padding) and re-parents every selected shape into the new container in one shot. See `DrawingState.wrapSelectionInDragArea()` in `state.ts`. Holding `⌘` (or the Touch-mode `⌘` button) while dragging a child of a drag-area grows the area live to wrap the moving cluster (selection + group + flowchart descendants) with 20 px breathing room — `DrawingState.applyCmdHeldResize()` mutates the area's bounds each frame from the cmd-toggle key listeners in `input-handler.ts`. Releasing `⌘` contracts the area back, capped at the bounds it had at drag-start. Selecting a single drag-area exposes a **Pin** toggle (screen-anchored box — the canvas scrolls beneath it) and an **Arrange** flyout (grid + reorder modes) on the selection toolbar — both detailed in the Drag-area actions section below. |
| `DrawShape` | Freehand stroke — array of points + brushId + size + mode. Rendered by the drawing engine (see [README-DRAWING.md](README-DRAWING.md)). |

All shapes extend `ShapeBase`: `{ id, color, parentId?, groupId?, pocketed?, layerId? }`.

### Layers

Layers are notebook-level and host every shape type, not just drawings. `state.layers` is an ordered array (top-first); every shape carries an optional `layerId` and legacy shapes fall back to the bottom layer on load. The renderer walks bottom-to-top and skips hidden layers. The layers UI (`drawing/layers-panel.ts`) is mounted on the bottom toolbar. See README-DRAWING.md for details.

### Pocket system

A temporary stash on the **right edge** of the canvas, flush against the shape shelf. Users hold-drag a shape toward the right edge to pocket it. Pocketed items are drawn at fixed screen positions (independent of camera), shown on light-blue cards. The pocket tray, drop zone, and entries anchor against `DrawingState.pocketRightInset` — a getter that prefers a right-docked pane's inboard edge (`dockedRightWidth`) and otherwise falls back to the shelf footprint (`rightInset`), so the tray always sits just inboard of whatever right-side chrome is widest. (`computePocketLayout` / `findPocketedShapeAtScreen` take this inset as their last argument; the renderer's `drawPocketTray` mirrors its rounded corners to face the canvas interior.)

### Undo/redo

`UndoManager` stores up to 100 checkpoints. `recordHistory()` is called after each completed user action (not during continuous drag/resize — only on pointer-up). Checkpoints use **structural sharing**: shapes are shared by reference across checkpoints and with the live `state.shapes` array (only the array itself is copied), so recording after a pen-up costs one array copy instead of a deep clone of every stroke point in the notebook — the clone was the dominant per-stroke cost (and, retained ×100, the memory blow-up) in long handwriting sessions. This makes shape immutability **load-bearing**: a `Shape` must never be mutated in place once it's in `state.shapes` — every mutation replaces the object (`shapes.map((s) => ({ ...s, ... }))`). The drawing engine's sync shim already required this (its diff is identity-based); the undo manager now does too. Layers and flow edges are tiny and defensively copied per element in both directions. A side benefit: after undo/redo, unchanged shapes keep their identity, so the shim re-applies only the strokes that actually differ.

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

**Group anchoring.** `DrawingState` wires the flowchart layer with `getBounds: unionGroupBounds` so arrows anchor against the union of any group the endpoint belongs to (stroke clusters in particular). Without that the connect path elects one group member as the lead and the arrowhead lands inside the cluster — pointing at one stray stroke instead of the group's edge. Non-grouped shapes are unaffected: `unionGroupBounds` falls back to `getShapeBounds` when `groupId` is unset. The drop-target highlight matches: when the hovered `flowDropTargetId` shape carries a `groupId`, `renderer.ts` expands the dashed outline to the union of the whole group (skipping pocketed members) so dragging onto a cluster of brushstrokes highlights the entire node, not just the one member under the cursor.

**Persistence.** Edges are JSON-serialised by `flowchart.serialize()` and round-trip through the same `notebook-content.ts` envelope used for shapes + layers (see "File storage" above). Legacy notebooks (bare `Shape[]` array) decode with `flowEdges = undefined`, which the deserialiser treats as "no edges" — no migration needed.

### Drag-area actions

A single drag-area selection surfaces two container-scoped controls on the selection toolbar (`ui/selection-toolbar.ts`): a **Pin** toggle and one **Arrange** flyout (colors-popup pattern) that gathers **Arrange as grid** (with its column stepper inline), **Swap-reorder mode**, and **Ripple-reorder mode** — they used to sit on the toolbar as three separate icons and crowded it.

**Pinning.** A pinned drag-area holds its on-screen position while the camera pans — the canvas scrolls beneath it, and its transitive contents ride along. Implemented as world-space compensation (`DrawingState._compensatePinnedForCamera`, subscribed to camera notifications in the constructor): on every camera pan the pinned box + contents translate by the pan's world delta, so hit-testing, selection, rendering, undo, and persistence all keep working on plain world coordinates. Zoom changes rebase the anchor instead of compensating (pinning is a scroll anchor, not a screen-space HUD), and programmatic viewport placements — mount restore, pane centring, stack tiles — call `rebasePinAnchor()` so they don't read as a giant pan. Pinned boxes render as floating panels: an opaque canvas-coloured backing under the usual tint, a thin 1 px solid border instead of the dashed outline, and a small pushpin badge in the top-right corner. The flag is `DragAreaShape.pinned` and rides the JSON envelope.

**Arrange as grid** is the dual-purpose entry: clicking the `grid-mode` button runs `DrawingState.arrangeDragAreaAsGrid(dragAreaId, cols?)` *and* opens a `[− N cols +]` flyout (same stepper geometry as Text-size). The flyout pre-fills with the last column count chosen for that drag-area (kept in a `lastGridCols` map inside the toolbar closure) or `ceil(sqrt(n))` on first open; ± steps clamp to `1..unitCount` and re-run the arrange. The geometry itself lives in `arrangeShapesAsGrid(children, fontFamily, gap, centerPoint, cols?)` in `utils.ts`: it buckets shapes into **units** (each ungrouped shape, plus one unit per `groupId` with union bounds), sizes cells to the widest / tallest unit, falls back to `cols = ceil(sqrt(n))` when no explicit count is supplied, and sorts by reading order (row-bands with a `cellH × 0.6` tolerance, then left-to-right inside each band) so the post-arrange layout matches the user's mental map. Each unit's members translate by a single shared delta so groups arrive fully intact. After placement, the drag-area is resized to fit loosely around the result with a 100 px margin on every side — it both grows and shrinks here so cycling the column count through the flyout doesn't leave behind oversized boundaries.

**Reorder modes** are modal — `DrawingState.toggleReorderMode(id, mode)` sets `state.reorderDragAreaId` to the drag-area's id and `state.reorderMode` to `"swap"` or `"ripple"`. Re-clicking the active mode's button (or calling with the same id + same mode) turns the whole thing off; clicking the other mode's button while active switches mode without leaving the modal. `state.exitReorderMode()` is the unconditional turn-off used by the banner's Exit button and the `Esc` handler so the wrong mode parameter can't silently swap behaviour. While set:

- `renderer.ts::drawDragArea` paints the active drag-area with a solid 3 px theme-accent border instead of the default dashed gray, so the modal container is unmistakeable.
- `ui/reorder-banner.ts` mounts a top-of-canvas pill — text reads "Swap-reorder mode — drag an item onto another to swap places" or "Ripple-reorder mode — drag an item onto another to insert it there" depending on `state.reorderMode` — with an explicit **Exit ×** button. The same exit gesture happens on `Esc` (handled in `input-handler.ts`'s top-of-`keydown` slot, ahead of the editable-focus guard so a stale input can't trap the user).
- The pointerMove flowchart-hover probe is skipped (`!state.reorderDragAreaId` gate around the `draggingIds` collector) so the "prospective parent" outline doesn't mislead the user mid-reorder.
- The pointerUp drop path pre-empts re-parenting and the flowchart drop entirely: `_handleReorderDrop` branches on `state.reorderMode` and either calls `_applySwapReorder` (trade slots between the two units) or `_applyRippleReorder` (remove dragged unit, re-insert at target's slot, shift intermediates by one). A drop in empty canvas — or an "incoherent" multi-select that spans multiple groupIds — snaps every dragged child back to its pre-drag location.

**Group-aware reorder.** Both sides of the reorder expand to their full group on drop. The "dragged unit" is a single shape *or* every selected shape sharing one `groupId` (selection promotion already pulls all group members when the user pointer-downs on any one of them); the "target unit" is the cursor-hit shape, expanded to its `groupId` siblings if any. Members of each unit translate by a single shared delta so relative offsets within each group are preserved.

**Reading-order slots.** Ripple-reorder bucketing lives in `_collectReorderUnits()` — one unit per ungrouped shape, one unit per `groupId`, with bounds taken from `_reorderOrigBounds` for any dragged member so the dragged unit's slot stays anchored to its pre-drag position even while the cursor pulls members elsewhere. Units sort by reading order (`minY` ascending with a 60 %-of-the-tallest-unit row-band tolerance, then `minX` ascending) so the slot list matches the standard western reading flow.

**Ghost preview.** `_handleReorderHover` runs every pointermove during a reorder drag and updates `state.reorderHoverTargetId`. On change, `_recomputeReorderPreview` bakes positioned `Shape` clones at the destinations — `draggedShapes` shifted to the target's slot, `targetShapes` shifted to either the dragged unit's pre-drag slot (swap mode) or the slot adjacent to the target in the direction of the dragged unit's old slot (ripple mode) — plus the matching `ghostA` / `ghostB` boundary rectangles. The renderer dims `globalAlpha` to 0.55 and re-uses `drawTextShape` / `drawImageShape` / `drawDragArea` / `drawStroke` to paint the clones, then frames them with `drawReorderPreview` (dashed accent rects from `renderer-selection.ts`). Stroke ghosts fall back to the plain `drawStroke` polyline since the textured drawing-engine canvas isn't reachable from the main render pass — fine for a translucent preview. The preview is cached at hover-change time and lives in absolute world coords so it stays put while the cursor keeps moving inside the same target's hit area.

**Lifecycle.** `deleteSelected` auto-exits reorder mode when the active drag-area is the one being deleted (otherwise the solid border would paint against a phantom id). On drop, `_handleReorderDrop` clears `_reorderOrigBounds`, `reorderHoverTargetId`, and `reorderPreview` before recording history. The snapshot itself stores full pre-drag `Bounds` (not just TL) so the renderer can paint same-sized ghosts and the reorder math can shift groups uniformly.

### Drawing

The drawing tools (three brush slots, Slice, Erase, Lasso) are appended directly onto the bottom toolbar past a 1-px divider so the assembly reads as one continuous bar. There is no "drawing mode" to enter — clicking any of those tools implicitly routes pointer input to the stroke engine by flipping `state.tool = "pen"` with the matching sub-tool. Clicking a non-drawing tool (Select, Text, Drag Area, Brainstorm) flips `state.tool` back and the drawing tools visually dim.

A single thin **drag handle** runs along the bar's canvas-facing edge (bottom edge when pinned top, top edge when pinned bottom, right edge when vertical). Press-and-drag on it repositions the whole bar; while dragging, three highlighted **snap zones** appear (centred on the top edge, the bottom edge, and the left edge) and releasing inside one sets `state.drawingToolbarPosition` to `"top"` / `"bottom"` / `"left"` (left implies vertical). A drop outside any zone leaves the bar at `"custom"` with a free `state.drawingToolbarOffset`. `state.drawingToolbarVertical` is a derived getter (`position === "left"`). When the window is too narrow to fit the bar at full size, `toolbar.ts` adds `.notebook-toolbar-compact` (¾-size icons, two-row `flex-wrap`). Background settings, orientation-rotate, and collapse are no longer end-caps: background lives in a fixed bottom-right button (`bg-settings-fixed-button.ts`), orientation is reached through the left snap zone, and the collapse affordance was removed in favour of the responsive two-row layout (`drawingToolbarCollapsed` survives only as a `false` compatibility getter).

A long press during draw/erase promotes the in-flight stroke into a lasso pick. The hold duration is user-configurable from a slider in the Lasso flyout (500–2000 ms, default 500). Tapping the already-active Lasso button toggles the flyout open.

`DrawShape` instances are first-class shapes — they group, layer, pocket, route through the shelf, and participate in Hush's undo stack. Stroke rendering itself is delegated to a bake-to-canvas engine inside `src/notebook/drawing/`. Full architectural notes, the sync-shim invariants, and the engine deltas are in [README-DRAWING.md](README-DRAWING.md).

### Rasterize & handwriting recognition (selection toolbar)

Two raster-backed actions share one pipeline (`selection-raster.ts`), which mirrors the export path: `renderForExport()` paints the selected text / image / drag-area shapes into an offscreen canvas at **2×**, then the drawing layer re-renders just the selected strokes on top via `DrawingLayer.renderStrokesTo(ctx, hushIds)` — a new per-stroke render entry point (backed by engine delta #20's `renderStrokeTo`), so unselected strokes overlapping the same region never leak into the raster the way a done-canvas blit would. `collectRasterShapes()` expands the selection with the transitive children of any selected drag-area — rasterizing a container captures its contents.

- **Rasterize as image** — shown for every selection (except a lone ImageShape, where it'd be a no-op); always the last feature icon on the toolbar, right before Delete. Bakes the collected shapes into a single ImageShape on a transparent background; the image is sized to the original bounding box, so the 2× pixels display scaled back down and stay crisp on HiDPI. Theme-tracking selections (auto/heading strokes, auto/heading text colours or borders — `selectionIsThemeTracking()`) are baked TWICE, once per appearance via `DrawingState.themeForVariant()` with `DrawingLayer.renderStrokesTo`'s per-appearance colour overrides, and the result is an appearance-aware image (`dataUrl` light + `dataUrlDark` dark) that keeps following light/dark switches; explicitly-coloured selections produce a single raster as before. `DrawingState.replaceShapesWithImage()` commits the swap in one undo entry — it keeps a shared surviving drag-area parent and the topmost replaced shape's layer, drops replaced nodes from the flowchart (images aren't flowable), and selects the new image.
- **Recognize handwriting** — one selection-toolbar button, two on-device engines routed by `recognizeSelection()` in `selection-raster.ts`: **strokes → Google ML Kit Digital Ink** (iPad only), **images → Apple Vision**. Visibility comes from `canRecognizeSelection()` — a strokes-only selection on desktop hides the button, since Google doesn't ship ML Kit for macOS and stroke recognition is deliberately iPad-only; a mixed selection on iPad prefers the strokes. Recognized text lands as a TextShape 16 px beneath the source (the ink/image is left in place — replacing it is a planned follow-up), and failures surface as a transient bottom-centre notice from `src/recognition/recognition-ui.ts`.
- **The ML Kit stroke path** sends no raster: the `DrawShape` point sequences go straight to the recognizer, shifted to the selection bbox origin with the bbox as the `MLKWritingArea`. Timing uses the real capture deltas where points carry timestamps (engine delta #21 stamps `t: e.timeStamp` per point — the recognizer models pen velocity), rebased onto one monotonic clock with 300 ms synthesized pen-lift gaps; strokes drawn before timing shipped fall back to ~15 ms/point. The Rust command (`src-tauri/src/commands/handwriting_ink.rs`) reaches the MLK* Objective-C classes **dynamically** (`AnyClass::get`, completion blocks via `block2`, NSExceptions caught via `objc2::exception`) rather than linking a framework — the binary builds with or without the pod and errors descriptively without it. ML Kit ships via CocoaPods only, so `scripts/ios-add-mlkit-pod.mjs` (chained into `npm run ios:init`, standalone as `npm run ios:add-mlkit`) adds the pod, removes the phantom macOS target from the generated Podfile, and injects a `post_install` hook that patches the Pods xcconfig: it restores the arch-conditional search paths the Pods xcconfig shadows (Tauri's Rust staticlib in `Externals/`, the Swift toolchain lib dirs) and replaces the global `-ObjC` + `-framework`/`-l` references to the Google archives with per-archive `-force_load` so each is loaded exactly once (global `-ObjC` detonates on Tauri's `libapp.a`, which embeds its Swift objects once per plugin). The per-language model (~20 MB) downloads on first use: the download's `NSProgress` fraction streams to the frontend over the `mlkit-ink-download-progress` Tauri event and `recognition-ui.ts` shows a one-time-download progress pill; the command waits up to 5 minutes before asking the user to retry.
- **The Vision image path** rasterizes the selected images tuned for the recognizer — adaptive scale targeting a ~1600 px long side (clamped 1–6×, capped at 4096 px), a 24 px whitespace margin, dark-theme rasters inverted to dark-on-light — and hands the PNG to the `recognize_handwriting` command (`src-tauri/src/commands/handwriting.rs`): Apple's on-device **Vision** framework via raw `objc2` message sends, `VNRecognizeTextRequest` at the "accurate" level, pinned to the newest recognizer revision the OS supports, with language correction and auto-detection where available. Both engines' frontend entry points live in **`src/recognition/handwriting.ts`** — deliberately outside `src/notebook/` so Docs can adopt the same engine later. Everything is on-device; no network beyond the one-time model download.

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
- **Shapes are immutable once in `state.shapes`** — mutations replace the shape object, never write fields in place. Two subsystems depend on this: the sync shim's identity diff, and the undo manager's structurally-shared checkpoints (an in-place write would silently rewrite history entries holding the same reference).

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
