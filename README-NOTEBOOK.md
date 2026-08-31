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
  canvas-paste.ts         Copy/paste onto the canvas — the paste event and the ⌘V clipboard read
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
                          proof-thumbnails + proof-rail-ink (proofread page rail),
                          proof-scrollwheel (iPad-only virtual scroll wheel)
  drawing/                Drawing layer + stroke engine — see README-DRAWING.md
  pencil-bridge.js        iOS: pencil-only inking + Apple Pencil double-tap listener
```

The notebook mounts into the same `#app` DOM as the editor (visibility swapped via the `.notebook-mode` class) — no separate window or webview.

### State, rendering, notifications

`DrawingState` extends `EventTarget`; all mutations go through its methods or `notify(key)`. Notifications batch via `queueMicrotask` into a single `"change"` event carrying `{ keys }`.

The wheel **scrolls**, on both axes; ⌘ (or a trackpad pinch, which WebKit reports as a ctrl-wheel) **zooms**; **shift** pins the pan to the axis the user is already travelling on and holds it there until shift comes back up. That axis comes from the last *un-modified* scroll (`_lastScrollAxis`), never from the live deltas: every platform remaps a shift-held scroll from `deltaY` into `deltaX` — iPadOS does it for trackpad swipes too — so reading the deltas makes shift *switch* axes instead of pinning them, and a vertical swipe starts running sideways the moment the modifier goes down. Whichever component carries the magnitude is then fed to the locked axis, which makes the remap transparent. Deltas apply 1:1 like a doc scroller, with `deltaMode` line / page units converted so a notched wheel moves a sane amount. A horizontal-dominant scroll still bubbles when the canvas is `paneHosted` — a stack column or a pane has a host scroller that owns it — but the main canvas keeps it and pans, and shift is exempt from the bubble for the same remap reason. Gutter mode is unchanged: it redirects the wheel into the host doc's scroller and has no zoom to offer.

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

**The canvas host carries the app's UI font, not the style's.** Everything `NotesCanvas` builds in DOM is chrome — toolbars, the shelf, colour menus, popups — and plenty of it asks for `font-family: inherit`, which was picking up the writing face the active style sets on the page; a colour menu rendered in EB Garamond. The constructor pins `--ui-font-family` on the container instead. Canvas *content* is unaffected either way (painted through an explicit `ctx.font`), and the inline text editor sets its own face.

Layers are notebook-level (every shape type, ordered top-first, hidden/locked per layer); legacy shapes fall back to the bottom layer. The pocket is a right-edge stash drawn at fixed screen positions, anchored against `pocketRightInset` (right-docked pane edge, else shelf edge).

**Hidden and locked layers are both inert to the pointer.** `_inertLayerIds()` (hidden ∪ locked) is the set every pick path filters against — `findShapeAtPoint` under the Select and Text tools, the resize-handle hit test, double-click, `selectShapesInRegion` (which covers the marquee, the pen-mode finger sweep, and the lasso alike, since all three funnel through it), the whole flowchart drag/drop surface (see below), and `startEditingExistingText`, which returns false rather than opening an editor on inert text so the one route that doesn't hit-test — the flowchart's keyboard navigation — is covered too. The engine already applied the same rule to its own stroke selection via `isSelectable`; before this the Hush side applied it to *hidden* only, so a locked layer rendered normally and still picked up — which made the lock on a proof's page layer decorative. `_hiddenLayerIds()` survives for the one caller that means "not rendered" rather than "not touchable": splits, which have to cut the locked pages (see below).

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

**Text on a proof starts as a correction mark.** `TextShape` carries optional `fontFamily` / `bold` overrides of the canvas-wide text style — absent on every shape of an ordinary notebook, meaning "follow the canvas". A proofread notebook sets `newTextStyleOverride` when it mounts (`applyProofTextDefaults`, called wherever `proof` is assigned so a pane swapping content can't keep the previous file's defaults), and every *new* text shape spreads `newTextStyle()` in: red, bold, Courier. Per shape rather than per canvas, so notes written before keep their face and the user can still change any of it. Everything that measures or paints text takes the shape's face when it has one — `getShapeBounds`, `autoFitWidth`, `drawTextShape`, the rail's ink preview, and the inline editor's textarea — because a Courier note wrapped against Inter's metrics misses its own glyphs by a word.

`pdf/pdf-proofread.js` bakes a PDF into a `<name>-Proof` notebook. `pdf-proofread-modal.js` runs first and asks which pages (print-dialog notation — `1-3, 5-8`; empty means all), which is also the only confirmation step: the honest answer to "this will be enormous" is usually "then just do chapter three". A partial proof is named for its slice (`Paper-Proof 1-3`), and `ImageShape.proofPageIndex` indexes into `proof.pages`, **not** the source PDF's page numbers. The build itself is: one `ImageShape` per page in a single column with a 50 px gutter, on a locked "Pages" layer with a "Notes" layer above it, plus a `proof` envelope entry holding per-page thumbnails and a per-notebook `background: { pattern: "blank" }` (a dot grid showing through the gaps between pages reads as noise on paper). The result is an ordinary `.hushnote` — nothing downstream knows it came from a PDF.

**Zotero marks are baked into the page rasters** by `pdf/pdf-annot-raster.js` (shared with the shelf-cover baker, which had the only copy of this painting code). They have to be, because Zotero annotations are not in the PDF: they are child items of the attachment, cached locally, and the viewer paints them as a DOM overlay over each rendered page. pdfjs therefore hands back a clean page, and a proof built from it silently dropped every highlight and ink stroke the user had made while reading — the marks were visible in the viewer right up until the moment they mattered. Geometry goes through `viewport.convertToViewportPoint` (crop-box origins and `/Rotate`), highlights composite with `multiply` to match the overlay's `mix-blend-mode`, and the paint lands before the thumbnail is taken so the rail shows them too. Annotations embedded in the PDF file itself need nothing: pdfjs's default `annotationMode: ENABLE` already renders those. The lookup is cache-first but accepts Zotero credentials, since the file-tree row menu can proof a PDF that has never been opened in the viewer and so has never warmed the cache.

Pages are placed at **twice** their PDF point size (`PAGE_WORLD_SCALE`). At 1× a page would be "100 % = actual size", which sounds right and reads too small — the notebook camera clamps zoom at 1, so there is no way to magnify it afterwards.

`PAGE_WORLD_SCALE` and `MAX_PAGE_RASTER_WIDTH` together decide how sharp a page looks, and they pull against file size: a US-Letter page is 2800 raster px over 1224 world px, ~2.3 device px per world px, which is crisp at zoom 1 on a Retina display with a little headroom. Raising the raster is expensive — bytes grow with its square, and the base64 rides inside JSON that is re-serialised on content saves — so `PAGE_QUALITY` is the knob to reach for first when pages look soft. Past the display's pixel density, JPEG fidelity buys more visible sharpness per byte than resolution does.

Baking rather than rendering live is forced by the feature: a proof has to survive the source PDF moving, and splits mean the canvas must be able to draw "the bottom two-thirds of page 4, shifted 200 px down", which no live renderer can express. That puts the page bytes in the envelope, and two costs follow:

- **Envelope size** — pages are capped at `MAX_PAGE_RASTER_WIDTH` (2800 px on the long edge) and encoded as JPEG (not WebP: `toDataURL("image/webp")` silently yields PNG on WebKit). The save gate's quiet-moment + backpressure rules cover the rest.
- **Decoded bitmaps** — fifty full-size pages decode to hundreds of MB, past what iPadOS gives a WKWebView. `image-budget.ts` keeps only images within ~1.5 screens of the viewport decoded once a notebook passes 12 image shapes, evicting the rest (the `dataUrl` never leaves the shape, so scrolling back re-decodes). It recomputes on shapes-array identity — a split drag moves pages without changing their count — and on half-a-screen of camera travel, measured in **world** px: `camera.x/y` is a screen-space offset that pivot zoom scales along with everything else, so twenty pages down a proof a 2 % pinch step moved it by more than a screen and a fast pinch recomputed (and evicted, and re-decoded) on all sixty frames. Zoom itself is gated on a ratio, not on inequality, for the same reason. The page rail therefore gets its **own** small rasters baked at import time; a rail of fifty full-page `<img>`s would reintroduce exactly the problem the budget removes.

  Four things bound the working set beyond the margin. **A canvas with no box keeps nothing**: "screens" means nothing to a canvas measuring 0×0, and reading that case as "keep everything" was backwards, because the canvases that measure zero are the ones detached from the document — showing the user nothing while holding every page decoded. **The ceiling is in megapixels, because the memory is** (`MAX_DECODED_MEGAPIXELS`, ~160 MB at 4 bytes a pixel): a page raster is 2800 × ~3600, so **40 MB decoded**, where a pasted screenshot is a fiftieth of that, and a cap counting *images* cannot tell them apart — "sixteen images" reads as modest and licenses two thirds of a gigabyte. Zooming out is the one gesture that grows the viewport, so it walks the keep set straight up to whatever the cap allows; that is why a fast zoom-out was the last thing still killing the content process after the working set was otherwise bounded. **Nothing new decodes mid-zoom**: a sweep passes through a dozen viewports nobody looks at, and decoding for each spends the whole budget several times over before any of it can be freed, so while the zoom is moving the set is what's on screen and the read-ahead refills 180 ms after it settles. And **the ceiling is shared** — each canvas over the threshold takes a share (floored, so a proof in a stack of three still decodes the page you're reading), because two columns of the same proof are two full sets of bitmaps.

  Candidates are *ranked* rather than the visible rect being exempt — on screen first, nearest to the middle of it, then the read-ahead band — and admitted while the budget lasts, with the nearest one always admitted whatever it costs so a canvas can never paint nothing. Exempting everything visible sounds kinder and isn't: pages pulled apart by splits can put fifteen of them on screen at zoom 0.25, which is six hundred megabytes. Evicting also **releases the bitmap on the spot** (`releaseImage` points the element at a 1×1 GIF, the same trick `pdf-proofread.js` uses on its page canvases): dropping the last reference leaves the pixels there until WebKit next collects, which during a fast gesture is far too late — the whole point of the eviction is to make room for what is decoding this frame. Costs are *measured* off each element as it loads and remembered across evictions, since costing a page as a guess while it is out and as its real size while it is in makes the budget oscillate around its own boundary.

The rail (`ui/proof-thumbnails.ts`) is a **live minimap of the page layer**, not a list of the pages the PDF had: split a page and it shows two pieces with the gap between them, drag the split open and the gap grows to scale (capped, so one big drag can't push the running order off the bottom). Only the page layer is drawn — ink and text are annotations on the document, not the document, and at rail scale they'd be smudges over the thing you're reading. For the same reason the shelf goes the other way and filters the page layer *out*: one locked, unactionable "Page 7" row per page (several, after a few splits) buries the notes the panel exists for.

Pieces are painted **without decoding a page**. Each is an `<img>` of its source page's small thumbnail raster, blown up to what the whole page would measure at rail scale and clipped by an `overflow: hidden` wrapper to the piece's `crop` window — sound because a cut is a crop of the same bytes, so the same fractions index into the thumbnail exactly as they index into the full raster. `ImageShape.proofPageIndex` ties a piece back to its page and rides every cut for free (a cut spreads the original shape); proofs baked before that field existed fall back to `ProofPage.shapeId`.

Annotations are drawn on top by `proof-rail-ink.ts` — strokes as polylines, prose as one bar per **wrapped** line, headings as real (scaled) text, drag boxes as outlines, pasted images as blocks. Text runs through the same `parseText` + measurer the renderer uses, because counting newlines undercounts badly (a paragraph wrapping to six visual lines is one newline) and a minimap whose blocks are the wrong height is a minimap you can't trust. Headings get glyphs rather than a stripe because they are the landmarks a reader scans a minimap *for*; body text stays striped, since real glyphs at this scale are mush and would cost a `fillText` per line for nothing. A heading floors at 5 px and is drawn through `fillText`'s `maxWidth`, which condenses rather than overflows — so the floor buys legibility as the rail widens without ever letting a heading escape its own block. Deliberately a *sketch*, not a flatten: rasterising the real canvas at rail scale would force every page image to decode, which is exactly what the image budget exists to prevent, and it would do it on every change. Sketching reads shapes already in memory and costs a few hundred `lineTo`s, so it can run on a 180 ms trailing debounce that skips entirely while a stroke, drag or split gesture is in flight. Strokes subsample to 160 points — past that the rail has no pixels to show the difference.

The projection is piecewise: each piece is its own linear segment and the clamped gaps compress (or stretch) whatever world space falls between them. `railToWorld` inverts it, which is what lets a click anywhere on the rail — including in a gap — resolve to a real world point, and the camera then *glides* there (280 ms ease-out) rather than cutting. A jump-cut across a fifty-page document costs the reader their place; the travel is what tells them how far they went.

The glide moves the camera **vertically only**. The rail maps the document, which runs down the page; where the reader has scrolled sideways to — a margin they're annotating, a page pulled out by a vertical split — is their working position, and resetting it on every navigation would undo it.

Piece *sizes* are to scale against each other, and so is the space between them — but **clamped at both ends** (4–40 px). Neither extreme survives contact: fully to scale, one split dragged wide open dominates the rail and pushes its neighbours out of view; fully fixed, opening a split changes nothing in the rail at all, which is exactly backwards, because making room and then writing into it is the whole proofreading gesture. Its foot also stops 62 px short so the fixed rotation / background buttons in the bottom-right corner stay reachable underneath it — where the rail's own show / hide toggle lives, between the rotate and background buttons. That toggle is a *reading* preference, not something a proof carries, so it rides `notebookProofRailVisible` in settings beside the rail's width rather than the notebook's envelope. The button's click pulses the canvas with `notify("interaction")` — a repaint-only key, so toggling the rail can't mark the notebook dirty and trigger a multi-MB autosave.

Two update clocks, kept apart: *structure* (which pieces exist) changes only when a cut is made or content is grabbed, *geometry* (where they are) changes on every frame of a split drag. Rebuilding a hundred elements per drag frame would make the rail the slowest thing on screen, so a rebuild only follows a structure change and the geometry pass is skipped outright mid-drag — the user is watching the canvas, and release re-syncs.

The rail sits **below floating panes** (z 89, under `--z-pane: 90`). It is canvas chrome and a pane is the thing the user just pulled to the front, so a rail painted over one reads as the pane having gone missing. The trade is the notebook toolbar (z 100), which now stacks over the rail where a centred bar reaches it — the bar is draggable and the rail's foot already stops short of the corner buttons. The shelf (150) keeps its own place above both.

The rail offsets from `state.rightInset` — the live canvas-right-edge → shelf-left-edge distance the canvas controller already re-measures per frame through the shelf's width transition — so it sits flush inboard of the shelf's grip when closed and is pushed left, not buried, when the shelf opens. Its left edge is a drag handle (60–300 px, persisted app-wide as `notebookProofRailWidth`); because the rail is right-anchored, dragging left makes it wider, so the resize delta is inverted. The handle **shows itself** — a tall outlined pill straddling the edge, filled with the rail's own background so it reads as part of the panel rather than a mark on the canvas, its border brightening on hover and held bright through the drag. It carries no `opacity` (that would make the fill translucent and let the canvas read through it); the resting state is the border colour. Straddling means half of it hangs outboard, which is why the rail's rounded-corner clip sits on the *scroller* rather than the root — a clip up there would shave that half off — and why the hit strip reaches a few px past the edge, since a handle you can see and can't grab is worse than no handle. An `ew-resize` cursor alone can't advertise a gesture: it only appears once the pointer is already on an 8 px strip nobody had a reason to try, so the rail's most useful move — widen it until the pages are legible — went unfound. The strip is exactly `RAIL_PAD` wide so it stays inside the scroller's padding and never eats a click meant for a page piece, and the drag puts `ew-resize` on `<body>` for its duration, since the pointer spends the gesture out over the canvas.

#### The virtual scroll wheel (`ui/proof-scrollwheel.ts`)

A 50 px-wide weighted wheel parked in the top-left corner: a 250 px ridged drum between two 36 px plinths, driving `camera.y` — or, in zoom mode, `camera.zoom`. It offsets past `--sidebar-grip-width` so the closed file sidebar's grip strip doesn't clip it, and sits at z-index 95 — *below* the sidebar (100) on purpose, so opening the file tree buries the wheel rather than leaving it floating over the rows. That comparison works because `#notebook-container` deliberately creates no stacking context. It exists because a proof is a long document read top to bottom and iPad has no hardware for that job: the trackpad's two-finger swipe doesn't behave like a Mac's, and two fingers on the canvas are already spoken for by pan and pinch. Gated on `isIOS()` **and** `state.proof`, and off for pane-hosted and gutter canvases (their host owns the scroll) — everywhere else the platform already has an answer and the corner is better left empty.

Modelled on the physical object rather than on a scrollbar: releasing a flick leaves the flywheel coasting under friction (0.94 per 60 Hz frame, from the tail ~90 ms of the drag, capped so a fling on a high-rate display can't teleport the camera), and a press on a spinning wheel stops it *and* becomes the next drag, so catching a runaway and re-aiming it is one gesture. Direction is the one place the model is deliberately broken (`DIRECTION = -1`): it follows the platform's "natural" scrolling, content tracking the finger, rather than a notched wheel's opposite convention — the hand already knows the platform's direction, and the wheel is used alongside trackpad scrolling that obeys it. `GAIN` (2.4 document px per px of face travel) is the feel knob — below ~2 it reads as a stiff scrollbar, much above 3 and a flick throws several pages. The ridges are a repeating gradient whose `background-position-y` tracks accumulated face travel, so the drum turns with the throw.

The two plinths are the parts you press rather than turn, and both `stopPropagation` their `pointerdown` so a press on either can't also grab the drum. The **foot** repositions the control: a plain drag, saved to `notebookProofWheelX/Y` on release and clamped back inside the host box on every placement (the same saved offset is shared by the full-window canvas and by a pane, which are different sizes). It used to demand a four-second hold to arm — an outline, a border stepping through four shades, a blink — because the drum and the foot were one surface and any shorter hold would have armed itself during ordinary scrolling; giving the foot its own plinth is what made the timer unnecessary. The **cap** switches what the drum drives, and the whole control takes a red outline (an `outline`, not a border: the border is the theme's, and repainting it would read as a skin bug on a proof's white pages) for as long as it does. Zoom is exponential in face travel — a fixed ratio per px, so the wheel feels the same at 25 % as at 100 % — pivoted on the middle of the canvas, since the finger is over on the wheel and there is no pointer position to anchor to. It clamps to the same [0.25, 1] envelope as the canvas's own wheel and pinch handlers. A mode flip stops any coast in flight: a flick meant to travel the document would otherwise land as a zoom.

Everything upstream of `turn()` — drag deltas, coast velocity, the release samples — is in *face* px, so `GAIN`, `DIRECTION` and the zoom conversion are applied in exactly one place. The drum turns in both modes even when the camera can't move: what the wheel is doing is a separate question from what the document is doing, and a face that stops at the end of the zoom range (or the end of the document) reads as a jam. The release throw differences two samples of the running `facePos` total, which means the press must seed the sample buffer with the current `facePos` and not with zero: seeding zero made a short flick read as "the wheel travelled its whole lifetime's distance just now", signed by wherever in the document the reader happened to be, so catching a coast and nudging it could fling it off the other way.

#### Exporting a proof

Notebook export re-renders **every** stroke through `DrawingLayer.renderAllStrokesTo` rather than blitting the engine's done canvas. The done canvas only backs the world rect `[origin, origin + worldSize]` (~2048 px square, re-anchored to follow the camera), so an all-content export of anything taller than a screen came out carrying the ink from wherever the camera happened to be and nothing else — on a proof, which is tens of thousands of world px tall, that reads as "the PDF has no annotations at all". Per-stroke rendering costs O(all ink) instead of one `drawImage`, which is the right trade once per export.

The raster is also clamped to what a browser canvas can actually paint (`fitRasterScale`: 8192 px per side, ~16 M px of area — WebKit on iPad allocates past those and then never paints, so the failure mode was a blank file rather than an error). A tall proof therefore exports at reduced resolution rather than not at all. Note the remaining limitation: notebook PDF export emits **one** page sized to the content bounds, so a fifty-page proof becomes a single enormous PDF page that the clamp renders softly. Paginating a proof export along its page layer is the real fix and isn't built.

### Flowchart

A portable layer (`flowchart.ts`) that knows nothing about Hush shape types — `DrawingState` configures it with `getBounds` / `isFlowable` callbacks (only `TextShape`s are flowable; `getBounds` is `unionGroupBounds` so arrows anchor to a whole group's edge, not one stray member). Connect by drag-onto (child), ⌘-drop (merge text into target), or from the inline editor (⌘→ child, ⌘↓ sibling; ⌘← parent, ⌘↑ MRU). Edges sharing a box side fan apart (`edgeOffsets`, scaled by `arrowWidth`); each edge carries a midpoint delete dot; drags pull transitive descendants; `tidy()` re-lays out a subtree. Edges serialize into the envelope; Desktops reuse the layer with authoring disabled and derived, locked edges (see `desktop/` + README-TECHNICAL).

**A locked or hidden layer is out of the chart's reach.** `isFlowable` folds in `_isLayerInert`, which takes inert shapes out of `findDropTarget` and `tryConnect` at the source — the drop handler's own target scan and the hover probe that outlines a prospective parent filter the same way, so no drop lands an arrow on locked material and nothing is outlined that the release would refuse. The three paths that *move* a node's descendants — the live drag, the snap replay after a connect, and `tidy()` — drop inert shapes from the set they translate: an edge can predate the lock, and the lock means the shape doesn't move, whether it's pushed directly or pulled through the chart. Its own descendants still follow, since the lock is on the shape rather than on the subtree under it. Authoring in the other direction is closed too: ⌘↓ resolves a sibling's parent from the edge list, so `startEditingFlowchartChild` refuses a locked parent rather than minting an edge onto it.

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
- **Rasterize / Recognize** (`selection-raster.ts`): both render the selection at 2× via `renderForExport` + `DrawingLayer.renderStrokesTo` (per-stroke render, from `drawing/stroke-paint.ts` — a done-canvas blit would leak overlapping unselected strokes). Rasterize bakes to an ImageShape sized to the original bounds; theme-tracking selections bake **twice** (light + dark) into an appearance-aware image. Recognize routes strokes → ML Kit Digital Ink (iPad only, real point timings from engine delta #21, dynamic ObjC lookup so the binary builds without the pod) and images → Apple Vision (adaptive-scale raster, dark themes inverted); both land results as a TextShape below the source. Entry points live in `src/recognition/` so Docs can adopt them later.
- **Emoji stickers**: a text shape whose content is only emoji (grapheme-cluster test in `emoji-sticker.ts`) rasterizes to a 100 px ImageShape on commit.

### Toolbar satellites

The bottom toolbar's flyout group — the brush flyout, the lasso flyout and the mini-palette strip — is appended to the **canvas container**, not to the bar, so it can escape the pill's `overflow`. That means the `notebook-toolbar-minimized` class, which hides every child of the bar, never reaches any of them: each has to read `state.drawingToolbarMinimized` itself. The drag tab's own toggle therefore fires `notify("drawingToolbarMinimized")` (a repaint-only key — it must not mark the notebook content-dirty) while still bypassing `setDrawingToolbarMinimized`'s tool side-effects, which would flip the user out of the pen. Without the notify the mini-palette was left floating over the canvas, attached to a brush row that was no longer there.

### Touch / iPad

Pinch and two-finger pan are recognized on the canvas via `targetTouches` (not `touches` — a finger holding the Touch-mode ⌘ pill isn't a canvas touch). Zoom engages only past a 12 px spread dead-zone, rebaselining at engage so there's no jump — below it a two-finger gesture is pure pan (natural finger wobble otherwise produces per-frame micro-zooms that shimmer every stroke). In pen mode the same gestures arrive through the engine's recognizer instead (rAF-coalesced; delta #24) — the canvas's own `touchstart` never fires there, because the drawing SVG is the hit target. Everything about two-finger navigation in pen mode therefore rides on that recognizer keeping two contacts, and three separate things used to take one away:

- The stroke engine captured the first contact (`svg.setPointerCapture`, from either the pencil-only finger-hold arm or an ordinary stroke) and `cancelActiveStroke()` cleared the stroke state without handing the capture back. iPadOS cancels a still-captured touch pointer when a multi-touch gesture begins, so the recognizer dropped to one contact and no pan ever promoted (engine delta #35).
- Teardown paths that skipped the host's end callbacks: `pointercancel` and the stale-contact prune. All of them now funnel through one `endPanPinch()` (delta #36).
- And, since the notebook rebuilds its own gesture frame (camera at gesture start, "a pinch owns the camera" flag) from those callbacks, `onTouchGestureStart` resets that frame at *burst* recognition. Tying its lifetime to the burst rather than to matched start/end pairs means a leak from any future path costs one gesture instead of every gesture after it. Optional canvas **rotation** rides the same gesture behind a per-notebook toggle: `Camera.rotation` applies between zoom and translation, all screen↔world math funnels through `screenToCanvas`/`canvasToScreen`, exports and gutter mode stay axis-aligned.

Copy/paste serializes the selection (+ contained flow edges) as a `steiner-clipboard` JSON envelope (interchangeable with the Steiner project), stashed on `window.__hushNotebookClipboard` as a fallback when the OS clipboard write is rejected; paste mints fresh ids and remaps parent/group/edge references.

Pasting *into* the canvas has two routes and `canvas-paste.ts` owns both: the browser's own `paste` event, whose `DataTransfer` needs no permission and can't be refused, and a ⌘V keydown that reads the OS clipboard itself, for the platforms that dispatch no paste event when nothing editable is focused. The event wins wherever it exists, and the keydown route is deliberately **not** cancelled on iOS — cancelling it is exactly what stops WebKit dispatching the event, which is why an image paste there used to raise a system "Paste" dialog and take three tries. A **paste catcher** — a 1×1 transparent `contenteditable` focused for the duration of the keystroke — gives WebKit the editable target it insists on dispatching `paste` at, since a canvas has none; it is armed only on ⌘V, so the hardware keyboard implied by that chord means the software keyboard never appears. A short grace timer covers a ⌘V that produces no event even so. Both routes claim the paste through one dedup so they can never both act on it.

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
