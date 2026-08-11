# Notebook Drawing — Technical Overview

Extension of [README-NOTEBOOK.md](README-NOTEBOOK.md). The drawing layer adds freehand ink, erase, slice, and lasso-select on top of the notebook's shape canvas. It lives in `src/notebook/drawing/` and is ported from a standalone [Perfect Freehand](https://github.com/steveruizok/perfect-freehand) + offscreen-bake stroke engine; the port's goal is keeping the engine fast (bake-to-canvas with tile indexing, GPU-composited preview transforms) while making every stroke a first-class Hush shape (undo, groups, layers, shelf, pocket, panes). There is no "drawing mode" — picking any drawing tool flips `state.tool = "pen"` and routes pointer input to the engine.

```
src/notebook/drawing/
  drawing-layer.ts       Factory + public API (camera sync, tool switch, brush apply,
                         selection-drag hooks, style patches, touch pan)
  drawing-layer-types.ts DrawingLayer interface + tool/style types
  drawing-layer-dom.ts   DOM scaffolding: transform wrapper, three stacked canvases,
                         pocket-stash canvas, SVG overlay, helper blit canvas
  selection-style.ts     Retroactive styling session (snapshot → apply → one undo entry)
  selection-bridge.ts    Mirrors state.selectedIds ↔ engine selection (Select tool parity)
  region-select.ts       Lasso / marquee → Hush's all-shape-types hit test; transient
                         sub-tool; mixed-selection bbox drag
  sync-shim.ts           state.shapes[] ↔ engine.strokes bridge (identity diff)
  re-anchor.ts           Camera-following origin shifts — the "infinite canvas"
  selection-drag.ts      Hush↔engine select-drag controller (pause-shim, commit-on-release)
  brush-slots.ts / brush-runtime.ts / brush-urls.ts / mini-palette.ts / flyout-styles.ts
                         Brush slot row, edit flyout, quick-palette strip, shared flyout CSS
  tool-panel.ts (+ tool-panel-snap.ts)  Appends divider + drawing tools to the bottom
                         toolbar (Lasso slots in beside Select instead); drag
                         handle, snap zones, minimize
  bg-settings-fixed-button.ts  Fixed bottom-right row: rotation readout/toggle + bg settings
  pocket-blit.ts         Pocket / done-canvas blit helpers
  layers-panel.ts        Layers dropdown (notebook-level)
  engine/                The stroke engine (ported; every Hush modification is tagged —
                         `grep -rn "Hush delta #" src/notebook/drawing/engine/`)
    stroke.js            pointerdown/move/up → active stroke → done canvas
    stroke-render.js     Stamps strokes into the done canvas via the brush atlas
    stroke-geometry.js   perfect-freehand integration, bbox, tile hashing, culling
    stroke-atlas.js      PNG atlas loader, per-brush tint cache
    stroke-erase.js      Pixel-test erase (whole stroke) + slice (split at cut)
    selection.js         Polygon lasso, move/delete, proportional resize, rotation
    gestures.js          Multi-touch: 2-/3-finger tap undo/redo, 2-finger pan, pinch
    layers.js            Engine-local layer records (mirrored from notebook state)
    brushes/             brush-N.png atlases
```

## Architecture

```
  Hush DrawingState ──┐                                       ┌── Hush UI (toolbar, shelf, pocket)
       state.shapes[] │                                       │
                      ▼                                       ▲
               ┌────────────┐   identity diff   ┌────────────┐
               │ sync-shim  │ ───────────────▶ │  engine    │
               │  (O(N))    │ ◀─────────────── │ strokes[]  │
               └────────────┘   engine-origin  └────────────┘
                      ▲            push-back          │
                      ▼
                              done canvas (baked) + active-stroke overlay + preview transform
```

### The sync shim

`state.shapes[]` is canonical; the engine holds a parallel `strokes[]`. The shim's invariants are load-bearing (documented in the file header — required reading before changing it):

1. **Identity diff only.** One O(N) ref-compare pass per `"shapes"` notify; never deep-compares points.
2. **Zero engine work on unrelated mutations.** Editing a TextShape must stay sub-millisecond on multi-thousand-shape notebooks.
3. **Engine-originated mutations bypass the diff** — the engine pushes into `state.shapes` and refreshes the shim's snapshot in one go, so the resulting notify sees no deltas.
4. **Mutations route through engine methods** (`setStrokesStyleMap`, `setStrokePoints`, `insertStrokeAt`, `removeStrokes`) — never poke `strokes[]`; the engine maintains bbox + tile indexes.
5. **Bulk loads pause per-stroke rebakes** (`insertStrokeAt(..., { skipRebake: true })` + one `fullRebake()`).
6. **Large diffs go bulk** — ≥50 changed strokes AND ≥25 % of the notebook abandons per-stroke updates (each triggers its own tile rebake; O(N²) in aggregate) for a wholesale rebuild + one rebake.

World↔local translation also lives at the shim boundary: `DrawShape.points` are world coords; the engine's stage is a CSS-transformed wrapper with a mutable world-space origin (below).

### Re-anchoring (infinite canvas)

The engine renders into a fixed-pixel canvas inside a CSS-transformed wrapper — pans/zooms are one GPU-composited transform, but the backing only covers `[origin, origin + worldSize]`. `re-anchor.ts` slides the origin (and grows `worldSize` at low zoom) so the viewport always lands inside the backing. `ensureCoverage(camera)` runs on every `setCamera`: a cheap predicate returns immediately with 10 % slack; otherwise a **same-size re-anchor** (the common case — pan at fixed zoom) translates stroke coords, slides the done canvas's pixels by the same delta, and repaints only the newly exposed edge strips (exact rects, not 512-px tiles, which would repaint most of the backing); origin deltas snap to the device-pixel grid so the blit never resamples. Size changes are hysteresis-gated so pinch drift can't force reallocation. Anchor state is one shared mutable record so a re-anchor propagates to every closure without re-binding.

Before the blit-forward path (delta #25), every re-anchor repainted all visible ink — a periodic main-thread hitch every couple hundred px of pan on stroke-heavy notebooks. The remaining full rebake is zoom-crossing resizes only.

### Engine deltas from the reference demo

Every modification to `engine/` is tagged at the call site (`grep -rn "Hush delta #"`) and listed here so a diff against the reference demo has a known shape. Deltas #1–#9 are integration plumbing (host-supplied `pointToLocal` / DPR / atlas URLs, exposed `fullRebake`, square handles, `pocketed` → hidden, delete badge suppressed). The rest are behavioural or perf, and several document non-obvious WebKit cost models:

- **#10–#13 touch**: two-finger pan + pinch recognized in `gestures.js` (the SVG overlay owns touches in pen mode), promotion works mid-stroke (the active stroke is cancelled; palm contacts rejected by size; stale contacts swept after 5 s).
- **#14 theme-tracking colors**: strokes carry `colorIsAuto` / `colorIsHeading` flags so theme switches retint them en masse.
- **#15 `setEventActive(false)`** — disable engine event capture without clearing the selection (brush-slot taps must not wipe a retroactive selection).
- **#16 `setChromeInteractive(false)`** — keep the selection bbox painted but `pointer-events: none` during draw/erase/slice so an invisible handle can't intercept the next stroke.
- **#17/#19 finger hold-to-select** in pencil-only mode (arms the lasso timer without seeding a stroke).
- **#18 `setPencilOnly`** — reject non-pen, non-mouse pointerdowns for the stroke path (iOS; flipped by `pencil-bridge.js`).
- **#20 `translateAllStrokePoints` + `renderStrokeTo`** — bulk origin shifts and single-stroke rendering for re-anchor + pocket stash + selection raster.
- **#21 per-point timestamps** (`t: e.timeStamp`, optional everywhere) — feeds ML Kit's pen-velocity model; only intra-stroke deltas are meaningful.
- **#22 skip-rebake inserts** for bulk loads.
- **#23 `hasActiveStroke()`** — the bridge defers autosaves until pen-up (a save's IPC marshal drops pointer samples → straight-line gaps in ink).
- **#24 rAF-coalesced gesture evaluation** — per-event evaluation paired one finger's fresh sample with the other's stale one, wobbling the pair spread and spuriously engaging pinch during parallel pans. Pinch rebaselines at engage; pair-angle rides along for canvas rotation.
- **#25 blit-forward re-anchor** (`reAnchorTranslate`) — see above; falls back to full repaint while a preview transform holds tiles out.
- **#26 per-stroke streamline cache** keyed by points-array **identity** (sound because geometry mutations replace the array — the same immutability the undo manager relies on). The active stroke is never cached; caches shift with re-anchors.
- **#27 no-op-safe `resize()`** — assigning `canvas.width` always clears and can reallocate the backing store; with DPR capped, worldSize changes usually keep the same pixel size, and the pointless reallocation measured **0.8–1.5 s of IOSurface churn per resize** on iPad.
- **#28 empty-aware overlay clears** — skip full-surface clears of the live/preview overlays when they can't hold pixels.
- **#29 readback-free done-canvas shift** — using a canvas as its own `drawImage` source forces WebKit to snapshot the whole surface (~230 ms GPU→CPU readback even for a 1×1 dirty rect); a *detached* scratch is CPU-backed and pays the same on its first leg. The blit routes through an **attached, near-invisible (1 % opacity) helper canvas** — composited, so GPU-backed, but its writes skip the display upload.
- **#30 ImageBitmap tinted atlases** — a canvas used as a `drawImage` *source* is mutable, so WebKit re-uploads it per draw; immutable bitmaps keep repeated stamps on the GPU (the edge-strip rebake was a ~220 ms commit stall without this).
- **#32/#33/#34 unified region selection** — a completed lasso or marquee hands its
  polygon to the host (`onLassoRegion`) instead of resolving it against strokes, so Hush
  can hit-test every shape type against it (`selection-region.ts`); a single finger
  dragging in pencil-only mode promotes into a **rectangle marquee** rather than
  abandoning the gesture (`onFingerDragSelect` → `startMarqueeAtPointer`, drift measured
  in client px because the hold's world-space threshold is one screen px at zoom 0.25);
  and the bbox accepts host-supplied bounds (`setExternalBounds`) so it frames — and
  drags — the text / images / drag-areas the engine can't see, with the resize and rotate
  handles hidden because those transforms only reach strokes. A pen contact during a
  finger-borrowed select hands the brush straight back (`onPenResumeDraw`) and draws.

- **#31 opacity-swap double buffer** — the governing cost model: WebKit rasterizes Canvas2D CPU-side and uploads the **dirty region** of *visible* canvases at ~280 MB/s (fully dirtying a visible 4096² canvas ≈ 235 ms however cheap the JS), while ~1 %-opacity canvases skip the upload. So shifts/repaints draw into the near-invisible helper and **swap the two canvases' roles** (opacity + class flips + ctx rebind — compositor-cheap); consumers resolve the current target via `getDoneCtx()` / `getDoneCanvas()` instead of capturing references.

### Apple Pencil (iOS)

Finger touches never draw — `setPencilOnly(true)` is flipped at startup by `pencil-bridge.js` (`PointerEvent.pointerType` is reliable on this WKWebView). Fingers still pan/pinch/tap-undo and can hold-to-lasso. The Pencil squeeze/double-tap has no PointerEvent equivalent, so `src-tauri/tauri-plugin-pencil/` attaches a `UIPencilInteraction` to the WKWebView and emits a `double-tap` plugin event → `toggleNotebookEraser()`. An earlier version of the plugin also attached a gesture recognizer to the scrollView for finger-vs-pencil detection — it broke touch delivery entirely and was removed; the plugin's sole job is the double-tap event.

### Tools, toolbar, brushes

The drawing tools sit past a divider on the single notebook toolbar (see README-NOTEBOOK.md for the bar's drag handle / snap zones / minimize) — except Lasso, which sits immediately right of the rectangle Select button at the head of the bar, because the two are the same operation with a different region shape. Sub-tools: `draw` (append strokes; the active brush slot indicates it — clicking any brush exits Erase/Slice back to Draw), `erase` (pixel-test, consumes whole strokes), `slice` (splits a stroke at the cut), `select` (polygon lasso). On iPad the finger owns the whole selection vocabulary while a brush or eraser is active. With nothing selected: **drag** sweeps a rectangle marquee, **hold** (duration from the Lasso flyout, 500–2000 ms) cancels the in-flight stroke and promotes into a freehand lasso. With something selected the finger becomes a mover: **drag from anywhere** carries the selection (no hunting for the bbox), and **tap** clears it — tap-then-sweep is how you select something else. The same rule runs under Hush's Select tool (`DrawingState.handlePointerDown`), where a finger drag that would have swept a marquee moves the selection instead. Two fingers stay tap-to-undo and drag-to-pan throughout, and the pencil draws at any point without being handed back its tool. Both resolve through Hush's shared region hit test, so either one selects strokes, text, images, and drag-areas together. The borrowed sub-tool is handed back when the region catches nothing, when a second finger promotes the burst into a pan, when the user taps empty canvas — or the moment the pencil touches down, which always draws. Canvas rotation and background settings live in the fixed bottom-right button row (`bg-settings-fixed-button.ts`).

**Brush slots** (`state.brushSlots[0..3]`): `{ brushId, color, size, mode, streamline, spacing }`. Colors `"auto"` and `"heading"` are theme sentinels resolving at paint time (tagged on strokes for retint). Clicking the already-active slot opens its edit flyout; edits also retroactively restyle a live selection, with slider drags wrapped in one style session per gesture so a sweep is a single undo entry (`snapshotSelectedStyle` → `applyStyleToSelection` → `commitStyleHistory`).

### Selection bridging + drag performance

The engine owns pen-mode lasso selection and pushes hits into `state.selectedIds`; `selection-bridge.ts` mirrors the reverse so the engine's bbox + handles also appear under Hush's regular Select tool. Three orthogonal toggles control chrome exposure per mode (`setBboxClickable`, `setChromeHidden`, `setChromeInteractive` — see deltas #15/#16). Resize is always proportional; the rotation handle tethers off the left edge (the selection toolbar kept covering a top handle); rotation bakes points on commit.

A selection can now include shapes the engine has never heard of. The bridge unions their
bounds into the engine bbox (delta #34) so pen mode — where the drawing SVG is capturing
and the notebook canvas never sees a pointerdown — still has chrome to show and something
to grab; dragging that bbox moves the strokes through the engine's preview transform and
every other shape through `DrawingState.updateExternalMove`, off one drag-start snapshot.
Resize and rotate hide for those selections rather than scaling the ink and leaving the
text behind.

**Select-drag routes through `engine.previewTransform`** instead of per-frame point mutation: begin excludes the dragged strokes from the done canvas and pauses the shim, update is a single CSS/matrix shift on the preview overlay (one composited frame, independent of N), end commits the total offset and resumes. A 500-stroke drag runs at single-stroke frame rate.

`beginSelectionDrag` returns the ids it adopted, and **DrawingState then holds those shapes still** for the drag — the engine is already drawing them at the offset and bakes the total on release, so rewriting every point every frame allocated a fresh point array per stroke per frame for a result nothing reads (stroke selections draw no Hush-side chrome). That redundant write was the whole reason a marquee-selected stroke drag chopped while the identical lasso-selected drag stayed smooth: the lasso path never enters `handlePointerMove`. Adopting also flips `strokeEngineDragging`, which parks the selection bridge — otherwise it recomputed the engine bbox from every selected point on every frame. A canvas with no drawing layer (or a preview that threw) gets a null back and keeps moving the points itself. Measured on the same 40-of-600-stroke selection: 1.19 → 0.15 ms per drag frame. Double-clicking a stroke selects just that stroke (the one way to pick a member out of a group).

**Pocket stash**: pocketed strokes are hidden from the done canvas (delta #8) and blitted into a separate offscreen stash canvas that the pocket tray renders from.

### Undo/redo

Drawing actions flow into Hush's snapshot-based `UndoManager` — the same `⌘Z` stack as every other notebook action. Engine callbacks bridge mutations into `state.shapes` and call `state.recordHistory()`; the shim's `isDiffing()` lets callbacks fired *by* a state→engine reflection (undo restoring shapes → `removeStrokes` → `onStrokesRemoved`) skip recording, or an undo would clobber the redo stack. The 2-/3-finger taps call `state.undo()`/`redo()` directly. `engine/history.js` (the reference demo's command stack) is unwired, pending removal.

## Development rules

Same as the notebook: 700-line cap, no frameworks, mutations through `DrawingState` or engine methods, **don't add work inside the shim's diff loop** — if a shape mutation needs extra processing, do it in the caller.

### Adding a new sub-tool

1. Add to the `DrawingSubTool` union in `types.ts`.
2. Pointer handling in `engine/stroke.js` (or a new `engine/*.js`).
3. Button in `SUB_TOOLS` in `tool-panel.ts` (or beside Lasso for custom click behaviour).
4. Route through `DrawingLayer.setTool()`; have the click handler call `activateDrawingSubTool()` (flips `state.tool = "pen"`, clears pans, sets the sub-tool).

### Adding a new brush

1. Drop `brush-N.png` into `engine/brushes/`.
2. Register in `brush-urls.ts` and `BRUSH_IDS` in `brush-slots.ts` — the atlas loader and tint cache pick it up.
