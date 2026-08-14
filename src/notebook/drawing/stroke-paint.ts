/* src/notebook/drawing/stroke-paint.ts
 *
 * "Paint strokes into somebody else's canvas" helpers, extracted from
 * drawing-layer.ts.
 *
 * Both walk the engine's stroke list and re-render each stroke through
 * the atlas renderer, rather than blitting the done canvas. That costs
 * O(ink) instead of one drawImage, and buys two things the blits can't
 * give:
 *
 *   - No leakage. A blit copies whatever pixels sit in a region,
 *     including strokes that merely overlap it — wrong for the selection
 *     rasterizer, which has to lift exactly the selected strokes.
 *   - No viewport limit. The done canvas only backs the world rect
 *     [origin, origin + worldSize] and re-anchors to follow the camera,
 *     so anything more than about a screen away simply isn't on it —
 *     which is why the export path can't blit. A 50-page proofread
 *     notebook is tens of thousands of world px tall; blitting produced
 *     a PDF carrying the ink from wherever the camera happened to be and
 *     nothing else.
 *
 * The target ctx's transform must already map world coords → target
 * pixels; these helpers add the local → world origin translate.
 */

import type { EngineStroke } from "./sync-shim";
import type { AnchorState } from "./re-anchor";

/** The slice of the stroke engine these helpers touch. `renderStrokeTo`
 *  is Hush delta #20 and postdates the inferred engine surface, hence
 *  the structural type rather than the engine's own. */
export interface StrokePaintEngine {
  getStrokes(): EngineStroke[];
  renderStrokeTo(ctx: CanvasRenderingContext2D, stroke: EngineStroke): void;
  getLayers(): { id: number; hidden?: boolean }[];
}

export interface StrokePaintOptions {
  engine: StrokePaintEngine;
  /** Live canvas anchor — the drawing layer re-anchors it as the camera
   *  moves, so it's read per call rather than captured. */
  anchor: AnchorState;
  /** hush shape id → engine stroke id, via the sync shim. */
  engineStrokeId(hushId: string): number | undefined;
}

export interface StrokePaint {
  renderStrokesTo(
    ctx: CanvasRenderingContext2D,
    hushIds: Iterable<string>,
    colorOverrides?: { foreground: string; headingColor: string },
  ): void;
  renderAllStrokesTo(ctx: CanvasRenderingContext2D): void;
}

export function createStrokePaint(opts: StrokePaintOptions): StrokePaint {
  const { engine, anchor, engineStrokeId } = opts;

  /** Render just the strokes matching `hushIds`, in the engine's
   *  canonical order so z-stacking matches the done canvas.
   *
   *  `colorOverrides` retints theme-tracking strokes (colorIsAuto /
   *  colorIsHeading) for a specific appearance without touching the
   *  engine's stored colours — the dual light/dark raster path. */
  function renderStrokesTo(
    ctx: CanvasRenderingContext2D,
    hushIds: Iterable<string>,
    colorOverrides?: { foreground: string; headingColor: string },
  ): void {
    const wanted = new Set<number>();
    for (const hid of hushIds) {
      const eid = engineStrokeId(hid);
      if (eid !== undefined) wanted.add(eid);
    }
    if (!wanted.size) return;
    ctx.save();
    ctx.translate(anchor.originX, anchor.originY);
    for (const s of engine.getStrokes()) {
      if (!wanted.has(s.id)) continue;
      // A shallow copy keeps the engine's stored colour untouched.
      if (colorOverrides && (s.colorIsAuto || s.colorIsHeading)) {
        engine.renderStrokeTo(ctx, {
          ...s,
          color: s.colorIsHeading ? colorOverrides.headingColor : colorOverrides.foreground,
        });
      } else {
        engine.renderStrokeTo(ctx, s);
      }
    }
    ctx.restore();
  }

  /** Render every stroke the done canvas would show, anywhere in the
   *  world. Exclusions mirror the engine's own `isStrokeHidden`:
   *  pocketed strokes live in the pocket tray, hidden layers are off. */
  function renderAllStrokesTo(ctx: CanvasRenderingContext2D): void {
    const hiddenLayers = new Set<number>();
    for (const L of engine.getLayers()) {
      if (L.hidden) hiddenLayers.add(L.id);
    }
    ctx.save();
    ctx.translate(anchor.originX, anchor.originY);
    for (const s of engine.getStrokes()) {
      if (s.pocketed) continue;
      if (s.layerId != null && hiddenLayers.has(s.layerId)) continue;
      engine.renderStrokeTo(ctx, s);
    }
    ctx.restore();
  }

  return { renderStrokesTo, renderAllStrokesTo };
}
