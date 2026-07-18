# Panning Hitch — Findings & Recommended Fix

> **STATUS: IMPLEMENTED** (branch `claude/notebook-panning-lag-56okul`).
> Both recommended fixes landed as engine deltas #25 (blit-forward
> re-anchor) + #26 (per-stroke streamline cache) — see the delta list in
> README-DRAWING.md and the header log in `engine/stroke.js`. Three
> refinements over the plan below, discovered during implementation:
>
> 1. **Device-pixel snap.** The re-anchor origin delta is snapped to the
>    device-pixel grid on the same-size path — a fractional device-pixel
>    blit would resample (and, re-anchor after re-anchor, progressively
>    blur) the baked ink.
> 2. **Exact-rect strip rebake, not tile keys.** Snapping a ~200-400 px
>    exposed strip outward to 512-px tiles repaints up to 12 of 16 tiles
>    on a diagonal re-anchor (measured *slower* than the old full
>    rebake). `renderer.rebakeRects` clears + repaints the literal strip
>    rects instead; seams are safe because the snap in (1) puts strip
>    edges on pixel boundaries.
> 3. **Preview-in-flight fallback.** If a preview transform is live at
>    re-anchor time, the done canvas has holes where the previewed
>    strokes' tiles are held out; the blit would carry the holes
>    forward, so that case falls back to a full repaint.
>
> Verified in a headless-Chromium harness driving the real engine
> modules (5k strokes × 26 pts, DPR 2): blit-forward re-anchor vs full
> rebake pixel-compares clean (identical up to sub-perceptual AA fringe,
> ≤0.01% of pixels at ≤25/255 premultiplied); streamline-cache render,
> streamline-value change, and preview-fallback compares are bit-exact;
> live-draw commit and slice through real pointer events match
> cache-cleared rebakes. Perf on the harness (software raster, so
> conservative): same-size re-anchor mean 538 ms vs 2226 ms full rebake
> (4.1×), single-axis 6.4×. On-device feel (iPad) still needs a manual
> pass — see the verification recipe below.

Handoff for the next session. Supersedes `PANNING-JUMP-FIX.md` (kept for
history): this doc folds in what the notebook-improvements session
(branch `claude/notebook-improvements-cr80bp`) fixed, measured, and
learned, and re-weights the fix plan accordingly.

## Symptom

Two-finger scrolling a stroke-heavy notebook: the pan freezes for
roughly a second every few seconds of travel, then snaps to position and
continues. Not a correctness bug — the scroll completes — but very
disruptive. Reported feel: "1 second out of every 5."

## What is already fixed (don't re-chase these)

The notebook-improvements session fixed two *gesture-recognition* bugs
with a similar feel, both in the pen-mode path:

- `engine/gestures.js` delta #24 — pan/pinch evaluation is rAF-coalesced
  so per-pointer sampling can't spuriously engage pinch and yank the
  zoom during a parallel-finger pan.
- `notes-canvas.ts` — the pinch handler rebaselines its camera reference
  at engage, so the canvas no longer snaps back to its pre-pan position
  when the spread drifts 12 px.

Those made pen-mode panning *track* correctly. The periodic freeze
described here is a different animal — a genuine main-thread stall —
and it is **still present**, in every tool mode.

## Root cause: the re-anchor rebake

Steady-state panning is free by design: baked strokes live in a
fixed-size canvas inside a CSS-transformed wrapper, and the camera just
moves the transform (GPU-composited). The backing only covers a finite
world rect (`worldSize`, 2048 CSS px at zoom 1), so when the viewport
drifts within `REANCHOR_MARGIN_FRAC` (10%) of its edge,
`src/notebook/drawing/re-anchor.ts` slides the origin and calls
`fullRebake()`:

1. `strokeEngine.translateAllStrokePoints(dx, dy)` — shift every point
   to the new local frame. Cheap (~1 ms / 130k points in desktop V8).
2. `fullRebake()` → `rebuildIndex()` (bbox + tile keys for every
   stroke; ~3.5 ms / 5k strokes) + `repaintAll()` — **this is the
   stall**, see below.
3. `restashPocketedStrokes()` + `refreshSelectionBBox()` — minor.

**Periodicity** falls out of the margins: at zoom 1 the backing buys
~230 px of horizontal pan (~410 px vertical) between re-anchors, so at
an unhurried scroll speed a re-anchor fires every few seconds. Distance-
based, not time-based. Zoomed out, `wantWorldSize()` grows the backing,
more strokes survive the cull, and each rebake gets strictly worse.

**Stall size** is two stacked costs per rebake, measured this session
(`5k strokes × 26 pts`, engine's real geometry code, desktop V8 — iPad
JavaScriptCore will be several times slower):

| Cost | Where | Measured (V8) | Notes |
|---|---|---|---|
| Streamline pass | `getStrokePoints` per stroke in `renderStroke` (`stroke-render.js:153`) | ~7 ms | Recomputed from scratch on EVERY render of every stroke; allocates 2 objects/point → GC pressure is the real tax on JSC |
| Stamping | `stampStream` | not measurable headless; dominant on-device | One `save → translate → rotate → drawImage → restore` **per stamp**; spacing floors at `max(0.6, size × spacingFrac)` px — a 3 px pen stamps every 0.6 px of path. A dense handwriting page ⇒ low hundreds of thousands of rotated drawImage calls in one synchronous pass |

While the JS thread is stalled, WebKit's pointer/gesture delivery
mistimes, which reads as worse than the freeze itself (and historically
as "panning stops working").

Contributors ruled out (previous sessions): saves are gated off during
panning (quiet-moment gate, `notebook-save-gate.js`), camera-only saves
capped, raw-byte IPC, id-only broadcasts. The main-canvas 2D renderer
skips `type === "draw"` shapes, so it isn't the stroke bottleneck.

## Recommended fix (both parts, one session)

### 1. Blit-forward re-anchor — the structural win

On a **same-size** re-anchor (pan at fixed zoom: `worldSize` and DPR
unchanged — the overwhelmingly common case during scrolling), the old
done canvas already contains almost everything the new one needs.
Instead of `repaintAll()`:

1. `translateAllStrokePoints(dx, dy)` as today, then `rebuildIndex()`
   (cheap, and required — tile keys are in local coords).
2. Copy the done canvas onto itself shifted by `(dx·dpr, dy·dpr)`.
   Self-`drawImage` is spec-defined (source snapshotted before
   painting); if a WebKit vintage misbehaves, blit through a scratch
   canvas instead.
3. Clear + repaint only the newly exposed edge strips: compute the one
   or two exposed rects, map to tile keys, `rebakeTiles(keys)`.
   `rebakeTiles` already clears whole tiles and repaints every stroke
   touching them from the (already-translated) points, so seams are
   handled by construction.
4. `restashPocketedStrokes()` unchanged (pocketed strokes aren't in
   the done canvas; the stash is small).

Size-changed re-anchors (zoom crossed `RESIZE_RATIO_THRESHOLD`) keep
the existing full-rebake path.

Turns O(visible ink) into O(edge-strip ink) — this is the change that
actually kills the felt hitch.

Notes:
- `previewingIds` / `previewingTiles` are already nulled by
  `translateAllStrokePoints`; keep that.
- Camera rotation (added this session) does NOT complicate this: the
  done canvas stays axis-aligned in world space — rotation lives
  entirely in the wrapper's CSS transform and `re-anchor.ts` already
  computes the rotated viewport's world AABB. The blit shift is a pure
  translation either way.
- The eraser's pixel-test reads strokes, not canvas pixels — unaffected.

### 2. Per-stroke streamline cache — helps every full rebake

Cache `getStrokePoints` output on the engine stroke, keyed by
points-array **identity** + the current `streamline` value:

```js
function streamPtsFor(stroke) {
  const c = stroke._streamCache;
  if (c && c.pointsRef === stroke.points && c.streamline === options.streamline) return c.pts;
  const pts = getStrokePoints(stroke.points, options.streamline);
  stroke._streamCache = { pts, pointsRef: stroke.points, streamline: options.streamline };
  return pts;
}
```

Identity keying is sound because geometry mutations replace the points
array (`setStrokePoints`, `commitTransform`, slice) — the same
immutability discipline the undo manager's shared checkpoints rely on.
Measured: the pass drops ~7 ms → ~0.8 ms (V8); expect a bigger relative
win on JSC (allocation/GC). Pans mostly stop needing it once fix 1
lands, but it speeds up every remaining full rebake: zoom-triggered
resizes, notebook load, layer reorder, theme retints.

Two load-bearing traps (unchanged from the earlier diagnosis):

- **`translateAllStrokePoints` mutates points IN PLACE** — the exact
  moment the cache must survive. Identity keying goes stale-but-matching
  there. Streamlining is translation-invariant: shift each cached
  `point[0]/point[1]` by (dx, dy) alongside the raw points. (Deleting
  the cache there instead forfeits most of the win — do the shift.)
- **The active stroke's points array grows in place** (identity
  unchanged, content changing) and re-renders every frame. The cache
  MUST NOT serve it: skip when `stroke === state.active`, or key on
  `points.length` too.

Non-invalidations, verified: `size` affects stamping only;
`setStrokesStyle` / `setStrokesStyleMap` don't touch geometry; slice
creates new points arrays (covered by identity); `setStreamline` is
covered by the cache's `streamline` field. `_streamCache` lives only on
engine-private strokes — never on `DrawShape`, never serialized (the
sync shim builds fresh engine strokes, so it can't leak).

### 3. Considered, not recommended alone

- **Widening `REANCHOR_MARGIN_FRAC` / `VIEWPORT_COVERAGE_FACTOR`** —
  spaces the hitches out without shrinking them; also raises canvas
  memory (5 world-sized canvases exist). Only as garnish after 1+2.
- **Raising the 0.6 px stamp-spacing floor** for small brushes would cut
  stamp counts linearly but changes ink appearance — don't couple it to
  this fix.
- **Time-slicing the rebake** across rAFs: big lifecycle change
  (input-during-partial-bake, re-anchor-during-re-anchor); unnecessary
  once 1+2 land.

## Verification recipe

1. Resurrect the perf harness (removed in `3a29614`):
   `git checkout 3a29614^ -- src/notebook/perf-harness.ts src/notebook/ui/perf-panel.ts`
   and re-add the mount block in `notebook-bridge.js`
   (see `git show 3a29614 -- src/notebook/notebook-bridge.js`). The
   FPS/frame-stall metrics are what matter; the save metrics aren't.
2. Temporary probe: `console.time("reAnchor")` around
   `re-anchor.ts::reAnchor`, split translate / index / blit / strip-
   rebake timings.
3. Baseline: dense handwriting page (~5k strokes), pan a full circuit at
   zoom 1 and at min zoom. Expect a stall at every re-anchor, ~matching
   the probe.
4. After fix 1: same circuit — stalls should shrink to edge-strip cost.
   After fix 2: zoom in/out across the resize threshold — the remaining
   full rebakes shrink too.
5. Regression checks: draw mid-pan (gesture pan cancels the active
   stroke — unchanged); slice a cached stroke (new sub-strokes render);
   brush-flyout Stream slider still restyles live (cache keys on the
   streamline value); pocketed strokes still show in the tray after a
   re-anchor; export/raster output unchanged (`renderStrokeTo` shares
   `renderStroke`); **re-anchor while the canvas is rotated** (two-finger
   rotation option ON, twisted view, long pan — strokes must not shift
   relative to the world); undo/redo across a re-anchor.
6. `npm run build` (700-line cap runs first) stays green. No Rust
   changes expected.

## Constraints

- `stroke.js` / `stroke-render.js` / `re-anchor.ts` changes must be
  documented as engine deltas in the `stroke.js` header log +
  README-DRAWING.md's delta list. **Next free delta number: #25** —
  #24 was consumed this session by the rAF-coalesced gesture flush
  (the old doc predates that and says #24; don't reuse it).
- 700-line cap per file (`scripts/check-line-limits.sh`).
- No work inside the sync shim's diff loop; never mutate `state.shapes`
  shape objects in place (undo checkpoints share references). Engine-
  side stroke objects are engine-private and mutable — the cache
  belongs there.
