/** Helper functions for state operations (split from state.ts for file size). */

/** Open a URL using Tauri's opener plugin (desktop) or window.open (web fallback). */
export async function openExternalUrl(url: string) {
  // PDF-bookmark deep links navigate inside the app. Routed through a
  // window hook (registered by pdf-bookmarks.js) so the canvas module
  // stays free of app-module imports — same pattern as wikilinks.
  if (url.startsWith("hush-pdf://")) {
    const hook = (window as unknown as { __hushOpenPdfBookmark?: (u: string) => void }).__hushOpenPdfBookmark;
    if (typeof hook === "function") { hook(url); return; }
  }
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openUrl(url);
  } catch {
    window.open(url, "_blank");
  }
}
import type { ImageShape, Point, SelectionBox, Shape, TextShape } from "./types";
import { FONT_FAMILY, LINE_HEIGHT_RATIO } from "./types";
import { computePocketLayout, getMeasureCtx, hitTestShape, pointInBounds } from "./utils";
import { parseLine, parseText } from "./markdown";
import type { ResizeHandle } from "./state";

export function findShapeAtPoint(pt: Point, shapes: Shape[], fontFamily?: string): Shape | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (shapes[i].type === "drag-area") continue;
    if (hitTestShape(pt, shapes[i], fontFamily)) return shapes[i];
  }
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (shapes[i].type === "drag-area" && hitTestShape(pt, shapes[i], fontFamily)) return shapes[i];
  }
  return null;
}

/** Hit-test a point against the markdown task checkbox glyphs inside a
 *  text shape. Returns the source-line index of the task line that
 *  was clicked, or null. Mirrors the renderer's per-line positioning
 *  math (see renderer.ts) so the hit zone tracks what the user sees. */
export function hitTestTaskCheckbox(
  pt: Point,
  shape: TextShape,
  fontFamily?: string,
): number | null {
  const fs = shape.fontSize;
  const ff = fontFamily || FONT_FAMILY;
  const measure = (t: string, s: number) => {
    const c = getMeasureCtx();
    c.font = `${s}px ${ff}`;
    return c.measureText(t).width;
  };
  const constraintWidth = shape.width && shape.width > 0 ? shape.width : undefined;
  const CHECKBOX_SIZE = fs * 0.85;
  const BLOCKQUOTE_GUTTER = fs * 0.9;
  const rawLines = shape.text.split("\n");
  let y = shape.position.y;
  for (let srcIdx = 0; srcIdx < rawLines.length; srcIdx++) {
    const srcParsed = parseLine(rawLines[srcIdx]);
    // Per-source-line wrap so we can advance y by the full wrapped
    // height while still mapping the click back to the source line.
    const wrapped = parseText(rawLines[srcIdx], constraintWidth, fs, measure);
    if (srcParsed.task) {
      const lineFontSize = fs * srcParsed.sizeScale;
      const cy = y + (lineFontSize - CHECKBOX_SIZE) / 2;
      let cx = shape.position.x;
      if (srcParsed.blockquote) cx += BLOCKQUOTE_GUTTER;
      // Small tolerance so the hit zone is comfortable on touch.
      const slack = 3;
      if (pt.x >= cx - slack && pt.x <= cx + CHECKBOX_SIZE + slack &&
          pt.y >= cy - slack && pt.y <= cy + CHECKBOX_SIZE + slack) {
        return srcIdx;
      }
    }
    for (const w of wrapped) y += fs * w.sizeScale * LINE_HEIGHT_RATIO;
  }
  return null;
}

/** Toggle the `[ ]` ↔ `[x]` state on a single source line. Returns the
 *  rewritten full text, or null if the line wasn't a task. */
export function toggleTaskLine(text: string, sourceLineIndex: number): string | null {
  const lines = text.split("\n");
  if (sourceLineIndex < 0 || sourceLineIndex >= lines.length) return null;
  const line = lines[sourceLineIndex];
  const m = line.match(/^(\s*[-*+]\s+)\[([ xX])\](\s+.*)$/);
  if (!m) return null;
  const next = m[2] === " " ? "x" : " ";
  lines[sourceLineIndex] = `${m[1]}[${next}]${m[3]}`;
  return lines.join("\n");
}

/** Hit-test a point against link runs in a text shape. Returns the link
 *  target (URL for `[…](url)` runs, title for `[[wikilink]]` runs) or
 *  null when no link sits under the point. Callers that need to
 *  distinguish kinds — e.g. routing a click to the URL opener vs the
 *  in-app wikilink resolver — should use {@link hitTestLinkRun}
 *  instead. The only consumers of this helper just need a yes/no on
 *  "was this click on a clickable link" so the cmd-drag pane-extract
 *  gesture stays out of the regular pointerdown handler's way. */
export function hitTestLink(pt: Point, shape: TextShape): string | null {
  const hit = hitTestLinkRun(pt, shape);
  return hit ? hit.target : null;
}

/** Hit-test a point against link runs in a text shape, distinguishing
 *  between regular markdown links (`[text](url)` → `kind: "url"`) and
 *  Obsidian-style wikilinks (`[[Title]]` → `kind: "wikilink"`). Callers
 *  that just want a yes/no can use {@link hitTestLink}. */
export function hitTestLinkRun(
  pt: Point,
  shape: TextShape,
): { kind: "url" | "wikilink"; target: string } | null {
  const fs = shape.fontSize;
  const measure = (t: string, s: number) => {
    const c = document.createElement("canvas").getContext("2d")!;
    c.font = `${s}px ${FONT_FAMILY}`;
    return c.measureText(t).width;
  };
  const lines = parseText(shape.text, shape.width && shape.width > 0 ? shape.width : undefined, fs, measure);
  let y = shape.position.y;
  for (const line of lines) {
    const lfs = fs * line.sizeScale;
    const lh = lfs * LINE_HEIGHT_RATIO;
    let x = shape.position.x;
    for (const run of line.runs) {
      const w = measure(run.text, lfs);
      if (pt.x >= x && pt.x <= x + w && pt.y >= y && pt.y <= y + lh) {
        if (run.wikilink) return { kind: "wikilink", target: run.wikilink };
        if (run.link) return { kind: "url", target: run.link };
      }
      x += w;
    }
    y += lh;
  }
  return null;
}

export function normalizeBox(box: SelectionBox) {
  return { minX: Math.min(box.start.x, box.end.x), minY: Math.min(box.start.y, box.end.y), maxX: Math.max(box.start.x, box.end.x), maxY: Math.max(box.start.y, box.end.y) };
}

export function moveShape(shape: Shape, dx: number, dy: number): Shape {
  switch (shape.type) {
    case "draw": return { ...shape, points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy, pressure: p.pressure, t: p.t })) };
    case "text": case "image": case "drag-area":
      return { ...shape, position: { x: shape.position.x + dx, y: shape.position.y + dy } };
  }
}

export function applyResize(origShape: Shape, handle: ResizeHandle, orig: { minX: number; minY: number; maxX: number; maxY: number }, dx: number, dy: number): Shape {
  let minX = orig.minX, minY = orig.minY, maxX = orig.maxX, maxY = orig.maxY;
  if (handle.includes("w")) minX += dx;
  if (handle.includes("e")) maxX += dx;
  if (handle.includes("n")) minY += dy;
  if (handle.includes("s")) maxY += dy;
  const MIN = 30;
  if (maxX - minX < MIN) { if (handle.includes("w")) minX = maxX - MIN; else maxX = minX + MIN; }
  if (maxY - minY < MIN) { if (handle.includes("n")) minY = maxY - MIN; else maxY = minY + MIN; }
  const newW = maxX - minX, newH = maxY - minY;
  switch (origShape.type) {
    case "text": return { ...origShape, position: { x: minX, y: minY }, width: Math.max(MIN, newW), manualWidth: true };
    case "image": {
      const origW = orig.maxX - orig.minX;
      const origH = orig.maxY - orig.minY;
      const aspect = origW / (origH || 1);
      if (handle === "n" || handle === "s") {
        const newW2 = newH * aspect;
        const cx = (minX + maxX) / 2;
        minX = cx - newW2 / 2;
        maxX = cx + newW2 / 2;
      } else if (handle === "e" || handle === "w") {
        const newH2 = newW / aspect;
        const cy = (minY + maxY) / 2;
        minY = cy - newH2 / 2;
        maxY = cy + newH2 / 2;
      } else {
        const scaleX = (maxX - minX) / origW;
        const scaleY = (maxY - minY) / origH;
        const scale = Math.max(scaleX, scaleY);
        const finalW = origW * scale;
        const finalH = origH * scale;
        if (handle.includes("e")) maxX = minX + finalW; else minX = maxX - finalW;
        if (handle.includes("s")) maxY = minY + finalH; else minY = maxY - finalH;
      }
      return { ...origShape, position: { x: minX, y: minY }, width: maxX - minX, height: maxY - minY };
    }
    case "drag-area": return { ...origShape, position: { x: minX, y: minY }, width: newW, height: newH };
    case "draw": {
      const ow = orig.maxX - orig.minX || 1, oh = orig.maxY - orig.minY || 1;
      return { ...origShape, points: origShape.points.map((p) => ({ x: minX + ((p.x - orig.minX) / ow) * newW, y: minY + ((p.y - orig.minY) / oh) * newH, pressure: p.pressure, t: p.t })) };
    }
  }
}

export function applyCropResize(origShape: ImageShape, handle: ResizeHandle, orig: { minX: number; minY: number; maxX: number; maxY: number }, dx: number, dy: number): ImageShape {
  let minX = orig.minX, minY = orig.minY, maxX = orig.maxX, maxY = orig.maxY;
  if (handle.includes("w")) minX += dx;
  if (handle.includes("e")) maxX += dx;
  if (handle.includes("n")) minY += dy;
  if (handle.includes("s")) maxY += dy;
  minX = Math.max(minX, orig.minX);
  minY = Math.max(minY, orig.minY);
  maxX = Math.min(maxX, orig.maxX);
  maxY = Math.min(maxY, orig.maxY);
  const MIN = 20;
  if (maxX - minX < MIN) { if (handle.includes("w")) minX = maxX - MIN; else maxX = minX + MIN; }
  if (maxY - minY < MIN) { if (handle.includes("n")) minY = maxY - MIN; else maxY = minY + MIN; }
  const origW = orig.maxX - orig.minX, origH = orig.maxY - orig.minY;
  const oldCrop = origShape.crop || { x: 0, y: 0, w: 1, h: 1 };
  const cropX = oldCrop.x + ((minX - orig.minX) / origW) * oldCrop.w;
  const cropY = oldCrop.y + ((minY - orig.minY) / origH) * oldCrop.h;
  const cropW = ((maxX - minX) / origW) * oldCrop.w;
  const cropH = ((maxY - minY) / origH) * oldCrop.h;
  return { ...origShape, position: { x: minX, y: minY }, width: maxX - minX, height: maxY - minY, crop: { x: cropX, y: cropY, w: cropW, h: cropH } };
}

/** Measure widest rendered line (accounting for heading scale, bold/italic + font) and return fitted width.
 *  Measures word-by-word + inter-word spaces the same way `wrapRuns` does during rendering,
 *  so the returned width is wide enough that the renderer won't wrap the text back onto a new line. */
export function autoFitWidth(text: string, fontSize: number, constraintWidth: number | undefined, fontFamily: string): number {
  const cw = constraintWidth || 350;
  const ff = `${fontFamily}, ${FONT_FAMILY}`;
  const ctx = getMeasureCtx();
  let maxW = 0;
  for (const line of text.split("\n")) {
    const parsed = parseLine(line);
    const lineFontSize = fontSize * parsed.sizeScale;
    // Mirror wrapRuns: split each run into words, measure each word
    // individually, and insert an explicit space width between consecutive
    // words. Canvas text metrics for a joined string can differ from the
    // sum of its word/space pieces — measuring the same way the wrapper
    // does keeps us safe from a fit-then-wrap mismatch.
    let lineW = 0;
    let hasPrevWord = false;
    for (const run of parsed.runs) {
      const weight = run.bold ? "bold" : "normal";
      const style = run.italic ? "italic" : "normal";
      ctx.font = `${style} ${weight} ${lineFontSize}px ${ff}`;
      const spaceW = ctx.measureText(" ").width;
      const parts = run.text.split(/( )/);
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part === "" || part === " ") continue;
        if (hasPrevWord) lineW += spaceW;
        lineW += ctx.measureText(part).width;
        hasPrevWord = true;
      }
    }
    maxW = Math.max(maxW, lineW);
  }
  // Round up and add a small safety pad so sub-pixel / hinting differences
  // between measure and render don't trigger a wrap.
  if (maxW >= cw) return cw;
  return Math.max(60, Math.ceil(maxW) + 4);
}

/** Hit-test screen point against pocketed shapes (rendered in screen space). Returns shape IDs if hit. */
export function findPocketedShapeAtScreen(screenPt: Point, shapes: Shape[], canvasWidth: number, fontFamily?: string, rightInset = 0): string[] | null {
  const layout = computePocketLayout(shapes, canvasWidth, fontFamily, rightInset);
  for (const entry of layout.entries) {
    if (pointInBounds(screenPt, entry.screenBounds, 6)) {
      return entry.shapes.map((s) => s.id);
    }
  }
  return null;
}
