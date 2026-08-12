/**
 * Split / Grab chrome. Pure like the rest of `renderer*.ts` — it takes a
 * context plus data and touches nothing global.
 *
 * Everything here is painted in SCREEN space, after the camera transform
 * has been restored, even though the geometry is world-space. Split
 * lines are conceptually infinite, so there is no world rect to clip
 * them to; instead each line's two endpoints are projected through
 * `canvasToScreen` (which carries canvas rotation) and stroked at a
 * fixed pixel width. That keeps dash lengths, line weights, handle sizes
 * and the action buttons constant on screen at every zoom — a 1.5 px
 * dashed rule stays a 1.5 px dashed rule at 25 % zoom, where a
 * world-space stroke would vanish.
 */

import type { Axis, Camera, GrabSession, Split } from "./types";
import type { CanvasTheme } from "./themes";
import { canvasToScreen, screenToCanvas } from "./utils";
import {
  type SplitAction, type SplitActionRect,
  SPLIT_ACTION_LABELS, drawnLinePositions, splitActionRects,
} from "./splits";

const SPLIT_COLOR = "#f97316";  // orange — a cut
const GRAB_COLOR = "#2563eb";   // blue — a lift
const GRAB_FILL = "rgba(37, 99, 235, 0.10)";
const UI_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export interface SplitRenderState {
  splits: Split[];
  grab: GrabSession | null;
  splitPreview: { orientation: Axis; pos: number } | null;
  splitHover: { splitId: string; line: "a" | "b"; anchor: number; lineScreen: number; active: SplitAction | null } | null;
  /** True while a grab band is being swept or its handles dragged —
   *  suppresses the edge handles so they don't chase the sweep. */
  grabBandDragging: boolean;
  /** The grab tool is the active tool, so the preview rule is drawn as
   *  the solid blue sweep line rather than the split's dashed cut. */
  grabToolActive: boolean;
}

/**
 * World extent the line has to span to cross the whole viewport, along
 * the split's OWN axis (x for a horizontal split). Derived from the four
 * screen corners so a rotated camera still gets a line that reaches both
 * edges, then padded so the ends are never visible.
 */
function worldSpanAlong(orientation: Axis, camera: Camera, w: number, h: number): { lo: number; hi: number } {
  let lo = Infinity, hi = -Infinity;
  for (const [sx, sy] of [[0, 0], [w, 0], [0, h], [w, h]] as const) {
    const p = screenToCanvas({ x: sx, y: sy }, camera);
    const v = orientation === "horizontal" ? p.x : p.y;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const pad = (hi - lo) * 0.1 + 10;
  return { lo: lo - pad, hi: hi + pad };
}

/** Project a cross-axis world position into the two screen endpoints of
 *  its full-width line. */
function lineEndpoints(orientation: Axis, pos: number, span: { lo: number; hi: number }, camera: Camera) {
  const a = orientation === "horizontal" ? { x: span.lo, y: pos } : { x: pos, y: span.lo };
  const b = orientation === "horizontal" ? { x: span.hi, y: pos } : { x: pos, y: span.hi };
  return [canvasToScreen(a, camera), canvasToScreen(b, camera)] as const;
}

function strokeLine(
  ctx: CanvasRenderingContext2D, orientation: Axis, pos: number,
  span: { lo: number; hi: number }, camera: Camera,
  color: string, width: number, dash: number[],
) {
  const [p0, p1] = lineEndpoints(orientation, pos, span, camera);
  ctx.save();
  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.stroke();
  ctx.restore();
}

/** Fill the quad between two cross-axis positions. */
function fillBand(
  ctx: CanvasRenderingContext2D, orientation: Axis, lo: number, hi: number,
  span: { lo: number; hi: number }, camera: Camera, fill: string,
) {
  const [a0, a1] = lineEndpoints(orientation, lo, span, camera);
  const [b0, b1] = lineEndpoints(orientation, hi, span, camera);
  ctx.save();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(a0.x, a0.y);
  ctx.lineTo(a1.x, a1.y);
  ctx.lineTo(b1.x, b1.y);
  ctx.lineTo(b0.x, b0.y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Paint every split, the live grab, and whichever preview line the
 * active tool is offering. Called once per frame with the camera
 * transform already restored.
 */
export function drawSplitChrome(
  ctx: CanvasRenderingContext2D,
  state: SplitRenderState,
  camera: Camera,
  w: number,
  h: number,
  theme: CanvasTheme,
) {
  // Nothing to paint is the overwhelmingly common case (every notebook
  // that has never been split), and the span maths below is eight
  // screen→world projections. Bail before paying for them.
  if (!state.splits.length && !state.grab && !state.splitPreview && !state.splitHover) return;

  const spanH = worldSpanAlong("horizontal", camera, w, h);
  const spanV = worldSpanAlong("vertical", camera, w, h);
  const spanFor = (o: Axis) => (o === "horizontal" ? spanH : spanV);

  for (const split of state.splits) {
    const drawn = drawnLinePositions(split, camera.zoom);
    const span = spanFor(split.orientation);
    // The gap between an opened split's lines gets a whisper of tint so
    // the space the drag made reads as part of the split rather than as
    // ordinary empty canvas.
    if (split.b - split.a > 0) {
      fillBand(ctx, split.orientation, split.a, split.b, span, camera, "rgba(249, 115, 22, 0.05)");
    }
    const hovered = state.splitHover?.splitId === split.id ? state.splitHover.line : null;
    strokeLine(ctx, split.orientation, drawn.a, span, camera, SPLIT_COLOR, hovered === "a" ? 2.5 : 1.5, [6, 4]);
    strokeLine(ctx, split.orientation, drawn.b, span, camera, SPLIT_COLOR, hovered === "b" ? 2.5 : 1.5, [6, 4]);
  }

  const g = state.grab;
  if (g && g.stage === "band") {
    const span = spanFor(g.orientation);
    fillBand(ctx, g.orientation, g.a, g.b, span, camera, GRAB_FILL);
    strokeLine(ctx, g.orientation, g.a, span, camera, GRAB_COLOR, 1, []);
    strokeLine(ctx, g.orientation, g.b, span, camera, GRAB_COLOR, 1, []);
    if (!state.grabBandDragging) drawBandHandles(ctx, g, span, camera);
  }

  const preview = state.splitPreview;
  if (g && g.stage === "place") {
    if (preview) drawPlaceBar(ctx, preview.orientation, preview.pos, spanFor(preview.orientation), camera);
  } else if (preview && !g) {
    // Split tool: the dashed orange rule it would cut. Grab tool: the
    // solid blue rule it would sweep from.
    const isGrabTool = state.grabToolActive;
    strokeLine(
      ctx, preview.orientation, preview.pos, spanFor(preview.orientation), camera,
      isGrabTool ? GRAB_COLOR : SPLIT_COLOR, isGrabTool ? 2 : 1.5, isGrabTool ? [] : [6, 4],
    );
  }

  if (state.splitHover) drawActionCluster(ctx, state, theme);
}

/** Round grips at the middle of each band edge, so the edges read as
 *  adjustable before the user discovers they can drag them. */
function drawBandHandles(
  ctx: CanvasRenderingContext2D, g: GrabSession,
  span: { lo: number; hi: number }, camera: Camera,
) {
  const mid = (span.lo + span.hi) / 2;
  for (const pos of [g.a, g.b]) {
    const p = canvasToScreen(
      g.orientation === "horizontal" ? { x: mid, y: pos } : { x: pos, y: mid },
      camera,
    );
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = GRAB_COLOR;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

/** The place-stage bar: thick, unmistakable, and labelled, because it is
 *  the only thing standing between the user and their buffered content. */
function drawPlaceBar(
  ctx: CanvasRenderingContext2D, orientation: Axis, pos: number,
  span: { lo: number; hi: number }, camera: Camera,
) {
  strokeLine(ctx, orientation, pos, span, camera, GRAB_COLOR, 6, []);
  const mid = (span.lo + span.hi) / 2;
  const p = canvasToScreen(
    orientation === "horizontal" ? { x: mid, y: pos } : { x: pos, y: mid },
    camera,
  );
  const label = "PLACE CONTENT";
  ctx.save();
  ctx.font = `600 11px ${UI_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(label).width;
  const boxW = tw + 16, boxH = 20;
  const bx = p.x - boxW / 2;
  const by = orientation === "horizontal" ? p.y - boxH - 8 : p.y - boxH / 2;
  ctx.fillStyle = GRAB_COLOR;
  roundRect(ctx, bx, by, boxW, boxH, 4);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, bx + boxW / 2, by + boxH / 2 + 0.5);
  ctx.restore();
}

// ───────────────────────── action cluster ─────────────────────────

function drawActionCluster(ctx: CanvasRenderingContext2D, state: SplitRenderState, theme: CanvasTheme) {
  const hv = state.splitHover!;
  const split = state.splits.find((s) => s.id === hv.splitId);
  if (!split) return;
  const rects = splitActionRects(split.orientation, hv.line, hv.lineScreen, hv.anchor);

  ctx.save();
  for (const r of rects) {
    const active = hv.active === r.action;
    ctx.fillStyle = active ? SPLIT_COLOR : theme.uiBackground;
    ctx.strokeStyle = active ? SPLIT_COLOR : theme.uiBorder;
    ctx.lineWidth = 1;
    roundRect(ctx, r.x, r.y, r.w, r.h, 6);
    ctx.fill();
    ctx.stroke();
    drawActionGlyph(ctx, r, active ? "#ffffff" : theme.foreground);
  }
  if (hv.active) drawActionLabel(ctx, rects, hv.active, split.orientation, hv.line, theme);
  ctx.restore();
}

function drawActionGlyph(ctx: CanvasRenderingContext2D, r: SplitActionRect, color: string) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (r.action === "clear") {
    // An emptied frame — the box with its contents struck out.
    ctx.rect(cx - 5, cy - 5, 10, 10);
    ctx.moveTo(cx - 5, cy + 5);
    ctx.lineTo(cx + 5, cy - 5);
  } else if (r.action === "grab") {
    // Two arrows closing on a centre line: lift this band out and pull
    // the sides together.
    ctx.moveTo(cx - 7, cy); ctx.lineTo(cx - 1, cy);
    ctx.moveTo(cx - 3.5, cy - 2.5); ctx.lineTo(cx - 1, cy); ctx.lineTo(cx - 3.5, cy + 2.5);
    ctx.moveTo(cx + 7, cy); ctx.lineTo(cx + 1, cy);
    ctx.moveTo(cx + 3.5, cy - 2.5); ctx.lineTo(cx + 1, cy); ctx.lineTo(cx + 3.5, cy + 2.5);
    ctx.moveTo(cx - 6, cy - 5.5); ctx.lineTo(cx + 6, cy - 5.5);
    ctx.moveTo(cx - 6, cy + 5.5); ctx.lineTo(cx + 6, cy + 5.5);
  } else {
    ctx.moveTo(cx - 5, cy - 5); ctx.lineTo(cx + 5, cy + 5);
    ctx.moveTo(cx + 5, cy - 5); ctx.lineTo(cx - 5, cy + 5);
  }
  ctx.stroke();
  ctx.restore();
}

/** Name the hovered button. Canvas chrome has no title attribute to fall
 *  back on, and three unlabelled glyphs on a line the user has never met
 *  before is a guessing game. */
function drawActionLabel(
  ctx: CanvasRenderingContext2D, rects: SplitActionRect[], action: SplitAction,
  orientation: Axis, line: "a" | "b", theme: CanvasTheme,
) {
  const r = rects.find((x) => x.action === action);
  if (!r) return;
  const text = SPLIT_ACTION_LABELS[action];
  ctx.save();
  ctx.font = `11px ${UI_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(text).width;
  const boxW = tw + 12, boxH = 18;
  // Away from the split, on the same side the cluster sits.
  const cx = orientation === "horizontal" ? rects[1].x + rects[1].w / 2 : r.x + r.w / 2;
  let bx: number, by: number;
  if (orientation === "horizontal") {
    bx = cx - boxW / 2;
    by = line === "a" ? r.y - boxH - 4 : r.y + r.h + 4;
  } else {
    bx = line === "a" ? r.x - boxW - 4 : r.x + r.w + 4;
    by = r.y + r.h / 2 - boxH / 2;
  }
  ctx.fillStyle = theme.uiBackground;
  ctx.strokeStyle = theme.uiBorder;
  ctx.lineWidth = 1;
  roundRect(ctx, bx, by, boxW, boxH, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = theme.foreground;
  ctx.fillText(text, bx + boxW / 2, by + boxH / 2 + 0.5);
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
