/**
 * Annotation overlay for the proofread page rail.
 *
 * The rail paints pages out of small pre-baked thumbnails, which is what
 * keeps a fifty-page proof affordable. Everything the user *adds* —
 * strokes, text, drag boxes, pasted images — has no thumbnail and never
 * will, so it is drawn here as a live sketch: strokes as polylines, text
 * as one bar per line, boxes as outlines.
 *
 * ### Why sketch rather than flatten
 *
 * Rasterising the real canvas at rail scale would be the obvious way to
 * "flatten" annotations, and it is the one thing this module must not
 * do: it would force every page image to decode, which is precisely what
 * `image-budget.ts` exists to prevent, and it would do so on every
 * change. Sketching reads the shapes that are already in memory and
 * costs a few hundred `lineTo`s — cheap enough to run on a trailing
 * debounce and skip entirely mid-gesture.
 *
 * ### Coordinates
 *
 * The rail is a piecewise projection of the canvas: each page piece is
 * its own linear segment, and the fixed gaps between them compress
 * whatever world space lies between. `worldToRail` / `railToWorld` are
 * that projection and its inverse — the inverse is what makes a click
 * anywhere on the rail, gaps included, resolve to a real world point.
 */

import type { DrawShape, Shape, TextShape } from "../types";
import { LINE_HEIGHT_RATIO } from "../types";
import type { CanvasTheme } from "../themes";

/** One page piece's slice of the projection. */
export interface RailSegment {
  /** World cross-axis extent of the piece. */
  wTop: number;
  wBot: number;
  /** Rail y extent (CSS px within the rail column). */
  rTop: number;
  rBot: number;
  /** World → rail scale factor (uniform on both axes). */
  scale: number;
  /** World x / rail x of the piece's left edge. */
  wLeft: number;
  rLeft: number;
}

function segmentFor(segs: RailSegment[], worldY: number): RailSegment {
  for (const s of segs) if (worldY >= s.wTop && worldY <= s.wBot) return s;
  // Outside every piece: the nearest one, extrapolated. Keeps content in
  // a split gap (or dragged off the top of the document) on the rail
  // instead of silently vanishing from it.
  let best = segs[0];
  let bestD = Infinity;
  for (const s of segs) {
    const d = worldY < s.wTop ? s.wTop - worldY : worldY - s.wBot;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

export function worldToRail(segs: RailSegment[], x: number, y: number): { x: number; y: number } {
  if (!segs.length) return { x: 0, y: 0 };
  // Inside a gap, interpolate across the fixed strip so an annotation
  // written into an opened split still lands between the right pages.
  for (let i = 0; i < segs.length - 1; i++) {
    const a = segs[i], b = segs[i + 1];
    if (y > a.wBot && y < b.wTop) {
      const span = b.wTop - a.wBot;
      const t = span > 0 ? (y - a.wBot) / span : 0;
      return { x: a.rLeft + (x - a.wLeft) * a.scale, y: a.rBot + t * (b.rTop - a.rBot) };
    }
  }
  const s = segmentFor(segs, y);
  return { x: s.rLeft + (x - s.wLeft) * s.scale, y: s.rTop + (y - s.wTop) * s.scale };
}

export function railToWorld(segs: RailSegment[], rx: number, ry: number): { x: number; y: number } {
  if (!segs.length) return { x: 0, y: 0 };
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (ry >= s.rTop && ry <= s.rBot) {
      return { x: s.wLeft + (rx - s.rLeft) / s.scale, y: s.wTop + (ry - s.rTop) / s.scale };
    }
    const next = segs[i + 1];
    if (next && ry > s.rBot && ry < next.rTop) {
      const span = next.rTop - s.rBot;
      const t = span > 0 ? (ry - s.rBot) / span : 0;
      return { x: s.wLeft + (rx - s.rLeft) / s.scale, y: s.wBot + t * (next.wTop - s.wBot) };
    }
  }
  const last = ry < segs[0].rTop ? segs[0] : segs[segs.length - 1];
  return { x: last.wLeft + (rx - last.rLeft) / last.scale, y: last.wTop + (ry - last.rTop) / last.scale };
}

/** Stroke colour, resolving the two theme sentinels the drawing engine
 *  uses so ink that tracks the theme tracks it here too. */
function strokeColor(s: DrawShape, theme: CanvasTheme): string {
  if (s.colorIsAuto) return theme.foreground;
  if (s.colorIsHeading) return theme.headingColor;
  return s.color || theme.foreground;
}

/** Points drawn per stroke. A pencil stroke can carry thousands of
 *  samples; at rail scale a couple of hundred is already more than the
 *  pixels can show, and the cap is what keeps a redraw of a heavily
 *  annotated proof in the low single-digit milliseconds. */
const MAX_STROKE_POINTS = 160;

export interface RailInkOptions {
  shapes: Shape[];
  segments: RailSegment[];
  theme: CanvasTheme;
  /** Layer holding the page images — skipped, since the thumbnails
   *  already draw it. */
  pageLayerId: string | null;
  /** Layer ids whose contents are hidden on the canvas. */
  hiddenLayerIds: Set<string>;
}

/**
 * Repaint the whole overlay. Cheap enough to redraw wholesale — the
 * alternative (dirty rects over a piecewise projection) would cost more
 * bookkeeping than the drawing it saved.
 */
export function drawProofRailInk(canvas: HTMLCanvasElement, opts: RailInkOptions): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const { shapes, segments, theme, pageLayerId, hiddenLayerIds } = opts;
  if (!segments.length) return;

  const map = (x: number, y: number) => worldToRail(segments, x, y);
  const baseScale = segments[0].scale;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const s of shapes) {
    if (s.pocketed) continue;
    if (s.layerId && s.layerId === pageLayerId) continue;
    if (s.layerId && hiddenLayerIds.has(s.layerId)) continue;

    if (s.type === "draw") {
      const pts = (s as DrawShape).points;
      if (!pts || pts.length < 2) continue;
      const step = Math.max(1, Math.ceil(pts.length / MAX_STROKE_POINTS));
      ctx.strokeStyle = strokeColor(s as DrawShape, theme);
      ctx.globalAlpha = (s as DrawShape).mode === "highlighter" ? 0.35 : 0.9;
      ctx.lineWidth = Math.max(0.5, (s as DrawShape).size * baseScale * 0.9);
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += step) {
        const p = map(pts[i].x, pts[i].y);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      // Always finish on the real last point so a sampled stroke doesn't
      // stop short of where the user lifted the pen.
      const last = map(pts[pts.length - 1].x, pts[pts.length - 1].y);
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
      continue;
    }

    if (s.type === "text") {
      drawTextBars(ctx, s as TextShape, map, baseScale, theme);
      continue;
    }

    if (s.type === "drag-area") {
      const a = map(s.position.x, s.position.y);
      const b = map(s.position.x + s.width, s.position.y + s.height);
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = s.strokeColor || theme.foreground;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.setLineDash([]);
      continue;
    }

    if (s.type === "image") {
      // A pasted image has no thumbnail of its own; a filled block says
      // "something is here" without a decode.
      const a = map(s.position.x, s.position.y);
      const b = map(s.position.x + s.width, s.position.y + s.height);
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = theme.foreground;
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * Text as a stack of bars, one per line, each as long as its line is.
 * Actual glyphs at this scale are illegible mush; bars are the classic
 * minimap idiom and read instantly as "there is writing here".
 */
function drawTextBars(
  ctx: CanvasRenderingContext2D,
  t: TextShape,
  map: (x: number, y: number) => { x: number; y: number },
  scale: number,
  theme: CanvasTheme,
): void {
  const lines = (t.text || "").split("\n");
  if (!lines.length) return;
  const lineH = t.fontSize * LINE_HEIGHT_RATIO;
  const maxW = t.width || 350;
  // Rough character width for the bar length. Precision doesn't matter —
  // this is a texture, not a layout — and guessing costs nothing next to
  // running the real text measurer over every shape on every redraw.
  const charW = t.fontSize * 0.5;
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = t.color && t.color !== "#000000" ? t.color : theme.foreground;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/^#+\s*/, "");
    if (!raw.trim()) continue;
    const wWorld = Math.min(maxW, raw.length * charW);
    const a = map(t.position.x, t.position.y + i * lineH);
    const b = map(t.position.x + wWorld, t.position.y + i * lineH + t.fontSize * 0.7);
    const h = Math.max(1, b.y - a.y);
    ctx.fillRect(a.x, a.y, Math.max(1, b.x - a.x), h);
  }
  ctx.globalAlpha = 1;
}
