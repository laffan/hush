# Notebook Canvas Performance — Reference

The distilled record of the notebook panning-lag investigation
(July 2026, branch `claude/notebook-panning-lag-56okul`), kept because
its measurements constrain every future canvas change. The full
round-by-round narrative (10 on-device captures, each theory and its
falsification) lives in git history as `PANNING-FIX.md` /
`PANNING-JUMP-FIX.md` — both deleted when this summary replaced them.

Outcome: stroke-heavy notebook panning went from PAN fps ~31 with
0.5-1.7 s freezes to PAN fps ~55 with typical re-anchor flushes of
~9-15 ms.

## The WebKit canvas cost model (measured on iPad, DPR 2)

> WebKit rasterizes Canvas2D CPU-side and, at commit, uploads the
> canvas's **dirty region** to the display surface at ~280 MB/s.
> Small dirty rects are cheap (~one frame). Writes to invisible or
> ~1%-opacity canvases skip the upload entirely. Fully dirtying a
> VISIBLE 4096² canvas (67 MB) costs ~235 ms regardless of how cheap
> the JS was. Using a canvas as its own `drawImage` source
> additionally snapshots it — a whole-surface GPU→CPU readback
> (~230 ms at 4096²) even for a 1×1 dirty rect. Detached canvases are
> CPU-backed and pay the readback on their first use as a source.

Key measured numbers:

| Operation | Cost |
|---|---|
| Full-surface op fully dirtying the visible 4096² canvas | ~235 ms (commit-side; JS ≈ 0 ms) |
| Same op on a ~1%-opacity (still composited) canvas | ~1 frame |
| Full-surface fill, fresh composited canvas, 512-2048 CSS px (up to 4096² device px) | ~17 ms |
| Self-`drawImage` (any dirty size — it's the snapshot that costs) | ~230 ms |
| Cross-canvas `'copy'` blit legs via the attached helper | 9 / 17 ms |
| Small dirty rect (1×1, clipped) on the visible canvas | cheap **unless** the op is a self-drawImage |
| Full notebook JSON encode, 5k strokes (desktop V8; JSC 2-4× worse) | ~231 ms (~11.6 MB) |
| Envelope reassembly from cached body (camera-only save) | ~0.09 ms |
| Streamline pass, 5k×26-pt strokes (V8), uncached → cached | ~7 ms → ~0.8 ms |

Rules of thumb this implies:

- Never fully dirty a **visible** world-sized canvas on an interaction
  path. Paint into a near-invisible spare and swap roles (opacity +
  class + ctx rebind are compositor-cheap) — engine delta #31.
- Keep helper canvases at ~1% opacity, not 0 or `display:none` —
  WebKit demotes fully-hidden canvases off the GPU (CPU-backed).
- Never use a canvas as its own `drawImage` source on a hot path.
- `drawImage` **sources** should be immutable (`ImageBitmap`) so the
  texture caches (delta #30) — a mutable canvas source can re-convert
  per draw.
- Assigning `canvas.width` always clears AND can reallocate the
  backing (~200 MB IOSurface churn per resize at 4096²×3 canvases).
  Skip the write when the pixel size is unchanged (delta #27).

## Theories chased and falsified — don't re-chase these

Each was plausible, instrumented, and killed by a capture:

1. **Engine JS rebake cost dominates** — after deltas #25/#26 all JS
   sections measured as noise; the ~235 ms stalls persisted.
2. **Autosave serialize on the main thread** — real and fixed (see
   below), verified on-device; stalls persisted.
3. **IOSurface realloc churn / resize hair-trigger** — real and fixed
   (hysteresis + no-op-width guard); stalls moved into `other`.
4. **CPU-rasterizer throughput / per-surface ~240 ms floor** — killed
   by the 2896² backing experiment (probe cost didn't scale with
   surface size) and by tile probes (~17 ms full-surface fills at
   every size).
5. **Stamp-source uploads during strip rebake** — killed by an EMPTY
   notebook stalling identically and a 300-stamp canvas-vs-bitmap A/B
   measuring equal (17 ms both).
6. **Canvas-write + wrapper-transform collision in one commit** —
   killed by a probe writing to the visible canvas mid-pan: 15 ms.
7. Survivor: **dirty-region upload of the visible canvas** — confirmed
   when the delta-#31 opacity swap removed the stall.

## What landed, and where it's documented

- **Engine deltas #25-#31** (blit-forward re-anchor, streamline cache,
  no-op resize guard, empty-aware clears, attached blit helper,
  ImageBitmap atlases, opacity-swap double buffer): delta list in
  README-DRAWING.md + the header log in `engine/stroke.js`.
- **Save-pipeline fixes** (transient notify keys so gestures don't
  dirty content, starvation guard respects pan/stroke quiet,
  camera-only saves reuse a cached body fragment): the Autosave bullet
  in README-NOTEBOOK.md → "Integration with Hush".
- **Re-anchor tuning** (`MIN_KEEP_COVERAGE` 1.35 size hysteresis,
  `REANCHOR_MARGIN_FRAC` 0.07, device-pixel snap of origin deltas):
  comments in `src/notebook/drawing/re-anchor.ts`.
- **Bridge listener-stacking leak** (container + document listeners
  now removed on both teardown paths): `notebook-bridge.js`.
- **Perf HUD** (below): `src/notebook/perf-hud.ts`, gated behind
  Settings > Debug.

## The perf HUD

`src/notebook/perf-hud.ts` — on-canvas diagnostics built for this
investigation (iPad has no console), kept permanently behind
**Settings > Debug > Performance HUD** (`settings.debugPerfHud`,
default off; applies to the open notebook live). The tracer singleton
(`perf`) always records; the setting only gates the overlay.

**Using it:** open the notebook — a dark `PERF …fps stalls N` pill
sits top-left (drag its header to move it). Reproduce the problem for
15-30 s; the pill flashes red on every main-thread stall ≥ 50 ms. Tap
`▸` to expand, then `copy` to put a plain-text report on the clipboard
(the expanded text is also selectable). `reset` zeroes everything;
`probe` runs the canvas micro-benchmarks (self-copy, small-dirty,
helper legs, stamp A/B, visible-fill discriminators); `tiles` mounts
512/1024/2048 px composited test canvases and measures full-surface
fills; `svg` toggles the drawing layer's world-sized SVG overlay for
A/B pan tests (pen input needs it back ON afterwards).

**Reading a report:**

- `PAN fps` is the headline — FPS over seconds where the camera
  actually moved, next to the input-event rate. 60 fps + high input
  rate + visible jank ⇒ the main thread is innocent; the problem is
  compositor/GPU-side.
- `stalls` lines break each ≥50 ms gap into the instrumented sections
  that ran inside it (`other` = uninstrumented JS / GC / WebKit
  layout+paint), annotated with camera state (`z… Δz… pan…px reA←…s`)
  so "flush after re-anchor" vs "mid-pinch" vs "pure pan" is readable.
- Awaited table: `reanchor:blitFlushGap` / `resizeFlushGap` measure
  the op→first-frame commit flush of each re-anchor; `probe:*` /
  `tileProbe:*` rows hold the micro-benchmark results.
- Sections: `render:frame` (main-canvas 2D repaint), `engine:setCamera`,
  `reanchor` (+ blit/resize counters), `save:*`, `shim:diff`/`bulk`,
  `state:pinComp`, `ui:shelf`, `ui:selToolbar`.

To remove the machinery someday: delete `perf-hud.ts`, every line
tagged `PERF-HUD` (grep), and the Settings > Debug toggle.

## Open items (not addressed by this work)

- **Pen-mode two-finger pan doesn't engage** — with a pen/brush tool
  selected the user must switch to the pan tool first. Input-routing
  family, not canvas cost — nothing in the perf branch touched
  gesture routing. Check the HUD `svg` toggle wasn't left hidden,
  then trace `gestures.js` → `onTouchPan*` delivery.
- **Text tool eats two-finger pan** — `handlePointerDown` opens the
  inline editor on pointerDOWN, so a pan's first finger spawns an
  editor (keyboard pops; the textarea swallows the second finger).
  Fix: create/edit on pointerUP-tap, suppressed when the gesture went
  multi-touch.
- **Pan-over-shape nudge** — a pan whose first finger lands ON a shape
  still nudges it >1 px before gesture promotion (position drift +
  a residual content-dirty). Restoring pre-gesture positions in
  `cancelActiveInteraction` needs care around the preview pipeline.
- **Main-thread save tails** — Local Folder notebooks still pack JSZip
  + `Array.from(bytes)` on the main thread; content-dirty saves still
  stringify on the main thread. Worker offload is the long-term fix.
- **Desktop wheel-pan** — `handleWheel` zooms only; plain-scroll pan
  (ctrl/pinch to zoom) is an easy follow-up.

## Watch items

- **Post-idle blit spike** — one 858 ms `blitFlushGap` after a long
  idle in an otherwise ~9 ms series. Suspected WebKit purging the idle
  1%-opacity spare's backing store; first blit after idle then pays
  reallocation + full re-upload. If it recurs: periodic 1-px
  keep-alive touch on the spare, or accept one slow re-anchor per
  idle-return.
- **Resize-path stamping JS** — zoom-crossing rebakes still pay real
  stamping time (~283 ms worst case on stroke-heavy notebooks; the
  upload half is fixed by delta #31). Time-slice the rebake if a
  capture ever shows it dominating.
- **Known residual readbacks** (rare ops, accepted): pocketing a
  stroke (`stashPocketRegion` reads the done canvas into the
  CPU-backed stash) and export. If pocket-in ever reads as a hitch,
  attach the stash canvas like the blit helper.
- **Ink softness after zoom drift** — the size hysteresis keeps
  worldSize across zoom changes, so effective DPR can sit below native
  until a ≥1.4× shrink triggers a resize. If it reads badly, the
  follow-up is an idle-time re-sharpen (adopt the wanted size during a
  quiet moment, never mid-pan).

## DEFERRED — tiled backing (the structural end-state)

Replace the monolithic done canvas with a grid of fixed-size canvas
tiles (start at 1024 CSS px/tile) inside the same GPU-transformed
wrapper. Each tile is permanently bound to a world-space cell;
panning never moves pixels. A coverage manager creates/bakes tiles
entering a ring around the viewport (one per frame or prefetched
during idle) and LRU-releases distant ones into a reuse pool (no
realloc churn). **Green-lit by measurement**: tile-sized full-surface
ops cost ~17 ms at every probed size, and a 512-768 CSS px tile
uploads ~4-12 MB (~15-45 ms) once at bake — prefetchable off the pan
path; steady-state panning does ZERO canvas work. Bake tiles before
attach (or attach at ~1% opacity and promote) so even the bake upload
lands off the visible path.

Beyond pan: zoom resizes become progressive per-tile rebakes (no
atomic fullRebake flush), and many small canvases are less likely to
trip whatever budget demotes one huge canvas off the GPU.

Design notes / inventory:

- Engine `stroke-render.js`: per-tile contexts; the existing 512-px
  tile INDEX maps nearly 1:1 (align canvas-tile size to a multiple).
  Stamp clipping at tile edges reuses the proven rebakeTiles
  clip-at-boundary machinery (seam-safe by construction).
- `stroke.js`: endStroke / erase / slice / previewTransform write into
  every tile the stroke touches (ctx.translate(-tileOrigin) per tile);
  `translateAllStrokePoints`, `reAnchorTranslate` (delta #25), and
  `shiftDoneCanvas` are deleted — local coords become one stable frame.
- Live + preview overlays become VIEWPORT-sized layers counter-
  positioned against the wrapper transform (~3.4 MP each instead of
  world-sized; they redraw per frame during use anyway).
- `re-anchor.ts` → a much simpler coverage manager (which tiles exist
  for this camera); `sizeCanvases`, origin shifting, and the anchor
  record go away. Sync-shim world↔local translation simplifies.
- Pocket stash / export (`blitDoneCanvasAtWorldOrigin`) /
  `blitWorldRegion` / `renderStrokesTo` iterate tiles.
- Verification: the Chromium harness pattern from this investigation
  (serve the repo, drive the real engine modules, pixel-compare tiled
  output against the monolithic renderer; AA-fringe tolerance already
  characterized at ≤0.01% of pixels ≤25/255 premultiplied) plus the
  HUD for on-device flush per tile.
- This is the point where the engine becomes properly Hush's own —
  document as a major delta series with the upstream-diff note updated
  in README-DRAWING.md.
