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
  selection-region.ts     Region → selection hit test shared by marquee + lasso
  splits.ts               Split geometry (pure): units, side assignment, image cuts
  state-splits.ts         Split / Grab state machine — pointer routing + operations
  renderer-splits.ts      Split lines, grab band, place bar, hover action cluster
  image-budget.ts         Viewport-scoped image-cache policy for image-heavy notebooks
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
                          text editor, brainstorm input, bookmarks, status bar, icons, h(),
                          grab-popup (the grab's two-stage control bar),
                          proof-thumbnails (proofread page rail)
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
  "splits": [...],                        // optional split lines
  "proof": {...},                         // optional proofread metadata
  "camera": {...},                        // optional saved viewport
  "background": {...}                     // optional per-notebook bg settings
}
```

`splits` and `proof` ride the **body** half of the encode split (with
shapes / layers / edges / bookmarks), not the camera tail: both are
content, so a camera-only save reuses the cached fragment for them too.

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

Every shape also carries an optional `createdAt` stamp, written by each creator (including the sync shim's engine strokes and the clipboard's paste remap). Only collapsing a split reads it; a missing stamp counts as older than every split, so nothing predating the feature can be swept away.

### Splits and Grabs

A **split** is a cut across the entire canvas: two parallel lines, each carrying the content on its own side. Splits are *not* shapes — no bounds, no layer, never selected — so they live in a notebook-level `DrawingState.splits` list beside `bookmarks`, and skip the whole `Shape` union surface (bounds, hit tests, resize, clipboard, region select).

`Split.a` / `.b` are world positions on the cross axis (y for a horizontal split, x for a vertical one), equal at creation. The classification is by **unit centre**, which makes near / far a partition:

| region | meaning |
|---|---|
| `coord < a` | near side — moves with the `a` line |
| `coord > b` | far side — moves with the `b` line |
| `a ≤ coord ≤ b` | inside the split — material written into the gap, carried by neither |

Because a line only ever moves with its own side, that stays true across any number of drags — and **nesting falls straight out of it**: `translateSplits` moves other splits' lines on the same test their side's shapes got, so a split cut inside another is carried by the outer line, while one sitting in the outer gap correctly stays put. Cross-orientation splits are never moved (a vertical line already spans the full height).

Two rules govern what a cut does to content, both in `splits.ts`:

1. **Only standalone images are divided.** `buildUnits` resolves the outermost grouping — union-find over `groupId` *and* `parentId`, because the two interleave (grouped strokes inside a drag box move as one thing and neither relation alone says so) — and a unit lands whole on one side. A unit that is a single ungrouped, unparented image is cut instead, into two shapes sharing the same `dataUrl` with complementary `crop` windows (the existing non-destructive crop, no re-encode), so the cut is invisible until the sides separate. The near piece keeps the original id, so anything referencing the image (a proofread page entry, a cache slot) still resolves.
2. **Layer *locks* are ignored; hidden layers are skipped.** A lock stops the pointer picking a shape up, but a split is a cut across the document — and the headline case, a PDF proof whose pages are locked precisely so they can't be nudged, is exactly where the locked material must move.

A hovered line offers three actions. **Delete** drops the lines and leaves every piece exactly where it is. **Collapse** is the inverse of making the split: it discards material written inside the gap (units whose members are *all* newer than the split — anything older is carried across instead), draws the two edges back together, and then runs `mergeImagesAt`, which re-fuses image halves that have come back into contact. A pair only merges when it could actually have come from one image — same bytes, same extent across the cut, contiguous and complementary crop windows — so a split can be cut and collapsed any number of times without accumulating shape records, and two genuinely different images that happen to abut are never welded together. **Grab** is the third.

Chrome follows the same principle. A split at rest is a boundary the document now has, not an operation in progress, so its lines drop to a faint tint of the theme foreground and the gap loses its wash; orange, the gap tint, and a padded slab behind the specific line under the hand all appear only while that split is being hovered or dragged. The slab is what separates "a cut is about to be made here" from "this edge is what you are dragging", and the canvas cursor switches to `grab` / `grabbing` over a line from any tool that can move it.

A **grab** is a split with a lift in the middle, and reuses the same machinery: Apply is a cut at each band edge, a lift of the units centred inside, and a close (`translateShapes` + `translateSplits` on the far side by `-height`). It is a two-stage flow with a live buffer between the stages, which drives two design choices:

- The control bar is **DOM** (`ui/grab-popup.ts`), not canvas chrome — the place stage asks the user to pan and zoom to find a landing spot, and chrome that scrolled away with the content would be useless.
- The session **rides the undo checkpoint** (`NotebookCheckpoint.grab`, alongside `splits`). The checkpoint recorded at Apply carries `stage: "place"`, so ⌘Z after placing lands back in the place stage instead of unwinding the whole grab. Cancel is separate: the session holds a pre-Apply `restore` snapshot so it can back out in one step from either stage.

Pointer routing lives in `state-splits.ts` and is called from `DrawingState.handlePointer*`, deliberately **below** the pan branches — space-to-pan, middle-drag, wheel zoom and two-finger gestures all have to keep working mid-gesture, which is how the user navigates a long proof while a grab waits to land. Touch adds one more guard: mouse and pen cut / place on pointer-**down** ("click and it happens"), but a finger's first contact is also the first contact of a two-finger pan, so touch defers the action to pointer-up behind a slop check (`splitTapPending`) and `cancelActiveInteraction` abandons it. A touch tap on a split line that never travels reveals the hover action cluster — the same tap-to-reveal the flowchart edge badges use, and the only way a touch device reaches a hover affordance.

`renderer-splits.ts` paints everything in **screen space after the camera transform is restored**, projecting each line's endpoints through `canvasToScreen` (so canvas rotation still works) rather than stroking in world units — a split line is conceptually infinite, and dash lengths, line weights and the 26 px action buttons all have to stay constant at 25 % zoom. Coincident lines are pushed apart to a fixed 10 screen px so both stay grabbable; `drawnLinePositions` is shared with the hit test so what you click is what you see.

The grab band is the exception, and deliberately so: it *selects content*, so its thickness is world-space (it always was) and its chrome — edge stroke weight and grip radius — scales with zoom too, clamped so it neither vanishes at 0.25 nor swamps the selection at 1. A fixed-pixel border on a world-space band reads as an overlay pinned to the screen rather than a region of the document.

### Proofread PDF

`pdf/pdf-proofread.js` bakes the open PDF into a `<name>-Proof` notebook: one `ImageShape` per page in a single column with a 50 px gutter, on a locked "Pages" layer with a "Notes" layer above it, plus a `proof` envelope entry holding per-page thumbnails. The result is an ordinary `.hushnote` — nothing downstream knows it came from a PDF.

Baking rather than rendering live is forced by the feature: a proof has to survive the source PDF moving, and splits mean the canvas must be able to draw "the bottom two-thirds of page 4, shifted 200 px down", which no live renderer can express. That puts the page bytes in the envelope, and two costs follow:

- **Envelope size** — pages are capped at 1400 raster px and encoded as JPEG (not WebP: `toDataURL("image/webp")` silently yields PNG on WebKit). The save gate's quiet-moment + backpressure rules cover the rest.
- **Decoded bitmaps** — fifty full-size pages decode to hundreds of MB, past what iPadOS gives a WKWebView. `image-budget.ts` keeps only images within ~1.5 screens of the viewport decoded once a notebook passes 12 image shapes, evicting the rest (the `dataUrl` never leaves the shape, so scrolling back re-decodes). It recomputes on shapes-array identity — a split drag moves pages without changing their count — and on half-a-screen of camera travel. The page rail therefore gets its **own** small rasters baked at import time; a rail of fifty full-page `<img>`s would reintroduce exactly the problem the budget removes.

The rail (`ui/proof-thumbnails.ts`) is a **live minimap of the page layer**, not a list of the pages the PDF had: split a page and it shows two pieces with the gap between them, drag the split open and the gap grows to scale (capped, so one big drag can't push the running order off the bottom). Only the page layer is drawn — ink and text are annotations on the document, not the document, and at rail scale they'd be smudges over the thing you're reading. For the same reason the shelf goes the other way and filters the page layer *out*: one locked, unactionable "Page 7" row per page (several, after a few splits) buries the notes the panel exists for.

Pieces are painted **without decoding a page**. Each is an `<img>` of its source page's small thumbnail raster, blown up to what the whole page would measure at rail scale and clipped by an `overflow: hidden` wrapper to the piece's `crop` window — sound because a cut is a crop of the same bytes, so the same fractions index into the thumbnail exactly as they index into the full raster. `ImageShape.proofPageIndex` ties a piece back to its page and rides every cut for free (a cut spreads the original shape); proofs baked before that field existed fall back to `ProofPage.shapeId`.

Two update clocks, kept apart: *structure* (which pieces exist) changes only when a cut is made or content is grabbed, *geometry* (where they are) changes on every frame of a split drag. Rebuilding a hundred elements per drag frame would make the rail the slowest thing on screen, so a rebuild only follows a structure change and the geometry pass is skipped outright mid-drag — the user is watching the canvas, and release re-syncs.

The rail offsets from `state.rightInset` — the live canvas-right-edge → shelf-left-edge distance the canvas controller already re-measures per frame through the shelf's width transition — so it sits flush inboard of the shelf's grip when closed and is pushed left, not buried, when the shelf opens. Its left edge is a drag handle (60–300 px, persisted app-wide as `notebookProofRailWidth`); because the rail is right-anchored, dragging left makes it wider, so the resize delta is inverted.

### Flowchart

A portable layer (`flowchart.ts`) that knows nothing about Hush shape types — `DrawingState` configures it with `getBounds` / `isFlowable` callbacks (only `TextShape`s are flowable; `getBounds` is `unionGroupBounds` so arrows anchor to a whole group's edge, not one stray member). Connect by drag-onto (child), ⌘-drop (merge text into target), or from the inline editor (⌘→ child, ⌘↓ sibling; ⌘← parent, ⌘↑ MRU). Edges sharing a box side fan apart (`edgeOffsets`, scaled by `arrowWidth`); each edge carries a midpoint delete dot; drags pull transitive descendants; `tidy()` re-lays out a subtree. Edges serialize into the envelope; Desktops reuse the layer with authoring disabled and derived, locked edges (see `desktop/` + README-TECHNICAL).

### Dragging a selection

Both drag pipelines — Hush's (`handlePointerMove`) and the engine's
(`applyMovePreview`) — leave stroke geometry alone while the gesture
runs and bake the total offset once on release; see README-DRAWING.md.
Hush's also caches every non-moving shape's bounds for the flowchart
drop-target probe, which otherwise re-measured every point (and
re-ran text metrics) in the notebook on every frame of every drag.

### Selection (one hit test, three gestures)

Every "sweep an area to select" gesture funnels through
`selection-region.ts#collectShapesInPolygon`, which takes a **world-space
polygon** and returns Hush shape ids:

| Gesture | Where the polygon comes from |
|---|---|
| Select-tool marquee | `state.selectionBox`, as a 4-point rect |
| Pen-mode freehand lasso | engine SVG path (hold-to-lasso, or the Lasso sub-tool) |
| Pen-mode finger marquee | engine SVG rect — one finger dragging while a brush / eraser is active (iPad) |

Once something *is* selected, the finger stops sweeping and starts
moving — in every tool, not just pen mode. A touch-drag that would have
started a region carries the whole selection instead, and a tap clears
it; pinning a fingertip on a small bbox is the hard part, so the grab
is anywhere the sweep would have been. Under the Select tool a drag
that lands *on* a shape still grabs that shape (direct manipulation
wins where there's something under the finger). Mouse and pen keep
sweeping from empty canvas, so desktop is unchanged.

Hit rules: a `DrawShape` is caught when any of its points is inside the
polygon **or** any of its segments crosses one (a sparsely sampled
straight line swept across the middle still counts); every other type is
caught when its bounds intersect the polygon, which for an axis-aligned
rect reduces to plain bounds overlap. Groups promote whole, hidden
layers and pocketed shapes are skipped, and a degenerate region (a tap)
selects nothing — pen mode reads that as a dismissal.

Before this, the marquee lived in `DrawingState` and hit-tested bounding
boxes while the lasso lived in the stroke engine and could only ever see
strokes: two mechanisms, two answers. The engine now hands its polygon
up (deltas #32/#33) instead of resolving it, and the selection bridge
pushes the stroke subset back down for the bbox — see README-DRAWING.md.

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
4. Shortcut field in `AppSettings` (Rust) + `state-defaults.js` + `shortcutCategories`
   (settings-tabs-shortcuts.js) + the `shortcuts` object the bridge passes at mount.
   All four: a field missing from the Rust struct resets every launch.
5. Icon in `ui/icons.ts` — check the name isn't already taken. `PATHS` is a plain
   object literal, so a duplicate key silently loses to the later entry.

Drawing sub-tools (brush/erase/slice/lasso) go through the engine instead — see README-DRAWING.md.

### Adding a canvas theme

Add to `THEMES` in `themes.ts` and map it in `HUSH_TO_NOTEBOOK_THEME` (`notebook-bridge.js`).
