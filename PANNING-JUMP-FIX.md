# Panning Jumpiness — Diagnosis & Fix Plan

> **Superseded by `PANNING-FIX.md`** (notebook-improvements session):
> that doc folds in newer measurements, the gesture fixes that already
> landed, and corrected delta numbering (#24 is now taken — the cache
> described below becomes #25). Kept for history.

Handoff notes for the remaining notebook performance issue after the
stroke-optimization session (branch `claude/notebooks-stroke-optimization-2t12yz`,
commits `04ddd49..3a29614`). Writing at 5k+ strokes now holds 60–120 fps with
zero frame stalls; **panning still hitches periodically** on stroke-heavy
notebooks. The user can live with it, but this documents exactly what it is
and how to fix it when it's worth a session.

## Symptom

Pan a notebook containing a few thousand strokes (e.g. ~5,000 strokes /
~130k points — a long handwriting session). Panning is mostly smooth, but
every so often — roughly every 70% of a screen-width of travel — the canvas
freezes for a beat and then snaps to position. The hitch scales with how
much ink is on screen and near it. Between hitches, panning is perfectly
smooth. Zooming out makes hitches more frequent and more expensive.

## Why it happens

Steady-state panning is free by design: the drawing engine bakes all strokes
into a fixed-size "done" canvas inside a CSS-transformed wrapper, and the
camera just moves the transform (GPU-composited, no repaints). See
README-DRAWING.md → "Re-anchoring (infinite canvas)".

The cost is at the **re-anchor boundary**. The done canvas only covers a
finite world rect (`worldSize`, 2048 CSS px at zoom 1). When the viewport
gets within `REANCHOR_MARGIN_FRAC` (10%) of its edge,
`src/notebook/drawing/re-anchor.ts` slides the origin and rebuilds:

1. `strokeEngine.translateAllStrokePoints(dx, dy)` — shifts every point of
   every stroke, in place, to the new local frame. O(total points), cheap-ish.
2. `fullRebake()` → `rebuildIndex()` + `repaintAll()`
   (`src/notebook/drawing/engine/stroke-render.js`) — re-renders every
   stroke whose bbox intersects the canvas rect. **This is the hitch.**
3. `restashPocketedStrokes()` + `refreshSelectionBBox()` — minor.

`repaintAll` does cull off-canvas strokes (bbox vs canvas rect), but the
backing rect is ~2048×2048 world px — several screenfuls — so on a dense
handwriting page thousands of strokes survive the cull. For each one,
`renderStroke` pays twice:

- **`getStrokePoints(stroke.points, options.streamline)`** — a full
  perfect-freehand streamlining pass, **recomputed from scratch on every
  render of every stroke**. Nothing caches it. This is pure CPU and is
  the dominant per-stroke cost for short handwriting strokes.
- **`stampStream(...)`** — one `ctx.drawImage` (+ save/translate/rotate/
  restore) per stamp along the path. Proportional to visible ink; can't be
  skipped, but it's the smaller half for small strokes.

At zoom < 1, `wantWorldSize()` grows the backing (e.g. ~9600 world px at
zoom 0.25), so far more strokes pass the cull and rebakes get strictly
worse — matching "zoomed-out panning is jumpier".

Everything else that used to contribute has already been fixed and ruled
out with the perf harness: saves no longer run during panning at all
(quiet-moment gate in `src/notebook/notebook-save-gate.js` defers while the
camera moved <400 ms ago), camera-only saves are capped at one per 20 s, the
save itself blocks the JS thread only 5–15 ms (raw-body IPC), and the
cross-window broadcast is id-only. The main-canvas 2D renderer redraws
text/image shapes per camera frame, but strokes are excluded from it
(`renderer.ts` skips `type === "draw"`), so it's not the stroke-notebook
bottleneck — keep it in mind only for text-heavy canvases.

Note: while the JS thread is stalled by a rebake, WebKit's gesture/pointer
delivery mistimes, which is why bad hitches used to read as "panning stops
working" rather than mere stutter. Shrinking the stall fixes both.

## The fix, in order of leverage

### 1. Cache streamlined outlines per stroke (the main event)

Add a per-stroke cache of the perfect-freehand output so a rebake only
re-*stamps*, never re-*streamlines*, unchanged strokes.

Where: `renderStroke` in `src/notebook/drawing/engine/stroke-render.js`.
The renderer only consumes `.point` ([x, y]) and `.pressure` from
`getStrokePoints`'s output — cache exactly that.

```js
function streamPtsFor(stroke) {
  const c = stroke._streamCache;
  if (c && c.pointsRef === stroke.points && c.streamline === options.streamline) {
    return c.pts;
  }
  const pts = getStrokePoints(stroke.points, options.streamline)
    .map((p) => ({ point: p.point, pressure: p.pressure }));
  stroke._streamCache = { pts, pointsRef: stroke.points, streamline: options.streamline };
  return pts;
}
```

Invalidation is by **points-array identity** — the engine's own mutation
discipline already guarantees geometry changes replace the array
(`setStrokePoints`, `commitTransform` build new arrays). Document this as
the next engine delta (**#24**) in the `stroke.js` header log and in
README-DRAWING.md's delta list, matching the existing pattern.

Two traps, both load-bearing:

- **`translateAllStrokePoints` mutates `stroke.points` IN PLACE** (that's
  what a re-anchor calls — the exact moment the cache must survive). An
  identity-keyed cache goes stale-but-matching there. Streamlining is
  translation-invariant, so shift the cache alongside:
  in `translateAllStrokePoints` (`engine/stroke.js`), for each stroke also
  walk `s._streamCache?.pts` and add (dx, dy) to each `point[0]/point[1]`
  — or simpler and nearly as good, delete `s._streamCache` there ONLY if
  you accept paying one streamline pass per stroke per re-anchor (that
  forfeits most of the win; do the shift).
- **The active stroke** re-renders every frame while being drawn
  (`render()` → `renderer.renderStroke(liveCtx, a)`) and its points array
  is extended in place — identity unchanged, content growing. The cache
  MUST NOT serve the active stroke. Cheapest guard: in `endStroke`, the
  committed stroke gets rendered once more into the done canvas and only
  then indexed — either skip caching when `stroke === state.active`, or
  key the cache on `points.length` as well as identity.

Also invalidate on `size`? No — size affects stamping, not streamlining.
`setStrokesStyle` / `setStrokesStyleMap` don't touch geometry. Slice
(`stroke-erase.js`) creates new stroke objects with new points arrays —
covered by identity. `setStreamline` changes `options.streamline` —
covered by the cache's `streamline` field (brush flyout drives this).

Memory: one extra `{point, pressure}` per input point, engine-side only —
roughly doubles point storage for strokes that have rendered. Fine at 130k
points; if it ever matters, cap the cache to strokes above N points.

Expected result: re-anchor cost drops to translate + index rebuild + pure
stamping. Measured hunch from the session's numbers: the hitch should drop
well below 100 ms at 5k strokes at zoom 1.

### 2. If still hitchy: shrink what a re-anchor repaints

Options, cheapest first:

- **Blit-forward instead of repaint-overlap.** On a same-size re-anchor
  (pan, no zoom change), the old done canvas already contains almost all
  of the new view — `drawImage` the old canvas onto itself shifted by
  (dx·dpr, dy·dpr), then repaint only the newly-exposed edge strips
  (`rebakeTiles` on the exposed tile range). Turns O(visible ink) into
  O(edge strip ink). This composes with fix 1 and is the structural win;
  it needs care with the tile index (rebuild is still fine — it's cheap
  relative to painting) and with `previewingIds` bookkeeping (currently
  nulled on re-anchor; keep that).
- **Widen the slack** so re-anchors are rarer: `REANCHOR_MARGIN_FRAC`
  (0.10) and/or `VIEWPORT_COVERAGE_FACTOR` in `re-anchor.ts`. Rarer but
  equally sized hitches — only worthwhile combined with the above, and
  watch `MAX_BACKING_PIXELS` (canvas memory: 5 world-sized canvases exist —
  done/preview/live/pocket-stash/scratch).

### 3. Not recommended (considered and rejected)

- Time-slicing the rebake across rAFs (render into an offscreen, swap when
  done): correct but a big lifecycle change (input during partial bake,
  re-anchor-during-re-anchor), and fixes 1+2 should make it unnecessary.
- Rendering strokes through the main 2D canvas instead of the engine:
  defeats the entire bake-once architecture.

## How to verify (measure first, then after)

1. Resurrect the perf harness — it was removed in commit `3a29614`, so:
   `git checkout 3a29614^ -- src/notebook/perf-harness.ts src/notebook/ui/perf-panel.ts`
   then re-add the mount block in `notebook-bridge.js` (see
   `git show 3a29614 -- src/notebook/notebook-bridge.js` for exactly what
   was removed — the panel mount in `mountNotebook`, the `_perfPanel`
   teardown, and optionally the `hush-notebook-save-perf` event plumbing;
   the FPS/stall metrics are what matter here, the save metrics aren't).
2. Add a temporary probe around the suspect:
   `console.time("reAnchor")` / `timeEnd` in `re-anchor.ts::reAnchor`, or
   a duration log matching the harness's frame-stall lines.
3. Create Template → handwrite a–z → Generate Text (1000 words ≈ 5k
   strokes), then pan a full circuit around the ink field at zoom 1 and at
   min zoom. Baseline: frame stalls every ~70% of a screen of travel, each
   roughly matching the `reAnchor` timing.
4. Apply fix 1, repeat. Stalls should shrink to stamping cost; `reAnchor`
   timing splits visibly if you log translate/rebake separately.
5. Regression checks: draw mid-pan (gesture pan cancels the active stroke —
   unchanged), slice a cached stroke (new sub-strokes render correctly),
   brush-flyout streamline slider still restyles live (cache keys on the
   streamline value), pocketed strokes still show in the tray after a
   re-anchor (`restashPocketedStrokes` renders through the same cached
   path — that's fine and benefits too), export/raster output unchanged
   (`renderStrokeTo` shares `renderStroke`).
6. `npm run build` (700-line cap runs first) and `cargo test --lib` in
   `src-tauri/` must stay green. No Rust changes are expected for fix 1.

## Constraints

- `stroke-render.js` / `stroke.js` are ported engine files — keep changes
  as documented "Hush delta #N" entries (next free number: **#24**), same
  style as the existing 23.
- 700-line cap per file (`scripts/check-line-limits.sh`).
- Don't add work inside the sync shim's diff loop, and don't mutate
  `state.shapes` shape objects in place (undo checkpoints share references
  — see README-NOTEBOOK.md → Undo/redo). Engine-side stroke objects
  (`state.strokes` inside the engine) are engine-private and mutable;
  `_streamCache` lives there, never on the Hush `DrawShape`. Make sure the
  sync shim's `hushToEngineStroke` doesn't accidentally carry a stale
  `_streamCache` — it builds fresh engine strokes, so it can't, but a
  serializer must never persist the field either (it lives only on engine
  strokes, which aren't serialized — `DrawShape` is).
