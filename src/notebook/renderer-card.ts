/**
 * Paint a card onto a 2D context. On screen a card is DOM (the card
 * layer draws the very component a Doc shows), so the live render pass
 * leaves cards out; this is for the paths that need pixels — PNG / JPG /
 * PDF export, rasterize, the pocket — and it paints the same box: the
 * tinted body, the header strip, the title when collapsed, and the text
 * through `drawTextShape`, so inline markdown renders exactly as it does
 * in any other text shape.
 */
import type { TextShape } from "./types";
import { FONT_FAMILY } from "./types";
import type { CanvasTheme } from "./themes";
import { cardBox } from "./card-geometry";
import { drawTextShape } from "./renderer";
import { cardTitle, cardWordCount, CARD_HEADER_HEIGHT, CARD_MAX_WORDS } from "../cards/card-model";

function parseHex(c: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec((c || "").trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((x) => x + x).join("") : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** `a` over `b` at weight `t` — the CSS `color-mix` the DOM card uses. */
function mix(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return b;
  const c = x.map((v, i) => Math.round(v * t + y[i] * (1 - t)));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
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

export function drawCardShape(
  ctx: CanvasRenderingContext2D, shape: TextShape, theme: CanvasTheme,
  omitGlyphs = false, flagColors?: Record<string, string>,
): void {
  const box = cardBox(shape);
  const base = theme.background;
  const fg = theme.foreground;
  const accent = typeof shape.cardMeta?.bgColor === "string" ? shape.cardMeta.bgColor : "";
  const over = cardWordCount(shape.text) > CARD_MAX_WORDS;
  // Matches styles/cards.css: the page's own background (a light wash of
  // a chosen colour), no header fill, a faint border.
  const bodyBg = over ? "#ff2d2d" : accent ? mix(accent, base, 0.14) : base;
  const headBg = over ? "#d90f0f" : bodyBg;
  const ink = over ? "#ffffff" : fg;

  ctx.save();
  roundRect(ctx, box.x, box.y, box.width, box.height, 6);
  ctx.fillStyle = bodyBg;
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = headBg;
  ctx.fillRect(box.x, box.y, box.width, CARD_HEADER_HEIGHT);
  if (shape.cardMeta?.collapsed && !omitGlyphs) {
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.8;
    ctx.font = `11px ${FONT_FAMILY}`;
    ctx.textBaseline = "middle";
    ctx.fillText(cardTitle(shape.text), box.x + 22, box.y + CARD_HEADER_HEIGHT / 2, box.width - 30);
    ctx.globalAlpha = 1;
  } else if (!shape.cardMeta?.collapsed) {
    drawTextShape(ctx, {
      ...shape,
      card: false,
      position: { x: box.x + 10, y: box.y + CARD_HEADER_HEIGHT },
      width: box.width - 20,
      manualWidth: true,
      fontSize: 14,
      fontFamily: FONT_FAMILY,
      color: over ? "#ffffff" : "auto",
      backgroundColor: undefined,
      borderColor: undefined,
    }, theme, FONT_FAMILY, omitGlyphs, flagColors);
  }
  ctx.restore();
  ctx.save();
  roundRect(ctx, box.x + 0.5, box.y + 0.5, box.width - 1, box.height - 1, 6);
  ctx.strokeStyle = over ? "#ff0000" : accent ? mix(accent, base, 0.4) : mix(fg, base, 0.1);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}
