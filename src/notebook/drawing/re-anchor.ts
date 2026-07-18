/* src/notebook/drawing/re-anchor.ts
 *
 * Re-anchor controller for the drawing layer's canvas backing.
 *
 * The drawing engine renders into a fixed-pixel canvas wrapped in a
 * CSS-transformed div. The wrapper is GPU-composited as the camera
 * pans / zooms — fast — but the canvas backing covers a finite
 * world rect `[origin, origin + worldSize]`. Strokes outside that
 * rect have nowhere to be stamped, so we shift origin (and grow
 * worldSize when the user zooms out) as the camera moves so the
 * visible viewport always lands inside the canvas backing.
 *
 * The hot path is `ensureCoverage`: a cheap predicate that returns
 * fast when the camera is well inside the canvas. It only triggers
 * a `reAnchor` when the viewport drifts past `REANCHOR_MARGIN_FRAC ×
 * worldSize` of the canvas edge or when zoom wants a different size
 * (`RESIZE_RATIO_THRESHOLD`). A same-size re-anchor (pan at fixed
 * zoom) blits the done canvas forward and repaints only the newly
 * exposed edge strips (engine delta #25) — O(edge-strip ink). Only a
 * size-changed re-anchor (zoom crossed the resize threshold) still
 * pays a full O(visible ink) rebake.
 */

import type { Camera } from "../types";
import type { EngineStroke } from "./sync-shim";
// PERF-HUD (temporary): tracer singleton — see ../perf-hud.ts.
import { perf } from "../perf-hud";

/** Smallest world-space side length the canvas backing will use. At
 *  zoom=1 with a viewport of 1280 px or smaller this gives DPR=2 on
 *  retina (2048*2 = 4096 backing) for crisp strokes near the camera.
 *  Larger viewports grow above this floor and accept a lower DPR. */
export const WORLD_SIZE_MIN = 2048;
/** Multiplier on the visible viewport when picking the canvas world
 *  size: the canvas covers `factor × viewport` so strokes drawn near
 *  the screen edges have headroom before re-anchor. Must satisfy
 *  `factor > 1 / (1 - 2·marginFrac)` so a freshly-centered re-anchor
 *  has slack greater than the margin — otherwise `needsReanchor`
 *  fires immediately on the next frame and we re-anchor every pan
 *  step (the bug introduced in the first cut of this controller).
 *  With marginFrac = 0.10, factor must exceed 1.25; 1.5 leaves a
 *  comfortable buffer so each re-anchor buys ~17 % of viewport in
 *  pan distance before the next one. */
const VIEWPORT_COVERAGE_FACTOR = 1.5;
/** Re-anchor when the visible viewport's world bbox comes within
 *  REANCHOR_MARGIN_FRAC × current worldSize of any canvas edge.
 *  Smaller margin = more slack between re-anchors but less safety
 *  if the user pans faster than expected. 0.10 pairs with the
 *  factor above to put each re-anchor ~17% of viewport apart. */
const REANCHOR_MARGIN_FRAC = 0.10;
/** Re-resize when the wanted world size differs from the current
 *  one by more than this ratio. Avoids re-bakes for tiny zoom
 *  nudges that don't actually need a different size. */
const RESIZE_RATIO_THRESHOLD = 1.4;
/** reAnchor keeps the CURRENT worldSize (the cheap blit path) unless
 *  coverage is genuinely inadequate. Without this hysteresis, any zoom
 *  drift between re-anchors — a pinch that engaged for a moment mid-
 *  pan — changed `wantWorldSize` by more than the 0.5 px equality
 *  tolerance, and the next margin-breach re-anchor took the RESIZE
 *  path: full canvas resize + O(visible ink) rebake. On-device (round
 *  3 HUD capture) that was 10 of 16 re-anchors, at up to 1.5 s each.
 *  Must stay above 1 / (1 − 2·REANCHOR_MARGIN_FRAC) = 1.25, or a
 *  kept-size re-anchor would re-breach the margin immediately and
 *  re-anchor every frame; 1.35 keeps ≥ ~60 px of pan between blits in
 *  the worst drift band while tolerating ~10% of zoom-out drift
 *  before a real resize. */
const MIN_KEEP_COVERAGE = 1.35;

/** Mutable holder for the canvas backing's world-space anchor +
 *  side length. Owned by the drawing layer so its closures
 *  (`pointToLocal`, `applyWrapperTransform`, the sync-shim's
 *  localToWorld / worldToLocal) read the live values via the same
 *  reference; this controller mutates the same object. */
export interface AnchorState {
  originX: number;
  originY: number;
  worldSize: number;
}

/** Subset of the engine surface this controller touches. Kept
 *  structural so the drawing layer can pass its TS-typed engine
 *  binding through without a cast on the call site. */
export interface ReanchorEngine {
  translateAllStrokePoints(dx: number, dy: number): void;
  /** Engine delta #25 — same-size re-anchor in one call: translate
   *  points, rebuild the tile index, blit the done canvas by the same
   *  delta, and repaint only the newly exposed edge strips. dx / dy
   *  must be snapped to the device-pixel grid by the caller so the
   *  blit is pixel-exact. */
  reAnchorTranslate(dx: number, dy: number): void;
  fullRebake(): void;
  resize(width: number, height: number): void;
  getStrokes(): EngineStroke[];
  renderStrokeTo(ctx: CanvasRenderingContext2D, stroke: EngineStroke): void;
}

export interface ReanchorOptions {
  anchor: AnchorState;
  strokeEngine: ReanchorEngine;
  refreshSelectionBBox: () => void;
  pocketStash: HTMLCanvasElement;
  pocketStashCtx: CanvasRenderingContext2D;
  /** Resize the three stage canvases + wrapper + svg to the current
   *  `anchor.worldSize` and current DPR. Owned by the drawing layer
   *  because it also touches the wrapper / svg attributes. */
  sizeCanvases: () => void;
  /** Live DPR getter (capped against MAX_BACKING_PIXELS). */
  getDpr: () => number;
}

export interface ReanchorController {
  /** Hot-path camera change: returns immediately if the viewport is
   *  still well within the canvas. Otherwise re-anchors + rebakes. */
  ensureCoverage(cam: Camera): void;
  /** Forced re-anchor (used only by the drawing layer for tests /
   *  edge cases — normal flow goes through ensureCoverage). */
  reAnchor(cam: Camera): void;
  /** Repaint every pocketed stroke into the pocket stash from scratch.
   *  Runs internally after each re-anchor; also exposed so the sync
   *  shim's bulk-replace path can restore stash pixels for pocketed
   *  strokes that were never painted to the done canvas. */
  restashPocketedStrokes(): void;
}

export function createReanchor(opts: ReanchorOptions): ReanchorController {
  const { anchor, strokeEngine, refreshSelectionBBox, pocketStash, pocketStashCtx, sizeCanvases, getDpr } = opts;

  /** World-space axis-aligned bbox of the visible viewport. For an
   *  unrotated camera this is the plain rect the old inline math
   *  produced; a rotated camera maps the four screen corners through
   *  the inverse transform and takes their AABB (up to √2× larger at
   *  45°, which the coverage math absorbs like any other size). */
  function viewportWorldBounds(cam: Camera): { left: number; top: number; right: number; bottom: number } {
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const rot = cam.rotation || 0;
    if (!rot) {
      const left = -cam.x / cam.zoom;
      const top = -cam.y / cam.zoom;
      return { left, top, right: left + vw / cam.zoom, bottom: top + vh / cam.zoom };
    }
    const cos = Math.cos(rot), sin = Math.sin(rot);
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const [px, py] of [[0, 0], [vw, 0], [0, vh], [vw, vh]] as const) {
      const sx = px - cam.x, sy = py - cam.y;
      const wx = (sx * cos + sy * sin) / cam.zoom;
      const wy = (-sx * sin + sy * cos) / cam.zoom;
      if (wx < left) left = wx;
      if (wx > right) right = wx;
      if (wy < top) top = wy;
      if (wy > bottom) bottom = wy;
    }
    return { left, top, right, bottom };
  }

  function viewportSide(vp: { left: number; top: number; right: number; bottom: number }): number {
    return Math.max(vp.right - vp.left, vp.bottom - vp.top);
  }

  function wantWorldSize(cam: Camera): number {
    return Math.max(WORLD_SIZE_MIN, viewportSide(viewportWorldBounds(cam)) * VIEWPORT_COVERAGE_FACTOR);
  }

  function needsReanchor(cam: Camera): boolean {
    const want = wantWorldSize(cam);
    if (want > anchor.worldSize * RESIZE_RATIO_THRESHOLD) return true;
    if (anchor.worldSize > want * RESIZE_RATIO_THRESHOLD && anchor.worldSize > WORLD_SIZE_MIN) return true;
    const vp = viewportWorldBounds(cam);
    const margin = anchor.worldSize * REANCHOR_MARGIN_FRAC;
    return (
      vp.left   < anchor.originX + margin ||
      vp.top    < anchor.originY + margin ||
      vp.right  > anchor.originX + anchor.worldSize - margin ||
      vp.bottom > anchor.originY + anchor.worldSize - margin
    );
  }

  function restashPocketedStrokes(): void {
    const strokes = strokeEngine.getStrokes();
    let anyPocketed = false;
    for (const s of strokes) {
      if (s.pocketed) { anyPocketed = true; break; }
    }
    if (!anyPocketed) return;
    const dpr = getDpr();
    pocketStashCtx.save();
    pocketStashCtx.setTransform(1, 0, 0, 1, 0, 0);
    pocketStashCtx.clearRect(0, 0, pocketStash.width, pocketStash.height);
    pocketStashCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const s of strokes) {
      if (s.pocketed) strokeEngine.renderStrokeTo(pocketStashCtx, s);
    }
    pocketStashCtx.restore();
  }

  function reAnchor(cam: Camera): void {
    const vp = viewportWorldBounds(cam);
    const vpSide = viewportSide(vp);
    const want = Math.max(WORLD_SIZE_MIN, vpSide * VIEWPORT_COVERAGE_FACTOR);
    // Size hysteresis — keep the current worldSize (blit path) unless
    // it's genuinely wrong for the camera: too tight to buy real pan
    // slack (MIN_KEEP_COVERAGE), or oversized past the same ratio the
    // ensureCoverage predicate uses. `mustGrow` only matters while
    // `want` is clamped at WORLD_SIZE_MIN; the coverage check is the
    // effective growth trigger otherwise.
    const mustGrow = want > anchor.worldSize * RESIZE_RATIO_THRESHOLD;
    const shouldShrink = anchor.worldSize > want * RESIZE_RATIO_THRESHOLD && anchor.worldSize > WORLD_SIZE_MIN;
    const coverageTooTight = anchor.worldSize < vpSide * MIN_KEEP_COVERAGE;
    const newSize = (mustGrow || shouldShrink || coverageTooTight) ? want : anchor.worldSize;
    const vpCenterX = (vp.left + vp.right) / 2;
    const vpCenterY = (vp.top + vp.bottom) / 2;
    let newOriginX = vpCenterX - newSize / 2;
    let newOriginY = vpCenterY - newSize / 2;
    let dx = anchor.originX - newOriginX;
    let dy = anchor.originY - newOriginY;
    const sizeChanged = Math.abs(newSize - anchor.worldSize) > 0.5;
    if (!sizeChanged) {
      // Same-size path blits the done canvas forward (delta #25), so
      // snap the shift to the device-pixel grid — a fractional
      // device-pixel blit would resample (and, re-anchor after
      // re-anchor, progressively blur) the baked ink. The origin is
      // only "centered-ish" anyway; a sub-pixel nudge is far inside
      // the coverage margins.
      const dpr = getDpr();
      dx = Math.round(dx * dpr) / dpr;
      dy = Math.round(dy * dpr) / dpr;
      newOriginX = anchor.originX - dx;
      newOriginY = anchor.originY - dy;
    }
    // No-op skip: if the camera lands exactly where we are anchored
    // and worldSize doesn't want to change, the translate / rebake
    // would all be busy work. ensureCoverage's predicate normally
    // catches this, but a small floating-point difference can let a
    // call through; the early return keeps the steady-state path
    // free of canvas operations.
    if (!sizeChanged && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    perf.begin("reanchor"); // PERF-HUD (temporary)
    perf.count(sizeChanged ? "reanchor:resize" : "reanchor:blit"); // PERF-HUD (temporary)
    if (sizeChanged) {
      strokeEngine.translateAllStrokePoints(dx, dy);
    } else {
      // Same canvas dimensions — only the local-coord frame moved.
      // Delta #25 blit-forward path: translate points, rebuild the
      // tile index, slide the done canvas's pixels, and repaint only
      // the newly exposed edge strips — O(edge-strip ink) instead of
      // the full repaint that used to stall stroke-heavy pans.
      strokeEngine.reAnchorTranslate(dx, dy);
    }
    anchor.originX = newOriginX;
    anchor.originY = newOriginY;
    anchor.worldSize = newSize;
    if (sizeChanged) {
      sizeCanvases();
      // engine.resize() also clears live + preview and rebakes.
      strokeEngine.resize(anchor.worldSize, anchor.worldSize);
    }
    restashPocketedStrokes();
    refreshSelectionBBox();
    perf.end("reanchor"); // PERF-HUD (temporary)
  }

  function ensureCoverage(cam: Camera): void {
    if (!needsReanchor(cam)) return;
    reAnchor(cam);
  }

  return { ensureCoverage, reAnchor, restashPocketedStrokes };
}
