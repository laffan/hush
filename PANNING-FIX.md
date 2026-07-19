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

## ROUND 2 — the stall that survived the engine fix

On-device testing showed panning still hitching after the re-anchor
blit landed. Re-diagnosis found the dominant *felt* stall was never
(only) the rebake: it's the **autosave pipeline running a full-notebook
JSON serialize on the main thread at pan boundaries** — ~11.6 MB /
~250 ms on desktop V8 for a 5k-stroke notebook (measured; iPad JSC
2-4× worse, embedded images additional). Three compounding causes,
all fixed in this branch:

1. **Every two-finger pan flick marked the notebook content-dirty.**
   The first finger's pointerdown arms a marquee / drag / resize; the
   second finger promotes to pan via `cancelActiveInteraction()`, whose
   blanket `notify("shapes")` rode the `notebook-change` event into
   `notebookDirty = true` + the "user is writing" quiet-timer. The
   flowchart edge-hover badge did the same on plain cursor movement.
   Both now repaint through dedicated transient keys (`"interaction"`,
   `"flowHoveredEdgeId"` — see the StateKey union in `state.ts`) that
   the bridge / sync-shim / pane-sync ignore. Pan-only sessions no
   longer trigger content saves (or burn version snapshots).
2. **The 15 s starvation guard fired mid-pan.** `NotebookSaveGate.
   shouldDefer` now lets the guard override only the content-quiet
   window — never while a stroke is in flight or the camera moved in
   the last 400 ms. Writing sessions still persist (pen-up gaps give
   the override its window); a marathon pan saves at its first ≥400 ms
   pause.
3. **Camera-only saves re-serialized every shape.** `encodeNotebook-
   Content` is now split into `encodeNotebookBody` (shapes / layers /
   flowEdges / bookmarks) + `assembleNotebookContent` (header + camera
   + background), byte-identical composition verified against the old
   encoder. The bridge caches the body fragment and reuses it while no
   content change is flagged: measured 231 ms full encode → 0.09 ms
   reassembly at 5k strokes. Cache invalidated on mount / unmount /
   sync reload; content-dirty saves re-encode.

## ROUND 3 — on-device diagnostics (PERF HUD, temporary)

The lag reportedly survived rounds 1 + 2, so this branch now ships an
**on-canvas perf overlay** (`src/notebook/perf-hud.ts`, mounted by the
bridge on every main-canvas notebook) to attribute the stall on the
iPad itself — no console needed. Remove later by deleting perf-hud.ts
and every line tagged `PERF-HUD` (grep for it).

**Round 3 findings (first on-device HUD capture, iPad, 390 strokes,
zoom 0.896):** PAN fps 31 with stalls up to 1.7 s, and the attribution
was unambiguous — `reanchor` ate 3.7 s of main-thread time in 53 s of
panning, with **10 of 16 re-anchors taking the RESIZE path** (only 6
blits). Two compounding bugs in the round-1 implementation, both fixed:

1. **Resize hair-trigger.** `reAnchor` recomputed `wantWorldSize`
   unconditionally and treated any >0.5 px difference as a size change,
   so the tiniest pinch-drift in zoom between re-anchors forced the
   full-resize path. Now hysteresis-gated (`MIN_KEEP_COVERAGE = 1.35`):
   the current worldSize is kept — blit path — unless coverage is
   genuinely inadequate or oversized past `RESIZE_RATIO_THRESHOLD`.
2. **No-op canvas reallocation** (engine delta #27). Even a "real"
   resize re-assigned `canvas.width` on three 4096×4096 canvases —
   ~200 MB of IOSurface churn per resize on the capture device — when
   the DPR cap makes the pixel size CONSTANT across worldSize changes
   (px = round(W × 4096/W) = 4096, always). `resize()` and
   `sizeCanvases` now skip the backing write when dimensions are
   unchanged; a resize re-anchor costs a rebake, not a reallocation.

The capture also cleared several suspects: the round-2 fixes verified
on-device (`dirty:content` 4 in 53 s, `save:bodyReused` matching
camera saves, no mid-pan saves), `render:frame` averaged <1 ms,
`ui:shelf` / `ui:selToolbar` / `shim:diff` / `state:pinComp` all noise.
Several large `other` stalls (240-790 ms) clustered around the
re-anchor stalls — consistent with WebKit-side IOSurface/commit work
from the reallocation churn; expected to shrink with fix 2, and the
next capture will confirm. Known tradeoff: keeping worldSize across
zoom drift means effective DPR can sit below native after zooming out
and back in (mildly softer ink until a ≥1.4× shrink triggers); if that
reads badly on-device, the follow-up is an idle-time re-sharpen —
adopt the wanted size during a quiet moment instead of mid-pan.

**Second capture (post-hysteresis):** the round-3 fixes verified
on-device — `reanchor:blit 8 / resize 1`, reanchor JS time 3.7 s →
0.26 s, PAN fps 31 → 50 — but the big stalls moved wholesale into
`other`: 1785 ms and 1191 ms with every instrumented section at ~zero,
plus repeating ~245-280 ms stalls right after blit re-anchors. That
pattern is the signature of WebKit paying for canvas rasterization at
COMMIT time (the JS just records display-list commands; a
software-rasterized — likely GPU-demoted — canvas plays them back on
the main thread after our spans close). Suspect: five 4096×4096
surfaces ≈ 335 MB of canvas backing. Round-3b changes on this theory:

- `shiftDoneCanvas` now prefers a single self-`drawImage` under the
  `'copy'` composite (source is snapshotted per spec; `'copy'` replaces
  the whole surface so trailing edges clear in the same op) — ONE
  full-surface raster instead of the scratch route's two, and the
  fourth world-sized surface is no longer forced into existence on
  first pan. `'copy'` semantics are verified once at runtime on a tiny
  canvas; misbehaving engines fall back to the scratch route. Chromium
  harness re-run pixel-identical via the new path.
- **HUD v2**: stall lines now carry camera annotations
  (`z… Δz… pan…px reA←…s`) so "flush after a re-anchor" vs "stall
  during a pinch" vs "pure pan" is readable from the paste-back; a
  `probe` button measures an identity full-surface self-copy on the
  real done canvas — JS ms vs the post-op frame gap (`probe:*` rows in
  the awaited table; near-zero JS + a huge post-op gap = software
  playback at commit, proving the theory); an `svg` button toggles the
  drawing layer's world-sized SVG overlay for an A/B pan test (stalls
  vanishing with it hidden would implicate compositor re-raster of
  that layer instead — pen input needs it back on afterwards).

**Third capture (probe run): the commit-cost theory is CONFIRMED.**
The v2 probe's own `postOpFrameGap 15ms` row was a measurement bug
(it timed the first→second frame gap; the flush lands between the op
and the FIRST frame) — but the stall log caught the truth: every
probe press produced a ~235-247 ms stall containing `probe:selfCopy
1.0`. So on this device a full-surface op on the 4096² canvas costs
**~0 ms of JS and ~240 ms at commit** (~280 MB/s — CPU-rasterizer
speed). The re-anchor accounting follows exactly: a blit re-anchor
did THREE full-surface ops (done self-copy + live clear + preview
clear) ≈ the observed ~490 ms stalls; a resize re-anchor's fullRebake
flush ≈ the 500-1300 ms ones (that capture's pinch sweep 1.0→0.65→1.0
legitimately forced 5 resizes).

Round-4 changes on those numbers:
- **Delta #28** — `translateAllStrokePoints` / `resize()` only clear
  the live / preview overlays when they can hold pixels (active
  stroke / live preview). During plain pans both are always empty, so
  a blit re-anchor drops from 3 full-surface ops to 1 (~490 → ~250 ms
  expected).
- **`REANCHOR_MARGIN_FRAC` 0.10 → 0.07** — re-anchors land ~45%
  further apart at zero quality cost (~168 px of world headroom
  remains past the viewport edge).
- **HUD v3** — probe now measures the op→first-frame gap
  (`probe:opToFrameGap`, the real flush), and every re-anchor records
  its own commit flush (`reanchor:blitFlushGap` /
  `reanchor:resizeFlushGap` in the awaited table), so the next capture
  quantifies both fixes directly.

**Fourth capture (post delta #28 + margin 0.07): op-shaving is
exhausted.** The fixed probe cleanly measured ~235 ms per full-surface
op (`probe:opToFrameGap`), yet pan stalls held at ~470 ms per
re-anchor — i.e. ~TWO full-surface costs per cycle even with the
clears skipped. The stall pairs (`reA←0.0s` then `reA←0.5s` with no
new re-anchor between) point at WebKit's own follow-on surface work
(copy-back / texture upload after a content change), which is outside
our reach. Idle is a clean 58.8 fps; all JS sections are noise.
Verdict: with a monolithic 4096² canvas on this hardware, every
re-anchor inherently costs ~2 × 240 ms of commit work. Architecture
change required.

## ROUND 4C — backing-size experiment (RUN + REVERTED)

**Outcome (fifth capture, 2896² backing):** mixed, and it reshapes the
tile plan. Re-anchor stalls DID halve (~470 → ~245 ms per stall; the
≥500 ms frame bucket emptied entirely, worst frame 1785 → 488 ms) —
linear in pixels as modeled. But the probe's full-surface self-copy
did NOT scale: ~243 ms on 8.4 MP vs ~234 ms on 16.8 MP — **full-
surface ops carry a ~240 ms floor independent of surface size**, while
small dirty regions (the strip rebakes) flush cheap. The felt pan
didn't meaningfully improve and the ink softening wasn't worth it →
cap reverted to 4096².

**Implication for the tile plan:** if tile-sized canvases inherit
anything like that per-surface floor, baking a tile would cost ~240 ms
and tiling would make panning WORSE. The floor must be measured at
tile sizes before the rewrite is green-lit — that's the HUD v4 `tiles`
button: it mounts composited test canvases at 512 / 1024 / 2048 CSS px,
fills their full surface, and records `tileProbe:<size>:opGap` rows.
Cheap floors (< ~40 ms) green-light tiles; a flat ~240 ms floor kills
them and redirects the effort (likely toward a WebGL ink presenter or
keeping the surface untouched during pans, Option E). The `probe`
button also gained a clipped 1×1 `probe:smallDirtyGap` control row for
the small-dirty-rect cost on the big surface.

## ROUND 4C ORIGINAL NOTES (for reference)

`MAX_BACKING_PIXELS` halved 4096² → 2896² (see the constant's comment
in `drawing-layer.ts`). Two things the next HUD capture answers:

1. **Linear model check** — `reanchor:blitFlushGap` / stall sizes
   should halve (~470 → ~235 ms). If they don't scale, the cost model
   is wrong and the tile design below needs rethinking.
2. **GPU-demotion wildcard** — if the demotion is a total-canvas-
   memory budget, halving may flip Canvas2D back onto the GPU and
   flush gaps collapse to ~0. That would redirect the whole effort
   toward staying under the budget rather than tiling.

Known cost while active: effective ink DPR ~1.72 → ~1.21 (softer ink
at 100% zoom on Retina). This is an experiment, not a destination.
Option E (defer re-anchors to gesture end — the stall moves to finger-
lift instead of mid-gesture, at the price of edge blanking on long
pans) is held in reserve as a comfort patch depending on how C feels.

## ROUND 5 — the readback diagnosis (SOLVED, pending on-device confirm)

**Sixth capture (tiles + probe + pan) named the true culprit.** Three
rows together: `tileProbe:2048:opGap ~17 ms` — a full-surface fill on
a fresh composited canvas of 4096×4096 DEVICE pixels (identical size
to the done canvas) costs one frame, at every size; yet
`probe:opToFrameGap ~230 ms` on the done canvas, and — the tell —
`probe:smallDirtyGap 225 ms` for touching a SINGLE PIXEL. The common
factor in every slow op was **`drawImage` with the done canvas as its
own source**: the spec forces a source snapshot, and WebKit implements
it as a whole-surface GPU→CPU readback (~230 ms at 4096²) no matter
how little is drawn. Raster throughput was never the problem; the
~280 MB/s "CPU rasterizer" model was wrong, the per-surface "floor"
was wrong — it was the readback all along. (The old scratch route paid
the same price differently: a DETACHED canvas is CPU-backed, so its
first leg was the readback.)

**The fix (engine delta #29):** `shiftDoneCanvas` now bounces through
an ATTACHED, composited helper canvas (`drawing-layer-dom.ts` mounts
it under the done canvas at 1% opacity — near-zero rather than zero
because WebKit demotes fully-hidden canvases off the GPU) using two
cross-canvas `'copy'` draws — no self-reference, no CPU-backed
intermediary, no readback. Projected re-anchor cost: ~2 frames instead
of ~480 ms. Self-blit and scratch remain as fallbacks. The `probe`
button gained `probe:doneToHelperGap` / `probe:helperToDoneGap` rows
measuring exactly the two production legs — the next capture should
show those at ~1 frame each, `reanchor:blitFlushGap` collapsing, and
pan stalls gone.

Residual known readbacks (rare ops, acceptable): pocketing a stroke
(`stashPocketRegion` reads the done canvas into the CPU-backed stash)
and export (`blitDoneCanvasAtWorldOrigin`). If pocket-in ever reads as
a hitch, attach the stash the same way.

**Seventh capture: blit legs CONFIRMED fast (doneToHelper 9 ms,
helperToDone 17 ms; many `reanchor:blitFlushGap` samples at ~15 ms),
self-read still ~230 ms — diagnosis and fix both proven. But a
~250 ms residual remains on stroke-crossing re-anchors, and the
across-captures accounting shows it was always there UNDER the blit
cost: the edge-strip rebake stamps hundreds of `drawImage` calls whose
sources are DETACHED (CPU-backed, mutable) tinted-atlas canvases —
per-draw source conversion/upload. Round 6 (delta #30) promotes every
tinted atlas to an ImageBitmap (immutable → texture-cacheable, canvas
fallback until resolved / where unsupported), and the HUD `probe`
gained a stamp-source A/B (300 stamps canvas-source vs
bitmap-source → `probe:stampCanvasGap` vs `probe:stampBitmapGap`).
Cheap on-device empty-notebook test: pan a NEW empty notebook — no
strokes means no strip stamping, so stall-free empty-notebook panning
independently confirms the stamp theory.**

**Eighth capture (existing 88-stroke + EMPTY notebook): stamp theory
falsified, suspect list down to two.** The empty notebook — zero
strokes, nothing to stamp — stalls identically (~235 ms per re-anchor
cadence), and the stamp A/B measured canvas-source = bitmap-source =
17 ms (stamps were never the cost; delta #30 stays as good hygiene).
`reanchor:blitFlushGap` now averages ~13 ms. The ~235 ms is attached
to the re-anchor EVENT itself, independent of strokes / blits /
clears / stamps. Remaining suspects, discriminated by the HUD v7
probes (`probe:doneFillGap` / `doneFillPanGap` / `transformOnlyGap`):
every earlier "cheap" probe ran on INVISIBLE (1-2% opacity) surfaces —
either any write to the VISIBLE done canvas pays the upload (but then
per-frame live-canvas ink redraws should stall too), or — the sharper
theory — a canvas write COLLIDING with a wrapper-transform change in
the same commit forces WebKit's synchronized slow path, which is the
one combination unique to re-anchors. If the collision theory holds,
the fix is a double-buffer swap: write the shifted content into the
INVISIBLE buffer, then flip buffer opacities + transform together
(compositor-only ops) in one frame — no visible-canvas write ever
coincides with a transform change. That needs the engine's done-target
to become swappable (mechanical: doneCtx getter indirection, pocket
blit + HUD queries follow the role) — sketched as delta #31 if the
probe confirms.

Also fixed this round (real bug the HUD margins exposed):
`dirty:camera 4743` vs `notify:camera 1198` — the bridge's container
listeners (notebook-change / notebook-camera-change) were never
removed and stacked across notebook switches within an app session,
multiplying dirty-marking and the pane-sync emit (~4× after four
opens). Both mount-path and unmount-path teardown now remove them
(and the mount path now removes the `notebook-bg-changed` document
listener too, a second pre-existing stack of the same kind).

**Ninth capture: FINAL COST MODEL.** `doneFillGap 16 ms`,
`doneFillPanGap 15 ms`, `transformOnlyGap 17 ms` — visible-canvas
writes are cheap and the transform-collision theory is dead;
`reanchor:blitFlushGap` averages ~7 ms; yet the ~235 ms stall still
fires once per re-anchor. The one untested cell of the matrix is the
one production hits: a FULL-SURFACE write to a VISIBLE 4096² canvas.
Unified model consistent with every capture:

> WebKit rasterizes Canvas2D CPU-side and, at commit, uploads the
> canvas's DIRTY REGION to the display surface at ~280 MB/s.
> Small dirty rects → cheap (ink stamps, 16 ms probes). Invisible /
> ~1%-opacity canvases → no upload at all (every "fast" probe, the
> blit helper). Fully-dirtying the visible 67 MB canvas → ~235 ms.
> Self-drawImage additionally snapshots (readback) at the same rate.

A sliding monolithic backing MUST fully-dirty its visible canvas per
re-anchor. Incremental fixes are exhausted by measurement — what
remains is architectural:

1. **Opacity-swap double buffer (delta #31 sketch, cheap experiment
   first).** Write the shifted frame into the 1%-opacity helper
   (measured cheap — no upload while effectively invisible), then swap
   the two canvases' opacities + roles in the same commit as the
   transform change. IF WebKit uploads the newly-visible buffer
   asynchronously (compositor-side), the stall vanishes for ~150 lines
   of work; if it uploads synchronously at the swap, we're no worse
   off. Requires the engine's done-target to be swappable (doneCtx
   getter indirection; pocket-blit + HUD class queries follow the
   role) — groundwork the tile renderer needs anyway.
2. **Tiled backing (the deterministic fix).** Now fully de-risked by
   on-device numbers: tile-sized canvas ops measured at ~17 ms even at
   4096² device px when the surface isn't the visible monolith; a
   512-768 CSS px tile uploads ~4-12 MB (~15-45 ms) ONCE at bake,
   prefetchable off the pan path; steady-state panning does ZERO
   canvas work. Bake tiles before attach (or attach at 1% opacity and
   promote) so even the bake upload lands off the visible path.

## OPEN — pen-mode two-finger pan (input routing, fix-2 family)

Reported alongside capture 9: with a pen/brush tool selected,
two-finger pan doesn't engage and the user must switch tools. Almost
certainly the pre-existing input-routing family (the Text-tool
editor-on-pointerdown "fix 2" was deliberately deferred in round 2;
pen-mode pan rides engine `gestures.js` → `onTouchPan*`), not a
regression from this branch's canvas work — nothing here touched
gestures.js / stroke pointer handlers / setInputEnabled. Needs its own
look in the next session: verify the gesture recogniser still receives
the touches (the HUD's `svg` A/B toggle hides the overlay entirely —
make sure it wasn't left hidden), then trace onPanStart delivery.

If the swap experiment or tiles land, the rounds 1-8 fixes all remain
load-bearing (saves, hysteresis, no-realloc, delta #28-#30 hygiene). Its
plan (and the tile probe that green-lit surface costs) stays here for
the future; zoom-crossing resize rebakes remain the one occasional
big flush (hysteresis keeps them rare; time-slicing is the follow-up
if they ever dominate a capture).

## DEFERRED — tiled backing (Option A, the structural end-state)

Replace the monolithic done canvas with a grid of fixed-size canvas
tiles (start at 1024 CSS px/tile; round-4C's numbers may tune this)
inside the same GPU-transformed wrapper. Each tile is permanently
bound to a world-space cell; panning never moves pixels. Coverage
manager creates/bakes tiles entering a ring around the viewport
(one per frame, or prefetched during idle) and LRU-releases distant
ones into a reuse pool (no realloc churn). Per-tile bake at the
measured 280 MB/s ≈ ~40 ms — and usually off the interaction path
entirely.

What it buys beyond pan: zoom resizes become progressive per-tile
rebakes (no more 776 ms atomic fullRebake flush), and many small
canvases are less likely to trip whatever budget demoted the big one
off the GPU.

Design notes / inventory for the session:
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
- Verification: the existing Chromium harness pixel-compares tiled
  output against the monolithic renderer (fringe-level tolerance
  already characterized); the HUD measures on-device flush per tile.
- Engine philosophy: this is the point where the engine becomes
  properly Hush's own — document as a major delta series (#29+) with
  the upstream-diff note updated in README-DRAWING.md.

Keep from this branch regardless of path: save-pipeline fixes (rounds
1-2), resize hysteresis + no-op realloc guard (round 3), delta #28,
the streamline cache, and the HUD.

**How to use it:**
1. Open the laggy notebook — a dark `PERF …fps stalls N` pill sits in
   the top-left of the canvas (drag its header to move it).
2. Pan around for 15-30 s the way that feels laggy. The pill flashes
   red on every main-thread stall ≥ 50 ms.
3. Tap `▸` to expand, then `copy`, and paste the report back into the
   session. If copy fails, the expanded text is selectable — long-press
   → Select All → Copy.
4. `reset` zeroes everything for a clean capture.

**How to read it (for whoever gets the report):**
- `PAN fps` is the number that matters — FPS measured only over
  seconds where the camera was actually moving, next to the input
  event rate. **60 fps + high input rate + visible jank ⇒ the main
  thread is innocent and the problem is compositor/GPU-side** (canvas
  layer re-raster, IOSurface traffic) — a completely different fix.
- `stalls` lines break each ≥50 ms main-thread gap into the
  instrumented sections that ran inside it; `other` is uninstrumented
  JS / GC / WebKit layout+paint.
- Instrumented sections: `render:frame` (main-canvas 2D repaint —
  text layout runs per frame), `engine:setCamera` (re-anchor predicate
  + wrapper transform), `reanchor` (+ `reanchor:blit` / `:resize`
  counters), `save:encodeBody` / `save:utf8` / `save:zipPack` /
  `save:bytesToArray`, `shim:diff` / `shim:bulk`, `state:pinComp`
  (pinned-box camera compensation), `ui:shelf` (shelf rebuild — fires
  on EVERY change event while open), `ui:selToolbar` (selection
  toolbar rebuild — every change event while a selection exists).
- Counters verify rounds 1 + 2 on-device: during a pan-only session
  `dirty:content` should stay flat, `save:run:cameraOnly` should be
  rare with `save:bodyReused` matching it, and `save:skip:*` shows the
  gate working.

Still open (known, deliberately not in this round):
- **Text tool eats two-finger pan** ("fix 2"): `handlePointerDown`
  opens the inline editor on pointerDOWN, so the first finger of a pan
  spawns an editor (iPad keyboard pops; the textarea swallows the
  second finger's touches) and the next gesture is consumed by
  `endEditingText`. Fix: create/edit on pointerUP-tap, suppressed when
  the gesture went multi-touch.
- A pan whose first finger lands ON a shape still nudges it >1 px
  before promotion (the drag's per-move mutations are real "shapes"
  notifies) — both a subtle position drift and a residual dirty-mark.
  Restoring pre-gesture positions in `cancelActiveInteraction` needs
  care around the engine preview pipeline.
- Local Folder notebooks still pack a JSZip + `Array.from(bytes)` on
  the main thread per save; content-dirty saves still stringify on the
  main thread (worker offload is the long-term fix).
- Desktop trackpad has no wheel-pan at all (`handleWheel` zooms only);
  space-drag is the only mouse-free pan. Wheel-pan (plain scroll pans,
  ctrl/pinch zooms) is an easy follow-up if desired.

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
