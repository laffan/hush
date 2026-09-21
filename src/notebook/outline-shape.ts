/**
 * Outlines on a canvas — layout, hit-testing, and the pinned frame.
 *
 * An outline is an ordinary `TextShape` whose `outline` flag is set: its
 * `text` is a nested markdown checklist, exactly the bytes a Doc would
 * hold, which is what lets the same outline be dragged between the two
 * surfaces without a conversion step. Making it a flag rather than a new
 * member of the `Shape` union is deliberate — bounds, hit-testing,
 * grouping, layers, the pocket, the shelf, the clipboard and both
 * codecs already handle text shapes, and a new type would have had to be
 * taught to every one of them to earn a different border.
 *
 * This module owns the geometry only. `renderer.ts` paints from the
 * layout it returns (and delegates each item's own text back to
 * `drawTextShape`, so inline markdown, links and wrapping behave exactly
 * as they do in any other text shape); `state.ts` hit-tests against it.
 * Everything here is measured relative to `shape.position`, which for an
 * outline is the top-left of the **border box** rather than of the first
 * glyph — the frame is the object.
 */

import { FONT_FAMILY, LINE_HEIGHT_RATIO } from "./types";
import type { Point, TextShape } from "./types";
import { parseText } from "./markdown";
import { firstOpenIndex, parseOutlineLine } from "../outline/outline-model";
import type { OutlineItem } from "../outline/outline-model";

/** How much smaller than the shape's own size an outline sets. */
export const OUTLINE_FONT_DROP = 2;
/**
 * The line height an outline row sits on, as a multiple of its font
 * size — the same number `--outline-line-height` gives the Doc, less the
 * 2px the Doc adds on top of it (see styles/outline.css). The two
 * surfaces are one outline seen twice, and a row that reads tighter on a
 * canvas than in a document is the seam showing.
 *
 * The canvas lays text out on `LINE_HEIGHT_RATIO`, so the difference is
 * added as **leading**: half above each row's text and half below, which
 * is what a CSS line-height does. Keeping it as one subtraction means
 * moving either end can't leave the two drifting apart again.
 */
export const OUTLINE_LINE_HEIGHT = 1.6;
const ROW_LEAD_RATIO = Math.max(0, OUTLINE_LINE_HEIGHT - LINE_HEIGHT_RATIO);
/** Inner padding between the border and the items. */
export const OUTLINE_PAD = 10;
export const OUTLINE_RADIUS = 6;
/** Step per nesting level. */
export const OUTLINE_INDENT = 16;
/** Footer strip height, and the box each of its icons is drawn in. */
export const OUTLINE_FOOTER_H = 22;
export const OUTLINE_ICON = 14;
/** Fallback width for an outline that has never been resized. */
export const OUTLINE_DEFAULT_WIDTH = 320;
/** Margin between a pinned outline and the edges of its frame. */
export const OUTLINE_PIN_MARGIN = 14;

export type OutlineButtonId = "hideDone" | "pin";

export interface OutlineRow {
  /** Index of this item's line in `shape.text`. */
  line: number;
  depth: number;
  checked: boolean;
  /** The item's text with its `- [ ] ` prefix removed. */
  text: string;
  /** True for the first unfinished item — the one painted in the
   *  theme's heading colour and bold. */
  next: boolean;
  /** Row box, relative to `shape.position`. */
  y: number;
  height: number;
  /** Where the item's text starts inside the row — half the row's
   *  leading. Everything that lines up with the words (the checkbox, the
   *  strike) is placed from here, not from `y`. */
  textTop: number;
  boxX: number;
  textX: number;
  textWidth: number;
  /** One entry per wrapped line of the item, relative to the row's own
   *  `y`. The strikethrough on a completed item is drawn from these:
   *  an item that wrapped is still one item, so the rule has to cross
   *  every line of it rather than just the first. */
  lines: { y: number; height: number; width: number }[];
}

export interface OutlineButton {
  id: OutlineButtonId;
  x: number; y: number; w: number; h: number;
  active: boolean;
}

export interface OutlineLayout {
  fontSize: number;
  boxSize: number;
  width: number;
  /** Full height including the footer. */
  height: number;
  footerY: number;
  rows: OutlineRow[];
  buttons: OutlineButton[];
}

/** True when this shape is an outline rather than ordinary text. */
export function isOutlineShape(shape: { type: string; outline?: boolean }): boolean {
  return shape.type === "text" && !!shape.outline;
}

/** Parse the shape's text into checklist items. Lines that aren't
 *  checklist items are dropped: "every item in an outline is a checklist
 *  item" is the format, and a stray line has nowhere to render. */
export function outlineItems(text: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const item = parseOutlineLine(lines[i], i);
    if (item) out.push(item);
  }
  return out;
}

// Its own offscreen context rather than `utils.getMeasureCtx`: utils
// calls into this module for an outline's bounds, and taking the
// measurer back from it would close a module cycle through the file
// nearly every canvas module imports.
let _ctx: CanvasRenderingContext2D | null = null;
function measureCtx(): CanvasRenderingContext2D {
  if (!_ctx) _ctx = document.createElement("canvas").getContext("2d")!;
  return _ctx;
}

function measureWith(ff: string) {
  return (t: string, fs: number): number => {
    const c = measureCtx();
    c.font = `${fs}px ${ff}`;
    return c.measureText(t).width;
  };
}

/** The font stack an outline sets in: the app's UI face, never the
 *  canvas's or the shape's. An outline is chrome for the document, and
 *  reading as chrome is the point of it. */
export const OUTLINE_FONT_FAMILY = FONT_FAMILY;

/**
 * Measure an outline. Every coordinate is relative to `shape.position`.
 */
export function outlineLayout(shape: TextShape): OutlineLayout {
  const fontSize = Math.max(9, shape.fontSize - OUTLINE_FONT_DROP);
  const boxSize = fontSize * 0.85;
  const boxGap = fontSize * 0.45;
  const width = shape.width && shape.width > 0 ? shape.width : OUTLINE_DEFAULT_WIDTH;
  const measure = measureWith(OUTLINE_FONT_FAMILY);

  const items = outlineItems(shape.text);
  const nextIdx = firstOpenIndex(items);
  const hideDone = !!shape.outlineHideDone;
  const baseDepth = items.reduce((m, it) => Math.min(m, it.depth), Infinity);
  const rows: OutlineRow[] = [];

  const rowLead = fontSize * ROW_LEAD_RATIO;
  let y = OUTLINE_PAD;
  items.forEach((item, i) => {
    if (hideDone && item.checked) return;
    const depth = Math.max(0, item.depth - (isFinite(baseDepth) ? baseDepth : 0));
    const boxX = OUTLINE_PAD + depth * OUTLINE_INDENT;
    const textX = boxX + boxSize + boxGap;
    // Never let a deeply nested item wrap to nothing: past a point the
    // indent has eaten the column, and a one-character-wide item is
    // less readable than one that reaches into the margin.
    const textWidth = Math.max(fontSize * 4, width - OUTLINE_PAD - textX);
    const parsed = parseText(item.text, textWidth, fontSize, measure);
    const lines: { y: number; height: number; width: number }[] = [];
    let height = 0;
    for (const line of parsed) {
      const lineFontSize = fontSize * line.sizeScale;
      const lineH = lineFontSize * LINE_HEIGHT_RATIO;
      lines.push({
        y: height,
        height: lineH,
        width: measure(line.runs.map((r) => r.text).join(""), lineFontSize),
      });
      height += lineH;
    }
    const rowH = Math.max(height, fontSize * LINE_HEIGHT_RATIO) + rowLead;
    rows.push({
      line: item.line, depth: item.depth, checked: item.checked, text: item.text,
      next: i === nextIdx, y, height: rowH, textTop: rowLead / 2,
      boxX, textX, textWidth, lines,
    });
    y += rowH;
  });

  // An outline with nothing on show still owes the user its footer —
  // that is where the toggle that put the items away lives.
  const bodyEnd = rows.length ? y : OUTLINE_PAD + fontSize * LINE_HEIGHT_RATIO * 0.4;
  const footerY = bodyEnd + 4;
  const height = footerY + OUTLINE_FOOTER_H;

  const btnW = OUTLINE_ICON + 8;
  const btnY = footerY + (OUTLINE_FOOTER_H - (OUTLINE_ICON + 6)) / 2;
  const buttons: OutlineButton[] = [
    { id: "hideDone", x: width - OUTLINE_PAD - btnW * 2 - 4, y: btnY, w: btnW, h: OUTLINE_ICON + 6, active: hideDone },
    { id: "pin", x: width - OUTLINE_PAD - btnW, y: btnY, w: btnW, h: OUTLINE_ICON + 6, active: !!shape.outlinePin },
  ];

  return { fontSize, boxSize, width, height, footerY, rows, buttons };
}

/** The outline's bounding box in world (or, for a pinned outline, frame)
 *  coordinates. Feeds `getShapeBounds`, so selection chrome, resize
 *  handles, marquee selection and the flowchart's anchoring all see the
 *  frame rather than the raw glyph extents. */
export function outlineBounds(shape: TextShape) {
  const layout = outlineLayout(shape);
  return {
    minX: shape.position.x,
    minY: shape.position.y,
    maxX: shape.position.x + layout.width,
    maxY: shape.position.y + layout.height,
  };
}

/** Which footer button, if any, sits under a point given relative to
 *  `shape.position`. */
export function hitTestOutlineButton(local: Point, layout: OutlineLayout): OutlineButtonId | null {
  for (const b of layout.buttons) {
    if (local.x >= b.x - 2 && local.x <= b.x + b.w + 2 && local.y >= b.y - 3 && local.y <= b.y + b.h + 3) {
      return b.id;
    }
  }
  return null;
}

/** The source line index of the checkbox under a point given relative to
 *  `shape.position`, or null. The hit zone runs from the box to the
 *  start of the text so a tap near it still lands — a 10 px square is
 *  not a touch target. */
export function hitTestOutlineCheckbox(local: Point, layout: OutlineLayout): number | null {
  for (const row of layout.rows) {
    if (local.y < row.y || local.y > row.y + row.height) continue;
    if (local.x >= row.boxX - 4 && local.x <= row.textX) return row.line;
    return null;
  }
  return null;
}

/**
 * Where a pinned outline draws, in the canvas element's own pixels: the
 * bottom-left of the frame, clear of the left inset the sidebar / dock
 * claims. It is drawn at 1:1 whatever the zoom — it is chrome bolted to
 * the frame, not content on the canvas — and it is deliberately the
 * corner nothing else parks in (the shelf, the pocket tray and the page
 * rail all hold the right edge).
 */
export function outlinePinnedOrigin(
  layout: OutlineLayout,
  canvasW: number,
  canvasH: number,
  insets: { left?: number; right?: number; bottom?: number } = {},
): Point {
  const left = insets.left || 0;
  const right = insets.right || 0;
  const bottom = insets.bottom || 0;
  const maxX = Math.max(left + OUTLINE_PIN_MARGIN, canvasW - right - OUTLINE_PIN_MARGIN - layout.width);
  return {
    x: Math.min(left + OUTLINE_PIN_MARGIN, maxX),
    y: Math.max(OUTLINE_PIN_MARGIN, canvasH - bottom - OUTLINE_PIN_MARGIN - layout.height),
  };
}
