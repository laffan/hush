/**
 * Vector-text PDF encoder for notebook export.
 *
 * Embeds a JPEG of the canvas (drawn with text glyphs *omitted*) as the
 * background and emits each text shape's runs as real PDF text so the
 * output is selectable, searchable, and resolution-independent.
 *
 * Fonts: the four standard Helvetica variants — they ship with every PDF
 * reader, so no font program is embedded. Glyph coverage is WinAnsi
 * (Latin-1 + a few extras); codepoints outside that range are replaced
 * with `?`. Notebooks dominated by emoji, CJK, etc. should export as
 * PNG/JPG/.hushnote instead.
 *
 * The text positioning is per-run absolute (Tm before each Tj) so glyph
 * advance metrics inside a run come from the PDF reader's Helvetica
 * tables — the layout never has to agree with the canvas's web-font
 * widths run-to-run.
 */

import type { Camera, Layer, Shape, TextShape } from "./types";
import type { CanvasTheme } from "./themes";
import { COLOR_PALETTE, FONT_FAMILY, LINE_HEIGHT_RATIO } from "./types";
import { parseText } from "./markdown";

/** Approximate top-of-glyph → baseline distance for Helvetica. The web
 *  canvas uses textBaseline="top" to draw at y, so PDF text emitted at
 *  the same canvas y needs to push its baseline down by this fraction
 *  of the font size. Empirically tuned to match Helvetica's ascent. */
const BASELINE_FROM_TOP = 0.78;

/** Byte budget per text-block before forcing a fresh BT/ET pair, just to
 *  keep individual content-stream lines reasonable for casual debugging. */
// (no chunking right now — the whole text block lives in one BT/ET pair)

interface FontKey { bold: boolean; italic: boolean }
const FONT_NAMES: Record<string, string> = {
  "0,0": "Helvetica",
  "1,0": "Helvetica-Bold",
  "0,1": "Helvetica-Oblique",
  "1,1": "Helvetica-BoldOblique",
};
function fontKey(k: FontKey): string {
  return `${k.bold ? 1 : 0},${k.italic ? 1 : 0}`;
}
function fontRefName(k: FontKey): string {
  return ({ "0,0": "F1", "1,0": "F2", "0,1": "F3", "1,1": "F4" } as Record<string, string>)[fontKey(k)];
}

export interface PdfTextContext {
  /** Page dimensions in CSS pixels (== PDF user-space units). */
  cssW: number;
  cssH: number;
  /** Pixel dimensions of the embedded JPEG. */
  pxW: number;
  pxH: number;
  /** Camera used for the rasterizer — the same transform we apply when
   *  positioning text shapes. */
  camera: Camera;
  /** Canvas theme — drives default text and heading colors. */
  theme: CanvasTheme;
  fontFamily: string;
  /** The full shape list. We filter to non-pocketed text shapes. */
  shapes: Shape[];
  /** Layer ordering. Hidden layers' text is skipped. */
  layers?: Layer[];
}

/**
 * Build a single-page PDF that:
 *   1. fills the page with `jpeg`
 *   2. paints every visible text shape on top as real PDF text
 *
 * The page MediaBox is sized in CSS pixels (so a 1-px-on-canvas glyph
 * is 1 PDF point); the JPEG is drawn at that same size regardless of
 * its native pixel resolution, so the image just renders sharper at
 * higher export scales.
 */
export function composeVectorTextPdf(
  jpeg: Uint8Array,
  ctx: PdfTextContext,
): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;

  const push = (chunk: Uint8Array | string) => {
    const bytes = typeof chunk === "string" ? enc.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
    return bytes.length;
  };
  const markObj = () => { offsets.push(length); };

  // Build the text content stream up-front so we know its byte length.
  const textStream = buildTextContentStream(ctx);

  // Combined content stream: image draw + text overlay.
  // PDF user space has y going UP from bottom-left, but image space has
  // y going UP too (top row of the raster lives at image-y=1), so a
  // straight `pxW 0 0 pxH 0 0 cm` paints the image right-side-up filling
  // the page.
  // CSS y (canvas convention, y down from top-left) maps to PDF user y
  // via `pdf_y = cssH - css_y`. We do that flip inside `buildTextContentStream`.
  const imageStream = `q\n${ctx.cssW} 0 0 ${ctx.cssH} 0 0 cm\n/Im0 Do\nQ\n`;
  const fullContent = imageStream + textStream;
  const contentBytes = enc.encode(fullContent);

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  // 1: catalog
  markObj();
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  // 2: pages
  markObj();
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

  // 3: page (resources reference 4..8: image + 4 fonts)
  markObj();
  push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R ` +
    `/MediaBox [0 0 ${ctx.cssW} ${ctx.cssH}] ` +
    `/Resources << ` +
      `/XObject << /Im0 4 0 R >> ` +
      `/Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R /F4 8 0 R >> ` +
    `>> /Contents 9 0 R >>\nendobj\n`,
  );

  // 4: image XObject (DCTDecode = JPEG)
  markObj();
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image ` +
    `/Width ${ctx.pxW} /Height ${ctx.pxH} ` +
    `/ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
    `/Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  push(jpeg);
  push("\nendstream\nendobj\n");

  // 5..8: standard 14 fonts (no font program embedded; readers supply them).
  const fontKeys: FontKey[] = [
    { bold: false, italic: false },
    { bold: true,  italic: false },
    { bold: false, italic: true  },
    { bold: true,  italic: true  },
  ];
  for (let i = 0; i < fontKeys.length; i++) {
    markObj();
    const name = FONT_NAMES[fontKey(fontKeys[i])];
    push(
      `${5 + i} 0 obj\n<< /Type /Font /Subtype /Type1 ` +
      `/BaseFont /${name} /Encoding /WinAnsiEncoding >>\nendobj\n`,
    );
  }

  // 9: content stream
  markObj();
  push(`9 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
  push(contentBytes);
  push("\nendstream\nendobj\n");

  // xref
  const xrefOffset = length;
  push(`xref\n0 10\n0000000000 65535 f \n`);
  for (const o of offsets) {
    push(o.toString().padStart(10, "0") + " 00000 n \n");
  }
  push(`trailer\n<< /Size 10 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ───────────────────── text emission ─────────────────────

function buildTextContentStream(c: PdfTextContext): string {
  const visibleLayerIds = new Set<string>();
  if (c.layers && c.layers.length) {
    for (const l of c.layers) if (!l.hidden) visibleLayerIds.add(l.id);
  }
  const isLayerVisible = (id: string | undefined): boolean => {
    if (!c.layers || !c.layers.length) return true;
    if (!id) return true;
    return visibleLayerIds.has(id);
  };

  // Reuse a single offscreen 2D context for canvas-based text measurement.
  // parseText needs widths to wrap, exactly as the renderer does.
  const measureCtx = (() => {
    const cv = document.createElement("canvas");
    return cv.getContext("2d")!;
  })();
  const ff = `${c.fontFamily}, ${FONT_FAMILY}`;

  const isDefaultColor = (col: string) => col === "#000000";

  const lines: string[] = ["BT"];

  // Track current state to avoid repeated identical ops.
  let curFont: string | null = null;
  let curSize = -1;
  let curColor: [number, number, number] | null = null;

  const setFont = (f: FontKey, sizePx: number) => {
    const ref = fontRefName(f);
    const sz = roundN(sizePx, 3);
    if (ref !== curFont || sz !== curSize) {
      lines.push(`/${ref} ${sz} Tf`);
      curFont = ref; curSize = sz;
    }
  };
  const setColor = (rgb: [number, number, number]) => {
    if (!curColor || rgb[0] !== curColor[0] || rgb[1] !== curColor[1] || rgb[2] !== curColor[2]) {
      lines.push(`${rgb[0]} ${rgb[1]} ${rgb[2]} rg`);
      curColor = rgb;
    }
  };

  for (const s of c.shapes) {
    if (s.type !== "text") continue;
    if (s.pocketed) continue;
    if (!isLayerVisible(s.layerId)) continue;

    const t = s as TextShape;
    const baseFontSize = t.fontSize;
    const measure = (text: string, fontSize: number): number => {
      measureCtx.font = `${fontSize}px ${ff}`;
      return measureCtx.measureText(text).width;
    };
    const parsed = parseText(
      t.text,
      t.width && t.width > 0 ? t.width : undefined,
      baseFontSize,
      measure,
    );

    const textColor = isDefaultColor(t.color) ? c.theme.foreground : t.color;
    const headingColor = isDefaultColor(t.color) ? c.theme.headingColor : t.color;

    // World position → page (CSS-pixel) position.
    const pageX0 = t.position.x * c.camera.zoom + c.camera.x;
    const pageY0 = t.position.y * c.camera.zoom + c.camera.y;

    const BLOCKQUOTE_GUTTER = baseFontSize * 0.9;
    const CHECKBOX_SIZE = baseFontSize * 0.85;
    const CHECKBOX_GAP = baseFontSize * 0.4;

    let yWorld = t.position.y;
    for (const line of parsed) {
      const lineScale = line.sizeScale;
      const lineFontSize = baseFontSize * lineScale;
      const lineH = lineFontSize * LINE_HEIGHT_RATIO;
      const isHeading = lineScale > 1;

      let xWorld = t.position.x;
      if (line.blockquote) xWorld += BLOCKQUOTE_GUTTER;
      if (line.task !== undefined) xWorld += CHECKBOX_SIZE + CHECKBOX_GAP;

      // Per-run emission. `runOffsetWorld` runs along the line in world
      // (canvas) units; converting to page coords applies `camera.zoom`.
      let runOffsetWorld = 0;
      for (const run of line.runs) {
        const runFontSize = baseFontSize * run.sizeScale;
        const sizePt = runFontSize * c.camera.zoom;

        const xPage = pageX0 + (xWorld - t.position.x + runOffsetWorld) * c.camera.zoom;
        const yPage = pageY0 + (yWorld - t.position.y) * c.camera.zoom + sizePt * BASELINE_FROM_TOP;

        // PDF y flips: pdf_y = cssH - page_css_y.
        const pdfX = roundN(xPage, 3);
        const pdfY = roundN(c.cssH - yPage, 3);

        // Color for this run: heading color > link accent > body color.
        let rgb: [number, number, number];
        if (run.link) rgb = hexToRgb01(c.theme.accent) || [0, 0, 1];
        else if (isHeading) rgb = hexToRgb01(headingColor) || [0, 0, 0];
        else rgb = hexToRgb01(textColor) || [0, 0, 0];

        setFont({ bold: !!run.bold, italic: !!run.italic }, sizePt);
        setColor(rgb);

        const literal = pdfStringLiteral(run.text);
        if (literal.length > 0) {
          lines.push(`1 0 0 1 ${pdfX} ${pdfY} Tm`);
          lines.push(`${literal} Tj`);
        }

        // Advance the in-line offset by the canvas-measured width so the
        // next run lines up with where the renderer's underline / highlight
        // rect was painted in the raster.
        runOffsetWorld += measure(run.text, runFontSize);
      }

      yWorld += lineH;
    }
  }

  lines.push("ET");
  return lines.join("\n") + "\n";
}

// ───────────────────── helpers ─────────────────────

function roundN(n: number, digits = 3): number {
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

/** Convert a hex `#rrggbb` (or short `#rgb`) to PDF `r g b` floats in 0..1. */
function hexToRgb01(hex: string): [number, number, number] | null {
  if (!hex) return null;
  const palette = COLOR_PALETTE[hex];
  const h = (palette || hex).replace(/^#/, "");
  const expand = h.length === 3
    ? h.split("").map((c) => c + c).join("")
    : h;
  if (expand.length !== 6) return null;
  const r = parseInt(expand.slice(0, 2), 16);
  const g = parseInt(expand.slice(2, 4), 16);
  const b = parseInt(expand.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  return [roundN(r / 255), roundN(g / 255), roundN(b / 255)];
}

/**
 * Encode an arbitrary string as a PDF literal, escaping the three reserved
 * characters and downgrading anything outside Latin-1 (WinAnsi's covered
 * range) to `?`. Returns the full `(...)` literal including parens.
 *
 * Intentionally lossy for emoji / CJK / etc. — PDF would need a CIDFont
 * with embedded font data to handle those, which is out of scope here.
 */
function pdfStringLiteral(text: string): string {
  if (!text) return "";
  let out = "(";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x28 || code === 0x29 || code === 0x5C) {
      out += "\\" + text[i];
      continue;
    }
    if (code < 0x20) {
      // Control characters — replace with space.
      out += " ";
      continue;
    }
    if (code <= 0xFF) {
      // Latin-1: emit the raw byte. For 0x80..0xFF this is approximately
      // WinAnsi (a few cells differ — close enough for the common subset).
      out += String.fromCharCode(code);
      continue;
    }
    out += "?";
  }
  out += ")";
  return out;
}
