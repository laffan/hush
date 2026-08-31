/* src/notebook/drawing/brush-runtime.ts
 *
 * Brush-runtime helpers extracted from drawing-layer.ts so that file
 * stays under the 700-line cap. Each helper closes over engine
 * primitives so the caller can pass `themeRef` + `strokeEngine`
 * freshly each invocation.
 */

import type { CanvasTheme } from "../themes";
import type { DrawingSlot } from "../types";
import type { EngineStroke } from "./sync-shim";

interface ThemeRef {
  canvasBackground?: string;
  foreground?: string;
  headingColor?: string;
  accent?: string;
}

interface StrokeEngineLike {
  setBrush(id: string): void;
  setColor(c: string): void;
  setColorAutoSource(source: "auto" | "heading" | null): void;
  setSize(n: number): void;
  setMode(m: "normal" | "highlighter"): void;
  setStreamline(v: number): void;
  setSpacing(v: number): void;
  setStraightLine(on: boolean): void;
  renderBrushSwatch(
    brushId: string, color: string, ctx: CanvasRenderingContext2D,
    x: number, y: number, size: number, mode?: string,
  ): void;
  getStrokes(): EngineStroke[];
  fullRebake(): void;
}

/** Resolve a brush slot's stored colour value into a concrete hex.
 *  `"auto"` and `"heading"` are sentinels that track the active
 *  theme's foreground / heading colour respectively. */
export function resolveSlotColor(
  slotColor: string,
  theme: ThemeRef,
): string {
  if (slotColor === "auto") return theme.foreground || "#111111";
  if (slotColor === "heading") return theme.headingColor || theme.foreground || "#111111";
  return slotColor;
}

function autoSourceOf(slotColor: string): "auto" | "heading" | null {
  if (slotColor === "auto") return "auto";
  if (slotColor === "heading") return "heading";
  return null;
}

export function applySlotToEngine(
  strokeEngine: StrokeEngineLike,
  themeRef: ThemeRef,
  slot: DrawingSlot,
): void {
  strokeEngine.setBrush(slot.brushId);
  strokeEngine.setColor(resolveSlotColor(slot.color, themeRef));
  strokeEngine.setColorAutoSource(autoSourceOf(slot.color));
  strokeEngine.setSize(slot.size);
  strokeEngine.setMode(slot.mode);
  strokeEngine.setStreamline(slot.streamline);
  strokeEngine.setSpacing(slot.spacing);
  strokeEngine.setStraightLine(!!slot.straightLine);
}

export function renderSwatchToCanvas(
  strokeEngine: StrokeEngineLike,
  themeRef: ThemeRef,
  canvas: HTMLCanvasElement,
  slot: DrawingSlot,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  const dpr = window.devicePixelRatio || 1;
  const wantW = Math.round(cssW * dpr);
  const wantH = Math.round(cssH * dpr);
  if (canvas.width !== wantW || canvas.height !== wantH) {
    canvas.width = wantW;
    canvas.height = wantH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const color = resolveSlotColor(slot.color, themeRef);
  const size = Math.min(cssW, cssH);
  strokeEngine.renderBrushSwatch(slot.brushId, color, ctx, cssW / 2, cssH / 2, size, slot.mode);
}

/** Walk a horizontal stroke from the canvas's left edge to its right
 *  edge, stamping the slot's brush at the slot's own size and spacing
 *  so the user sees thickness, color, and spacing at a glance. The
 *  brush flyout uses this in place of a static section header. */
export function renderDemoStrokeToCanvas(
  strokeEngine: StrokeEngineLike,
  themeRef: ThemeRef,
  canvas: HTMLCanvasElement,
  slot: DrawingSlot,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  const dpr = window.devicePixelRatio || 1;
  const wantW = Math.round(cssW * dpr);
  const wantH = Math.round(cssH * dpr);
  if (canvas.width !== wantW || canvas.height !== wantH) {
    canvas.width = wantW;
    canvas.height = wantH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const color = resolveSlotColor(slot.color, themeRef);
  // Cap the stamp size so even a 48-px slot doesn't overflow the
  // demo canvas vertically — leave a 2-px breath above and below.
  const stampSize = Math.min(slot.size, cssH - 2);
  if (stampSize <= 0) return;
  // Stride between stamps. The engine's stroke pipeline spaces stamps
  // at `spacing * size`; mirror that here so what the user sees is
  // what they'll draw. Floor to 1 px so dense brushes still march
  // forward.
  const stride = Math.max(1, slot.spacing * slot.size);
  const y = cssH / 2;
  const x0 = stampSize / 2;
  const x1 = cssW - stampSize / 2;
  for (let x = x0; x <= x1; x += stride) {
    strokeEngine.renderBrushSwatch(slot.brushId, color, ctx, x, y, stampSize, slot.mode);
  }
}

/** Update themeRef in place and retint any existing auto-colored
 *  strokes so theme switches are visible immediately. Returns true
 *  when at least one stroke was retinted (the caller rebakes). */
export function applyThemeAndRetint(
  strokeEngine: StrokeEngineLike,
  themeRef: ThemeRef,
  next: CanvasTheme,
): boolean {
  const fgChanged = next.foreground !== themeRef.foreground;
  const headingChanged = next.headingColor !== themeRef.headingColor;
  themeRef.canvasBackground = next.canvasBackground;
  themeRef.foreground = next.foreground;
  themeRef.headingColor = next.headingColor;
  themeRef.accent = next.accent;
  if (!fgChanged && !headingChanged) return false;
  let touched = false;
  for (const s of strokeEngine.getStrokes()) {
    if (s.colorIsHeading && headingChanged) {
      s.color = next.headingColor;
      touched = true;
    } else if (s.colorIsAuto && fgChanged) {
      s.color = next.foreground;
      touched = true;
    }
  }
  if (touched) strokeEngine.fullRebake();
  return touched;
}
