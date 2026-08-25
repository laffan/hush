/**
 * Annotation overlay for the proofread page rail.
 *
 * The rail paints pages out of small pre-baked thumbnails, which is what
 * keeps a fifty-page proof affordable. Everything the user *adds* —
 * strokes, text, drag boxes, pasted images — has no thumbnail and never
 * will, so it is drawn here as a live sketch: strokes as polylines,
 * prose as one bar per wrapped line, headings as real (scaled) text,
 * boxes as outlines.
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
 * its own linear segment, and the clamped gaps between them compress (or
 * stretch) whatever world space lies between. `worldToRail` /
 * `railToWorld` are that projection and its inverse — the inverse is
 * what makes a click anywhere on the rail, gaps included, resolve to a
 * real world point.
 */

import type { DrawShape, Shape, TextShape } from "../types";
import { FONT_FAMILY, LINE_HEIGHT_RATIO } from "../types";
import type { CanvasTheme } from "../themes";
import { parseText } from "../markdown";
import { getMeasureCtx } from "../utils";

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

/** Floors for a text bar. Anything the user can see on the canvas has to
 *  be findable on the rail, and a correctly-scaled half-pixel bar is
 *  indistinguishable from not drawing it at all. Below the line pitch
 *  the floor makes consecutive bars touch, which reads as a solid block
 *  of prose — the right answer at that size anyway. */
const MIN_BAR_W_PX = 3;
const MIN_BAR_H_PX = 1.5;

/** Smallest size a heading is drawn at. Its true scaled size is often
 *  a pixel or two, which is no text at all; the floor buys legibility as
 *  the rail is widened, and `fillText`'s maxWidth argument condenses the
 *  glyphs so a floored heading still can't escape its own block. */
const MIN_HEADING_PX = 5;

export interface RailInkOptions {
  shapes: Shape[];
  segments: RailSegment[];
  theme: CanvasTheme;
  /** Layer holding the page images — skipped, since the thumbnails
   *  already draw it. */
  pageLayerId: string | null;
  /** Layer ids whose contents are hidden on the canvas. */
  hiddenLayerIds: Set<string>;
  /** Canvas font stack, so heading text measures and paints the same
   *  way it does on the canvas itself. */
  fontFamily: string;
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
  const { shapes, segments, theme, pageLayerId, hiddenLayerIds, fontFamily } = opts;
  if (!segments.length) return;

  const map = (x: number, y: number) => worldToRail(segments, x, y);
  const baseScale = segments[0].scale;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const s of shapes) {
    if (s.pocketed) continue;
    if (s.layerId && s.layerId === pageLayerId) continue;
    // Belt and braces for the layer check: a proof baked before
    // `pageLayerId` was recorded has none to match against, and painting
    // a grey block over every page thumbnail would be a spectacular way
    // to fail. The page marker rides the shape itself.
    if (s.type === "image" && typeof s.proofPageIndex === "number") continue;
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
      drawTextPreview(ctx, s as TextShape, map, baseScale, theme, fontFamily);
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
 * Text preview: stripes for prose, real glyphs for headings.
 *
 * Two things make this more than a row of rectangles.
 *
 * **The block has to be the right height.** Counting `\n`s undercounts
 * badly — a paragraph that wraps to six visual lines is one newline —
 * so the shape is run through the same `parseText` the renderer uses,
 * with the same measurer and the same constraint width. The rail then
 * shows a note occupying the space it really occupies, which is most of
 * what makes a minimap trustworthy.
 *
 * **Headings are drawn as text.** They are the landmarks — the thing a
 * reader scans a minimap *for* — and a stripe is a landmark you can't
 * read. Body text stays striped: real glyphs at this scale are mush,
 * and pretending otherwise costs a `fillText` per line for nothing.
 */
function drawTextPreview(
  ctx: CanvasRenderingContext2D,
  t: TextShape,
  map: (x: number, y: number) => { x: number; y: number },
  scale: number,
  theme: CanvasTheme,
  fontFamily: string,
): void {
  const ff = `${t.fontFamily || fontFamily}, ${FONT_FAMILY}`;
  const measureCtx = getMeasureCtx();
  const measure = (text: string, fs: number): number => {
    measureCtx.font = `${fs}px ${ff}`;
    return measureCtx.measureText(text).width;
  };
  const parsed = parseText(
    t.text || "",
    t.width && t.width > 0 ? t.width : undefined,
    t.fontSize,
    measure,
  );
  if (!parsed.length) return;

  // `t.color` may hold the theme sentinels ("auto" / "heading"), which
  // Canvas would silently reject, leaving the previous fill in place.
  const col = t.color;
  const resolved = col && col !== "#000000" && col !== "auto" && col !== "heading"
    ? col
    : theme.foreground;

  ctx.textBaseline = "top";
  let yWorld = t.position.y;
  for (const line of parsed) {
    const lineFontSize = t.fontSize * line.sizeScale;
    const lineH = lineFontSize * LINE_HEIGHT_RATIO;
    const text = line.runs.map((r) => r.text).join("");
    if (!text.trim()) { yWorld += lineH; continue; }

    const wWorld = Math.min(t.width && t.width > 0 ? t.width : Infinity, measure(text, lineFontSize));
    const a = map(t.position.x, yWorld);
    const b = map(t.position.x + wWorld, yWorld + lineFontSize);
    const wRail = Math.max(MIN_BAR_W_PX, b.x - a.x);

    if (line.sizeScale > 1) {
      // Heading — paint it. maxWidth condenses rather than overflowing,
      // which is what keeps a floored size inside the block it belongs to.
      const size = Math.max(MIN_HEADING_PX, lineFontSize * scale);
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = theme.headingColor || resolved;
      ctx.font = `600 ${size}px ${ff}`;
      ctx.fillText(text, a.x, a.y, wRail);
    } else {
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = resolved;
      ctx.fillRect(a.x, a.y, wRail, Math.max(MIN_BAR_H_PX, b.y - a.y));
    }
    yWorld += lineH;
  }
  ctx.globalAlpha = 1;
}
