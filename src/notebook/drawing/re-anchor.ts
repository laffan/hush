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
 * (`RESIZE_RATIO_THRESHOLD`). Re-anchor cost is O(N strokes); the
 * margin keeps it amortized cheap.
 */

import type { Camera } from "../types";
import type { EngineStroke } from "./sync-shim";

/** Smallest world-space side length the canvas backing will use. At
 *  zoom=1 this gives DPR=2 on retina (2048*2 = 4096 backing) for
 *  crisp strokes near the camera. */
export const WORLD_SIZE_MIN = 2048;
/** Multiplier on the visible viewport when picking the canvas world
 *  size: the canvas covers `factor × visible-viewport` so strokes
 *  drawn near the screen edges have headroom before re-anchor. */
const VIEWPORT_COVERAGE_FACTOR = 1.25;
/** Re-anchor when the visible viewport's world bbox comes within
 *  REANCHOR_MARGIN_FRAC × current worldSize of any canvas edge. */
const REANCHOR_MARGIN_FRAC = 0.15;
/** Re-resize when the wanted world size differs from the current
 *  one by more than this ratio. Avoids re-bakes for tiny zoom
 *  nudges that don't actually need a different size. */
const RESIZE_RATIO_THRESHOLD = 1.4;

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
}

export function createReanchor(opts: ReanchorOptions): ReanchorController {
  const { anchor, strokeEngine, refreshSelectionBBox, pocketStash, pocketStashCtx, sizeCanvases, getDpr } = opts;

  function wantWorldSize(zoom: number): number {
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const longestVisibleWorldSide = Math.max(vw, vh) / Math.max(zoom, 0.01);
    return Math.max(WORLD_SIZE_MIN, longestVisibleWorldSide * VIEWPORT_COVERAGE_FACTOR);
  }

  function needsReanchor(cam: Camera): boolean {
    const want = wantWorldSize(cam.zoom);
    if (want > anchor.worldSize * RESIZE_RATIO_THRESHOLD) return true;
    if (anchor.worldSize > want * RESIZE_RATIO_THRESHOLD && anchor.worldSize > WORLD_SIZE_MIN) return true;
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const vpLeft = -cam.x / cam.zoom;
    const vpTop = -cam.y / cam.zoom;
    const vpRight = vpLeft + vw / cam.zoom;
    const vpBottom = vpTop + vh / cam.zoom;
    const margin = anchor.worldSize * REANCHOR_MARGIN_FRAC;
    return (
      vpLeft   < anchor.originX + margin ||
      vpTop    < anchor.originY + margin ||
      vpRight  > anchor.originX + anchor.worldSize - margin ||
      vpBottom > anchor.originY + anchor.worldSize - margin
    );
  }

  function restashPocketedStrokes(): void {
    const dpr = getDpr();
    pocketStashCtx.save();
    pocketStashCtx.setTransform(1, 0, 0, 1, 0, 0);
    pocketStashCtx.clearRect(0, 0, pocketStash.width, pocketStash.height);
    pocketStashCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const s of strokeEngine.getStrokes()) {
      if (s.pocketed) strokeEngine.renderStrokeTo(pocketStashCtx, s);
    }
    pocketStashCtx.restore();
  }

  function reAnchor(cam: Camera): void {
    const newSize = wantWorldSize(cam.zoom);
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const vpCenterX = -cam.x / cam.zoom + (vw / cam.zoom) / 2;
    const vpCenterY = -cam.y / cam.zoom + (vh / cam.zoom) / 2;
    const newOriginX = vpCenterX - newSize / 2;
    const newOriginY = vpCenterY - newSize / 2;
    const dx = anchor.originX - newOriginX;
    const dy = anchor.originY - newOriginY;
    strokeEngine.translateAllStrokePoints(dx, dy);
    anchor.originX = newOriginX;
    anchor.originY = newOriginY;
    const sizeChanged = Math.abs(newSize - anchor.worldSize) > 0.5;
    anchor.worldSize = newSize;
    if (sizeChanged) {
      sizeCanvases();
      strokeEngine.resize(anchor.worldSize, anchor.worldSize);
    } else {
      strokeEngine.fullRebake();
    }
    restashPocketedStrokes();
    refreshSelectionBBox();
  }

  function ensureCoverage(cam: Camera): void {
    if (!needsReanchor(cam)) return;
    reAnchor(cam);
  }

  return { ensureCoverage, reAnchor };
}
