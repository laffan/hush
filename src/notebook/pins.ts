/**
 * Pins — named, coloured points in a proofread notebook that a Doc can
 * link to: `hush-pin://<notebookFileId>/<pinId>`, the same shape as the
 * PDF viewer's `hush-pdf://<fileId>/<bookmarkId>` clip links, and routed
 * the same way (link-decorator in a Doc, `openExternalUrl` on a canvas,
 * a `window.__hush*` hook into the app — see `pdf/pin-links.js`).
 *
 * Why not the PDF's own clip bookmarks: those live on the PDF registry
 * entry at page fractions, and a proof is made to be cut open — Splits
 * and Grabs move everything after a cut, so a point measured on the
 * original page stops pointing at the paragraph it was dropped on. A pin
 * is canvas content instead, so it travels with the text around it.
 * What they share is everything else: the palette, the dot, the name,
 * the link format, the cmd-click routing — and a proof made from a PDF
 * that already has clips starts with those clips as pins
 * (`pdf-proofread.js`).
 *
 * A pin is a `TextShape` with `pin: true` (its `text` is the name, its
 * `color` the pin's), for the reason outlines are: text already has
 * bounds, hit-testing, selection, layers, grouping, undo, both codecs
 * and the clipboard, and a split moves a text shape whole. The pin id
 * is the shape id, so a pasted copy is a new pin and an undo keeps the
 * link. The dot is drawn beside the label (`drawPinDot`).
 */

import type { DrawingState } from "./state";
import type { Point, Shape, TextShape } from "./types";
import { LINE_HEIGHT_RATIO, PIN_GAP, PIN_RADIUS } from "./types";
import { canvasToScreen, generateId } from "./utils";
import { pinMarkdownLink } from "./pin-link";

export { PIN_SCHEME, pinUrl, parsePinUrl, pinMarkdownLink } from "./pin-link";

/** The PDF bookmark palette's first swatch, so the two read as kin. */
export const PIN_COLOR = "#ef5350";

export function isPin(s: Shape | null | undefined): s is TextShape {
  return !!s && s.type === "text" && !!s.pin;
}

/** Where a pin's dot sits — left of the label, centred on its first line. */
export function pinDotCenter(s: TextShape): Point {
  return {
    x: s.position.x - PIN_GAP - PIN_RADIUS,
    y: s.position.y + (s.fontSize * LINE_HEIGHT_RATIO) / 2,
  };
}

/** A new pin's shape, its dot at `at`. */
export function makePin(at: Point, opts: { name: string; color?: string; fontSize: number; layerId?: string }): TextShape {
  return {
    id: generateId(),
    type: "text",
    pin: true,
    position: { x: at.x + PIN_GAP + PIN_RADIUS, y: at.y - (opts.fontSize * LINE_HEIGHT_RATIO) / 2 },
    text: opts.name,
    fontSize: opts.fontSize,
    color: opts.color || PIN_COLOR,
    bold: true,
    layerId: opts.layerId,
    createdAt: Date.now(),
  } as TextShape;
}

/** The clipboard text for a selection made only of pins — one link per
 *  line — or null when the selection holds anything else (then the
 *  ordinary shape envelope is what gets copied). */
export function pinClipboardText(state: DrawingState): string | null {
  const fileId = state.hostFileId;
  if (!fileId || state.selectedIds.size === 0) return null;
  const sel = state.shapes.filter((s) => state.selectedIds.has(s.id));
  if (!sel.length || !sel.every(isPin)) return null;
  return sel.map((p) => pinMarkdownLink(fileId, p)).join("\n");
}

/** Drop a pin at `at` (the Pin tool), select it and open its name for
 *  editing. The tool hands back to Select — pins go down one at a time. */
export function placePin(state: DrawingState, at: Point): void {
  const n = state.shapes.filter(isPin).length + 1;
  const pin = makePin(at, { name: `Pin ${n}`, fontSize: state.fontSize, layerId: state.activeLayerId });
  state.shapes = [...state.shapes, pin];
  state.selectedIds = new Set([pin.id]);
  state.tool = "select";
  state.recordHistory();
  state.notify("shapes");
  state.notify("selectedIds");
  state.notify("tool");
  state.startEditingExistingText(pin);
}

/** Bring a pin to the middle of the visible canvas and select it — the
 *  far end of a `hush-pin://` link. Returns false for an unknown id. */
export function focusPin(state: DrawingState, pinId: string): boolean {
  const pin = state.shapes.find((s) => s.id === pinId);
  if (!isPin(pin)) return false;
  const target = canvasToScreen(pinDotCenter(pin), state.camera);
  const center = state.visibleScreenCenter();
  state.camera = { ...state.camera, x: state.camera.x + center.x - target.x, y: state.camera.y + center.y - target.y };
  state.selectedIds = new Set([pin.id]);
  state.notify("camera");
  state.notify("selectedIds");
  return true;
}

/** The dot. Drawn after the label so it sits on top of anything the
 *  label's background paints. */
export function drawPinDot(ctx: CanvasRenderingContext2D, pin: TextShape, fg: string, bg: string): void {
  const c = pinDotCenter(pin);
  const color = pin.color === "auto" || pin.color === "#000000" ? fg : pin.color;
  ctx.save();
  ctx.beginPath();
  ctx.arc(c.x, c.y, PIN_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = bg;
  ctx.stroke();
  ctx.restore();
}
