# Stamped renderer — integration guide

A self-contained canvas-stamp pen tool. Strokes are kept as vector point
arrays (so select / transform / undo / layers all work) but rendering happens
by stamping a pre-baked brush bitmap along the streamlined path into a 2D
`<canvas>`. Intended for notebook-scale workloads on iPad Safari.

This document is written for a developer or agent who wants to drop the
renderer into an existing app and replace the toolbar / panels with a
different UI chrome.

---

## Quick take

- **Keep the engine files as-is.** They are pure JS modules with no
  framework dependency, coupled to the DOM only through factory
  arguments.
- **Throw away the skin and rebuild it.** `script.js`, `ui.js`,
  `layers.js`, `styles.css`, and the toolbar chunk of `index.html` are
  glue, not engine. Write your own.
- **The stage DOM is a hard contract.** Three stacked canvases + one
  SVG overlay. See [Stage DOM](#stage-dom-required).

---

## Module map

| File | Role | Modify when re-skinning? |
| --- | --- | --- |
| `stroke.js` | Stroke engine: pointer capture, stroke data model, layer ownership, public API. | No |
| `stroke-render.js` | Stamping loop + tile-indexed done-canvas rebake. Dispatches normal strokes to the direct-stamp hot path and non-normal modes (e.g. highlighter) to a scratch-canvas flatten path. | No |
| `stroke-erase.js` | Erase / slice controllers; history-diff session for eraser drags. | No |
| `stroke-geometry.js` | Pure math: streamline, bbox, slice, transform descriptors. | No |
| `stroke-atlas.js` | Brush atlas cache + tinted-variant compositing. Also owns `STROKE_MODES`, the per-stroke composite/alpha table (`normal`, `highlighter`, …). | Only to swap brush PNGs, add brush slots, or define a new stroke mode. |
| `selection.js` | Lasso, bbox, 8-handle resize, delete button. Pure SVG overlay. | No |
| `history.js` | Domain-agnostic `{undo, redo}` command stack. | No |
| `gestures.js` | Two- / three-finger tap recogniser for undo / redo on touch. | No |
| `brushes/` | `brush-0N.png` atlases. 512 × 128, 4 variants per row, alpha-masked. | Only to change brushes. |
| `layers.js` | Reference UI for the layers panel. | Replace with your own. |
| `ui.js` | Reference UI for toolbar / flyouts / brush grid / swatches. | Replace with your own. |
| `script.js` | Glue between engines and the reference UI. | Replace with your own. |
| `styles.css` | Styles for the reference UI. The stage + overlay classes at the bottom (`.draw-canvas`, `#canvas`, `.lasso`, `.bbox`, `.handle`, `.delete-btn`) must survive in some form. | Replace everything above the stage block. |
| `index.html` | Reference HTML. Only the `<main class="stage">` block is load-bearing. | Replace everything except the stage. |

---

## Stage DOM (required)

The engine mounts against this DOM structure. IDs are referenced
directly by the engine factories; class names are used by the selection
overlay CSS. If you rename them, update the factories and CSS to match.

```html
<main class="stage">
  <canvas id="done"    class="draw-canvas"></canvas>
  <canvas id="preview" class="draw-canvas"></canvas>
  <canvas id="live"    class="draw-canvas"></canvas>

  <svg id="canvas" xmlns="http://www.w3.org/2000/svg"
       preserveAspectRatio="xMidYMid meet">
    <circle id="eraserCursor" r="12" fill="none" stroke="#111"
            stroke-width="1" stroke-dasharray="3 3"
            visibility="hidden" pointer-events="none"/>
    <g id="selectionLayer"></g>
  </svg>
</main>
```

Rules:

- The three canvases stack in z-order: `done` (bottom), `preview`,
  `live` (top). Each has `pointer-events: none`.
- `#canvas` is the pointer target. It sits on top of the canvases and
  must be fully transparent, full-bleed, and own `touch-action: none`.
- `#eraserCursor` is the eraser disc; the engine mutates its `cx/cy/r`
  and `visibility`.
- `#selectionLayer` is where the selection engine appends the lasso
  path, bbox rect, resize handles, and delete button.

Selection overlay CSS (`.lasso`, `.bbox`, `.handle`, `.delete-btn`)
lives in `styles.css` — keep those blocks when you replace the file,
or port equivalent styles.

The engine computes device pixel ratio internally and resizes the
canvases on `window.resize` / `scroll`. Your container just needs to
give the stage a size.

---

## Minimum wiring

A complete integration, stripped of chrome. This is the smallest amount
of JS needed to get a working pen tool.

```js
import { createStrokeEngine } from './stroke.js';
import { createSelectionEngine } from './selection.js';
import { createHistory } from './history.js';
import { createGestures } from './gestures.js';

const svg = document.getElementById('canvas');
const doneCanvas = document.getElementById('done');
const previewCanvas = document.getElementById('preview');
const liveCanvas = document.getElementById('live');
const eraserCursor = document.getElementById('eraserCursor');
const selectionLayer = document.getElementById('selectionLayer');

let rect = { left: 0, top: 0, width: 0, height: 0 };
const getRect = () => rect;

function sizeCanvas() {
  const r = svg.getBoundingClientRect();
  rect = { left: r.left, top: r.top, width: r.width, height: r.height };
  svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
  strokeEngine.resize(r.width, r.height);
}
window.addEventListener('resize', sizeCanvas);

const history = createHistory();

const strokeEngine = createStrokeEngine({
  svg, doneCanvas, previewCanvas, liveCanvas, eraserCursor, getRect,
  onStrokeAdded: (stroke, index) => {
    if (history.isReplaying()) return;
    history.push({
      undo: () => strokeEngine.removeStrokes([stroke.id]),
      redo: () => strokeEngine.insertStrokeAt(stroke, index),
    });
  },
  onStrokesRemoved: (removed) => {
    if (history.isReplaying()) return;
    history.push({
      undo: () => { for (const r of removed) strokeEngine.insertStrokeAt(r.stroke, r.index); },
      redo: () => strokeEngine.removeStrokes(removed.map((r) => r.stroke.id)),
    });
  },
  onStrokesTransformed: (entries) => {
    if (history.isReplaying()) return;
    history.push({
      undo: () => { for (const e of entries) strokeEngine.setStrokePoints(e.id, e.before); },
      redo: () => { for (const e of entries) strokeEngine.setStrokePoints(e.id, e.after); },
    });
  },
  onStrokesSliced: ({ removed, added }) => {
    if (history.isReplaying()) return;
    history.push({
      undo: () => {
        if (added.length) strokeEngine.removeStrokes(added.map((a) => a.stroke.id));
        for (const r of removed) strokeEngine.insertStrokeAt(r.stroke, r.originalIndex);
      },
      redo: () => {
        if (removed.length) strokeEngine.removeStrokes(removed.map((r) => r.stroke.id));
        for (const a of added) strokeEngine.insertStrokeAt(a.stroke, a.finalIndex);
      },
    });
  },
});

const selectionEngine = createSelectionEngine({
  svg, layer: selectionLayer, getRect, strokeEngine,
  isSelectable: (s) => {
    const L = strokeEngine.getLayerById(s.layerId);
    return !!L && !L.locked && !L.hidden;
  },
  onExit: () => {/* your "leave select mode" logic */},
  onLassoComplete: () => {},
  onSelectionDeleted: () => {},
});

createGestures({
  getRect, strokeEngine, selectionEngine,
  onUndo: () => { history.undo(); },
  onRedo: () => { history.redo(); },
});

// iOS Safari gesture suppression — required for reliable pen capture.
svg.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
svg.addEventListener('touchmove',  (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturestart',  (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());

sizeCanvas();
```

Once this is live, every pen / touch / mouse input on `#canvas` records
strokes. Your own toolbar calls `strokeEngine.setTool('draw' | 'erase'
| 'slice' | 'select')`, `setColor`, `setSize`, `setBrush`, etc.

---

## Engine APIs

Everything is returned from a factory. No globals, no singletons.

### `createStrokeEngine(opts) → engine`

**Factory options** (all required unless noted):

| Option | Purpose |
| --- | --- |
| `svg` | Pointer target. Must be the top-most SVG in the stage. |
| `doneCanvas`, `previewCanvas`, `liveCanvas` | Stacked canvases; see DOM contract. |
| `eraserCursor` | `<circle>` inside the SVG the engine moves + shows. |
| `getRect` | `() => {left, top, width, height}`. Your page caches the stage rect and returns it. |
| `onLongPress` *(optional)* | `({ pointerId, point }) => void`. Fires after a 1.5 s hold with no drift; the reference UI uses it to promote draw / erase into a transient lasso. |
| `onStrokeAdded` | `(stroke, index) => void`. Record for history. |
| `onStrokesRemoved` | `(removed: [{stroke, index}]) => void`. Fires after whole-stroke erase. |
| `onStrokesTransformed` | `(entries: [{id, before, after}]) => void`. Fires after a selection move/resize commit. |
| `onStrokesSliced` | `({ removed, added }) => void`. Fires once per eraser or slice drag (aggregates the whole drag). |
| `onBrushAtlasLoaded` *(optional)* | Fires when a brush PNG decodes. Redraw any UI thumbnails you maintain. |
| `onLayersChanged` *(optional)* | Fires after any layer mutation. Rerender your layers panel. |

**Returned API (grouped):**

*Tool / style* — `setTool(t)`, `setColor(c)`, `setSize(n)`,
`setBrush(id)`, `setMode(mode)`, `setStreamline(v)`, `setSmoothing(v)`,
`setSpacing(v)`, `setEraserSize(n)`, `getEraserSize()`,
`getCurrentBrush()`, `getCurrentMode()`, `getBrushList() → [{id,
name}]`, `renderBrushSwatch(brushId, color, ctx, x, y, sizePx, mode?)`.
`mode` is a key from `STROKE_MODES` in `stroke-atlas.js` (`'normal'` or
`'highlighter'` out of the box); `setMode` silently no-ops on unknown
modes. The swatch `mode` arg defaults to `'normal'` and governs the
alpha used for the thumbnail so highlighter swatches read translucent.

*Data* — `getStrokes() → Stroke[]`, `getStrokeNode()` (always `null`
here; legacy API-parity stub), `getLayers() → Layer[]`,
`getLayerById(id) → Layer | null`, `getActiveLayerId() → id`.

*Mutations (all called by history replay and by retroactive UI)* —
`removeStrokes(ids)`, `insertStrokeAt(stroke, index)`,
`setStrokePoints(id, points)`, `setStrokesStyle(ids,
{color?, size?, brushId?, mode?})`, `setStrokesStyleMap(Map<id,
patch>)`, `clear()`. Patches accept any subset of the four style
fields; unknown `mode` values are ignored.

*Selection preview (called by selection.js, not by UI directly)* —
`previewTransform(idsSet, descriptor | null)`, `commitTransform(idsSet,
fn)`, where `descriptor` is one of

```js
{ kind: 'move',  dx, dy }
{ kind: 'scale', sx, sy, ax, ay }
```

*Layers* — `setActiveLayer(id)`, `createLayer({ idHint?, name?,
atIndex?, locked?, hidden? }?) → { layer, index }`, `deleteLayer(id) →
snapshot | null`, `restoreLayerSnapshot(snapshot)`, `renameLayer(id,
name)`, `setLayerLocked(id, bool)`, `setLayerHidden(id, bool)`,
`moveLayer(fromIdx, toIdx) → bool`.

*Lifecycle* — `resize(widthCss, heightCss)`, `cancelActiveStroke()`
(used by `gestures.js` when a second finger lands).

### `createSelectionEngine(opts) → selectionEngine`

Options: `svg`, `layer` (the `<g id="selectionLayer">`), `getRect`,
`strokeEngine`, `isSelectable` (optional), plus callbacks `onExit`,
`onLassoComplete`, `onSelectionDeleted`.

Returned: `activate()`, `deactivate()`, `startLassoAtPointer(pointerId,
point)` (used for long-press promotion), `getSelectedIds()`,
`hasSelection()`, `refreshBBox()`.

### `createHistory() → history`

`push({ undo, redo })`, `undo()`, `redo()`, `canUndo()`, `canRedo()`,
`isReplaying()`, `clear()`. 200-entry cap. The `isReplaying` flag lets
engine callbacks skip re-recording during replay — every callback
listed above includes that guard in the reference code.

### `createGestures(opts) → void`

Options: `getRect`, `strokeEngine`, `selectionEngine`, `onUndo`,
`onRedo`. Listens on the whole document for `pointerType === 'touch'`
and recognises 2- / 3-finger taps for undo / redo. Safe to omit on
desktop-only targets.

### `createLayersUI(opts) → { render, panel }`

Optional reference panel. Options: `panel`, `list`, `addBtn`,
`callbacks: { onSelect, onAdd, onDelete, onRename, onToggleLocked,
onToggleHidden, onReorder(fromIdx, toIdx) }`. Call
`render({ layers, activeLayerId })` on every `onLayersChanged`. Drag
handle uses pointer events and works on iPad. Replace freely.

---

## Data shapes

```ts
type Stroke = {
  id: number;
  tool: 'draw';        // always 'draw' once committed
  color: string;       // any canvas-accepted color string
  size: number;        // base radius in CSS px
  brush: string;       // brush id from BRUSH_DEFS (tip appearance only)
  mode: 'normal' | 'highlighter'; // key from STROKE_MODES; governs composite
  layerId: number;
  isPen: boolean;
  points: { x: number; y: number; pressure: number }[];
  // Internal; set by the tile index, do not mutate externally:
  bbox?: { minX, minY, maxX, maxY };
  tiles?: string[];    // tile keys of form "tx,ty"
};

type Layer = {
  id: number;
  name: string;
  locked: boolean;
  hidden: boolean;
};
```

`state.strokes` is kept sorted **bottom layer first** (lowest z-index
at the start of the array) so the existing tile index / rebake logic
iterates in natural paint order. Stroke inserts on commit go to the
top of the active layer's contiguous block; layer reorder re-sorts the
array and triggers a full rebake.

`Stroke.bbox` / `Stroke.tiles` are maintained by the renderer — do not
write to them. Selection / erase / transform all read them, so if you
ever construct a stroke from the outside (for example, to rehydrate a
saved document) pass it through `strokeEngine.insertStrokeAt(stroke,
index)` which calls `addToIndex` for you.

---

## Brushes and modes

Two orthogonal axes drive how a stroke is painted:

- **Brush** (`BRUSH_DEFS` in `stroke-atlas.js`) — tip *appearance*
  only: which atlas PNG (or procedural fallback shape) gets stamped
  along the path. A brush def is just `{ id, name, fallbackShape? }`.
  Atlases are tinted per `(brushId, color)` and cached.
- **Mode** (`STROKE_MODES` in `stroke-atlas.js`) — per-stroke
  *compositing behavior*: the `globalCompositeOperation` and
  `globalAlpha` used when a stroke is laid down on the done / live /
  preview canvas. Default `normal` is `source-over` at alpha 1;
  `highlighter` is `multiply` at alpha 0.5.

Any brush can be drawn in any mode. Adding a new mode is a two-line
change to `STROKE_MODES`:

```js
// stroke-atlas.js
export const STROKE_MODES = {
  normal:      { composite: 'source-over', strokeAlpha: 1 },
  highlighter: { composite: 'multiply',    strokeAlpha: 0.5 },
  // add your own here
};
```

The renderer picks up new modes automatically via `getModeComposite`.

### How the flatten path works

`renderStroke` in `stroke-render.js` dispatches on `stroke.mode`:

- `normal` (composite `source-over`, alpha 1) → direct stamp into the
  target canvas via `stampStream`. Pixel-identical to the pre-mode
  renderer; this is the hot path.
- Anything else → `renderStrokeFlat`. The stroke is stamped into a
  shared scratch canvas at normal composite / full opacity (so
  self-overlap inside a single stroke does not accumulate density),
  then only the stroke's bbox is blitted to the target with the mode's
  composite op and stroke alpha.

The scratch canvas is allocated lazily, sized to match the target
canvas, and reused for every flatten-path stroke. Clear / blit cost is
proportional to each stroke's bbox, not the canvas size, so rebake
cost tracks stroke footprint.

One intentional visual quirk: because the live canvas stacks above the
done canvas via normal HTML compositing, a highlighter stroke in
progress looks like an alpha-blended overlay rather than a true
`multiply`. On pointer release the stroke commits to the done canvas
and snaps to the correct multiplied appearance. This matches behavior
in Procreate / Notability and is not worth "fixing" unless you want
pixel-perfect preview fidelity.

---

## Re-skinning checklist

1. Keep the stage DOM exactly as specified, including the classes
   referenced by `.lasso`, `.bbox`, `.handle`, `.delete-btn` in
   `styles.css`.
2. Copy the engine modules unchanged. Do not modify `stroke.js`,
   `stroke-render.js`, `stroke-erase.js`, `stroke-geometry.js`,
   `stroke-atlas.js`, `selection.js`, `history.js`, `gestures.js`.
3. Copy `brushes/` unchanged (or replace the PNGs; keep the filenames
   `brush-01.png` through `brush-05.png` and the 512 × 128 atlas
   layout).
4. Write your own glue. Start from the *Minimum wiring* block; then
   add the toolbar, brush selection, color, size slider, layer panel,
   etc., as thin handlers that call the engine API.
5. Decide whether to reuse `layers.js` as-is or replace it. It is pure
   DOM; swapping is low-cost.
6. Port the iOS gesture suppression block and the `window.resize` /
   `scroll` hook — these are required, not stylistic.
7. Keyboard shortcuts (`Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`,
   `Cmd/Ctrl+Y`) are wired in `script.js`, not in any engine. Port
   them if you want them.

---

## Gotchas

- **Long-press promotion.** `onLongPress` is how the reference UI
  lets you start a lasso from inside the draw or erase tool. If you
  don't wire it, holding still for 1.5 s just cancels the in-flight
  stroke. Your UI can ignore the callback or repurpose it.
- **History + layer reorder.** Stroke history entries capture indices
  into `state.strokes`. A layer reorder between a stroke-add and its
  undo will shuffle those indices. The reference app accepts this for
  v1; if you need stricter correctness, snapshot the stroke's
  containing layer position rather than its global index.
- **`getStrokes()` is the canonical array.** Do not mutate it. The
  erase / selection engines read-mutate in place via engine methods
  only.
- **Rehydrating strokes without `mode`.** Strokes missing a `mode`
  field are treated as `'normal'` everywhere they're read, so older
  saved documents still render. If you persist strokes out-of-band,
  include the `mode` field alongside `brush` / `color` / `size` so
  highlighters round-trip correctly.
- **Hidden active layer blocks drawing.** Matches locked. This is a
  UX choice, not an engine constraint — easy to revisit if you want a
  "draw into hidden, see it when unhidden" flow (`stroke.js`
  `onPointerDown`).
- **DPR is handled inside `resize`.** Don't set `canvas.width` /
  `canvas.height` yourself; call `strokeEngine.resize(cssW, cssH)`.
- **Pointer capture is on `#canvas` SVG.** If you layer additional
  interactive elements over the stage, either make them
  `pointer-events: none` or stop the engine's pointer handlers from
  firing during your interaction.
- **Textured toggle / rough / grain / tooth.** These exist as no-op
  setters on the engine for API parity with the pure-svg renderer.
  The stamped engine gets its texture from the baked brush PNGs.
- **Brush PNGs load async.** Until a PNG decodes, the engine uses a
  procedural soft-round fallback. `onBrushAtlasLoaded` fires per
  brush so you can refresh any thumbnails.
