# Notebook — Technical Overview

Extension of [README-TECHNICAL.md](README-TECHNICAL.md). The notebook is a canvas-based visual notes editor in `src/notebook/` (vanilla TypeScript, no framework), originally a standalone app ([tauri-drawing](https://github.com/laffan/tauri-drawing)) adapted to run as an integrated file type. The freehand drawing layer and its stroke engine have their own deep dive: [README-DRAWING.md](README-DRAWING.md).

## Architecture

```
src/notebook/
  notebook-bridge.js      Hush ↔ canvas glue: mount/unmount, autosave, settings sync
  notes-canvas.ts         Public API class — orchestrates canvas, UI, render loop
  state.ts                DrawingState — all canvas state + mutations (line-cap exception)
  state-helpers.ts        Pure helpers (find, resize, crop, link hit-test, pocket hit-test)
  renderer.ts             Canvas 2D draw functions — pure, no DOM/global access
  renderer-selection.ts   Selection / group / crop / lasso highlights, shadow headers
  renderer-background.ts  Background patterns (dot-grid, grid, lined, isometric)
  input-handler.ts        DOM events → state methods; reads shortcuts from Hush settings
  markdown.ts             Inline markdown parser for text shapes
  themes.ts               16 canvas themes mirroring the editor set
  types.ts                Shape types, constants, palettes
  undo-manager.ts         Snapshot undo/redo (100 entries, structural sharing)
  utils.ts                Geometry, hit testing, text measurement, alignment, grid layout
  flowchart.ts (+ flowchart-geometry.ts)  Portable flowchart layer (ported from Steiner)
  notebook-content.ts     Persistence envelope encode/decode
  selection-raster.ts     Rasterize / Recognize-handwriting pipeline
  emoji-sticker.ts        Emoji-only text shapes → image stickers
  perf-hud.ts             On-canvas perf diagnostics (Settings > Debug > Performance HUD)
  ui/                     Toolbar, selection toolbar + colors menu, shelf panel, inline
                          text editor, brainstorm input, bookmarks, status bar, icons, h()
  drawing/                Drawing layer + stroke engine — see README-DRAWING.md
  pencil-bridge.js        iOS: pencil-only inking + Apple Pencil double-tap listener
```

The notebook mounts into the same `#app` DOM as the editor (visibility swapped via the `.notebook-mode` class) — no separate window or webview.

### State, rendering, notifications

`DrawingState` extends `EventTarget`; all mutations go through its methods or `notify(key)`. Notifications batch via `queueMicrotask` into a single `"change"` event carrying `{ keys }`.

The render loop is **dirty-driven, not free-running**: it renders on change events or during an in-flight interaction, then parks (stops rescheduling rAF) until the next change. An idle canvas does zero redraws — multiplied across every live canvas (main view, panes, stack columns, gutters). Async-loaded images schedule a one-off repaint on decode. All renderer functions are pure — they take a context + data; `dpr` is injected by the render loop rather than read from `window`.

**Repaint-only notify keys** (`"interaction"`, `"flowHoveredEdgeId"`, …) exist so transient visuals never mark the notebook content-dirty — a pan-only session must not trigger content saves.

### The load-bearing invariants

- **Shapes are immutable once in `state.shapes`** — every mutation replaces the object (`shapes.map(s => ({ ...s, … }))`). Two subsystems depend on it: the drawing sync-shim's identity diff, and the undo manager's **structurally shared** checkpoints (shapes shared by reference across checkpoints; recording after a pen-up costs one array copy, not a deep clone of every stroke — an in-place write would silently rewrite history entries).
- `recordHistory()` is called on completed actions (pointer-up), never per-frame.
- State mutations go through `DrawingState`; the engine's `strokes[]` is only touched via engine methods (see README-DRAWING.md).

### Bridge lifecycle + autosave (`notebook-bridge.js`)

The mount/unmount paths are **serialized** (`_serializedLifecycle`) — the open paths fire `notebook-unmount` and the next mount as racing async events, and an unserialized mount once reset bridge state while the outgoing unmount was mid-save, force-saving an empty canvas over the newly opened file. Further save guards: `_saveNotebookInner` captures canvas + file id at entry and aborts if a lifecycle change swapped them; `saveNotebook` refuses to write an empty, never-edited canvas over a file that had content or failed to load. Large notebooks (>60 shapes) mount a loading overlay and **await a paint** (double-rAF) before the synchronous engine-sync pass — that pass blocks the event loop, so nothing gated on a timer could ever render first.

Autosave rides the app's 2 s tick but is heavily gated, because serializing a multi-MB envelope on the JS thread drops in-flight stroke points:

- Writes go through the raw-body `save_file_raw` command (a JSON-args invoke would `JSON.stringify` the payload on the JS thread); the Rust command is async (a sync command's deflate froze the webview).
- A **quiet-moment gate**: never save mid-stroke, within 400 ms of camera motion, or within 1.5 s of a content change; a 15 s starvation guard overrides only the content window and never fires mid-stroke/pan.
- **Adaptive backpressure**: a save that took X ms doesn't run again for 4X (cap 10 s); camera-only saves cap at one per 20 s and reuse a cached body fragment (`encodeNotebookBody` / `assembleNotebookContent` split) so persisting a pan costs microseconds, not a full re-serialize.
- Version snapshots throttle independently (~one per 45 s of active writing, flushed on unmount) and fold into the same `save_file_raw` invoke via a header so the payload never crosses the bridge twice.
- Skipped ticks keep the dirty flag.

Settings sync derives appearance/theme/font from the active Hush style (`HUSH_TO_NOTEBOOK_THEME` maps ids; style colour overrides layer on in the `DrawingState.theme` getter). Grid pattern/spacing/opacity are per-notebook, overlaid on the global defaults at mount.

### File storage

The `content` field is a versioned JSON envelope (`notebook-content.ts`):

```jsonc
{
  "format": "hushnote", "version": 1,
  "shapes": [...], "layers": [...],      // layers ordered top-first
  "flowEdges": [...],                     // flowchart edges
  "bookmarks": [...],                     // optional camera bookmarks
  "camera": {...},                        // optional saved viewport
  "background": {...}                     // optional per-notebook bg settings
}
```

`decodeNotebookContent` also accepts the legacy bare `Shape[]` form; every optional field decodes as `undefined` and is skipped. Every save / load / sync / export path goes through this pair. The saved `camera` restores on main-canvas mount only — sync pulls (`reloadNotebookShapes`) and pane mounts deliberately ignore it so a remote device or a pane viewport can't yank the local one. The `.hushnote` zip (envelope + `images/`) is packed by `sync/notebook-sync.js` / Rust `hushnote.rs`.

### Shape types

All shapes extend `ShapeBase` `{ id, color, parentId?, groupId?, pocketed?, layerId? }`:

| Type | Notes |
|---|---|
| `TextShape` | Markdown-rendered text; auto-fit or manual width; background/border; wikilinks + citations + `YOUAREHERE` render via `markdown.ts` runs |
| `ImageShape` | base64 `dataUrl` (+ optional `dataUrlDark` for appearance-aware rasters — the image cache swaps `src` on appearance switches); non-destructive crop |
| `DragAreaShape` | Dashed container that parents shapes dropped inside; pinnable (screen-anchored via world-space camera compensation); Arrange-as-grid + swap/ripple reorder modes |
| `DrawShape` | Freehand stroke — points + brushId + size + mode; rendered by the engine |

Layers are notebook-level (every shape type, ordered top-first, hidden/locked per layer); legacy shapes fall back to the bottom layer. The pocket is a right-edge stash drawn at fixed screen positions, anchored against `pocketRightInset` (right-docked pane edge, else shelf edge).

### Flowchart

A portable layer (`flowchart.ts`) that knows nothing about Hush shape types — `DrawingState` configures it with `getBounds` / `isFlowable` callbacks (only `TextShape`s are flowable; `getBounds` is `unionGroupBounds` so arrows anchor to a whole group's edge, not one stray member). Connect by drag-onto (child), ⌘-drop (merge text into target), or from the inline editor (⌘→ child, ⌘↓ sibling; ⌘← parent, ⌘↑ MRU). Edges sharing a box side fan apart (`edgeOffsets`, scaled by `arrowWidth`); each edge carries a midpoint delete dot; drags pull transitive descendants; `tidy()` re-lays out a subtree. Edges serialize into the envelope; Desktops reuse the layer with authoring disabled and derived, locked edges (see `desktop/` + README-TECHNICAL).

### Selection toolbar actions

- **Colors menu**: text / background / border swatch rows (first two swatches are theme-tracking "auto" and "heading" sentinels) plus saved `{color, backgroundColor, fontSize}` style chips, stored app-wide in `AppSettings.notebookTextStyles`.
- **Rasterize / Recognize** (`selection-raster.ts`): both render the selection at 2× via `renderForExport` + `DrawingLayer.renderStrokesTo` (per-stroke render — a done-canvas blit would leak overlapping unselected strokes). Rasterize bakes to an ImageShape sized to the original bounds; theme-tracking selections bake **twice** (light + dark) into an appearance-aware image. Recognize routes strokes → ML Kit Digital Ink (iPad only, real point timings from engine delta #21, dynamic ObjC lookup so the binary builds without the pod) and images → Apple Vision (adaptive-scale raster, dark themes inverted); both land results as a TextShape below the source. Entry points live in `src/recognition/` so Docs can adopt them later.
- **Emoji stickers**: a text shape whose content is only emoji (grapheme-cluster test in `emoji-sticker.ts`) rasterizes to a 100 px ImageShape on commit.

### Touch / iPad

Pinch and two-finger pan are recognized on the canvas via `targetTouches` (not `touches` — a finger holding the Touch-mode ⌘ pill isn't a canvas touch). Zoom engages only past a 12 px spread dead-zone, rebaselining at engage so there's no jump — below it a two-finger gesture is pure pan (natural finger wobble otherwise produces per-frame micro-zooms that shimmer every stroke). In pen mode the same gestures arrive through the engine's recognizer instead (rAF-coalesced; delta #24). Optional canvas **rotation** rides the same gesture behind a per-notebook toggle: `Camera.rotation` applies between zoom and translation, all screen↔world math funnels through `screenToCanvas`/`canvasToScreen`, exports and gutter mode stay axis-aligned.

Copy/paste serializes the selection (+ contained flow edges) as a `steiner-clipboard` JSON envelope (interchangeable with the Steiner project), stashed on `window.__hushNotebookClipboard` as a fallback when the OS clipboard write is rejected; paste mints fresh ids and remaps parent/group/edge references.

### Zotero on the canvas

Insert Reference routes by context (`resolveInsertContext`): an active text-shape edit gets the citation through `TextEditor.insertAtSelection()` — the modal must call `suspendCommitOnBlur()` first, because its focus steal would otherwise commit and unmount the shape being cited into (the same handshake the citation popup uses); a bare canvas gets a fresh TextShape (`currentNotebookFileId` outranks the hidden CodeMirror view in the resolver — inserts once silently landed in the hidden doc). PDF page snapshots embed directly as ImageShapes (the bytes ride the envelope; they deliberately don't populate the global Images folder).

## Development rules

Same as the main codebase (700-line cap, no frameworks), plus:

- **Pure rendering** — `renderer*.ts` must not access global state or the DOM.
- **Mutations through `DrawingState`** — never from UI or input handlers directly.
- **Shape immutability** (above) is load-bearing.

### Adding a new shape type

1. Interface in `types.ts` (extend `ShapeBase`, add to the `Shape` union)
2. Bounds in `utils.ts::getShapeBounds()`; hit test in `hitTestShape()`
3. Draw function in `renderer.ts`
4. Creation logic in `state.ts`; resize in `state-helpers.ts::applyResize()` if applicable

### Adding a new tool

1. `Tool` union in `types.ts`
2. Pointer handling in `DrawingState.handlePointerDown/Move/Up`
3. Button in `ui/toolbar.ts` (`TOOLS` array); cursor in `notes-canvas.ts`'s `cursorMap`
4. Shortcut field in `AppSettings` (Rust) + `shortcutCategories` (settings-tabs-shortcuts.js)

Drawing sub-tools (brush/erase/slice/lasso) go through the engine instead — see README-DRAWING.md.

### Adding a canvas theme

Add to `THEMES` in `themes.ts` and map it in `HUSH_TO_NOTEBOOK_THEME` (`notebook-bridge.js`).
