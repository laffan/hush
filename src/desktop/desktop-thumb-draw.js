/**
 * Desktop thumbnail drawing primitives — the canvas plumbing every
 * thumbnail renderer in desktop-thumbs.js sits on: HiDPI canvas setup,
 * WebP encoding, image decoding, the shared render options, the neutral
 * fallback card, and the page-ground / ink helpers that keep a doc page
 * readable whatever theme the canvas itself is wearing.
 *
 * Split out of desktop-thumbs.js (700-line cap). Nothing here recurses
 * into `ensureDesktopThumb`, so the seam is clean in one direction:
 * desktop-thumbs imports these, never the reverse.
 */

// Fallback card dims, and the raster density every thumbnail renders at.
export const CARD_W = 220;
export const CARD_H = 280;
export const SCALE = 2;

export function makeCanvas(cssW, cssH) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cssW * SCALE));
  canvas.height = Math.max(1, Math.round(cssH * SCALE));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  return { canvas, ctx };
}

export function encode(canvas) {
  return canvas.toDataURL("image/webp", 0.85);
}

export function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Base render opts shared by every thumbnail — blank background in the
 *  container's own canvas colour so thumbs read as part of the surface. */
export function baseRenderOpts(themeCtx) {
  return {
    imageCache: new Map(),
    theme: themeCtx.theme,
    backgroundPattern: "blank",
    gridSpacing: 25,
    gridOpacity: 0,
    fontFamily: themeCtx.fontFamily,
    includeBackground: true,
    canvasBackgroundOverride: themeCtx.canvasBackgroundOverride || "",
    flowchart: undefined,
    omitTextGlyphs: false,
  };
}

/** A neutral card used for stacks, pending PDFs, and empty containers. */
export function drawCard(themeCtx, label, glyph, cssW = CARD_W, cssH = CARD_H) {
  const { canvas, ctx } = makeCanvas(cssW, cssH);
  const t = themeCtx.theme;
  ctx.fillStyle = themeCtx.canvasBackgroundOverride || t.canvasBackground;
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.strokeStyle = t.uiBorder || "rgba(128,128,128,0.3)";
  ctx.strokeRect(0.5, 0.5, cssW - 1, cssH - 1);
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.strokeStyle = t.foreground;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  const cx = cssW / 2, cy = cssH / 2 - 10;
  if (glyph === "stack") {
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(cx + i * 16, cy - 28);
      ctx.lineTo(cx + i * 16, cy + 28);
      ctx.stroke();
    }
  } else if (glyph === "pdf" || glyph === "project") {
    ctx.strokeRect(cx - 24, cy - 30, 48, 60);
  }
  if (label) {
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = t.foreground;
    ctx.font = `12px ${themeCtx.fontFamily}, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, cx, cy + 52);
  }
  ctx.restore();
  return { dataUrl: encode(canvas), w: cssW, h: cssH };
}

/** Strip YAML frontmatter + %%comments%% so a doc thumbnail starts at
 *  its actual prose (and the page count skips editorial scaffolding). */
export function docThumbText(content) {
  let text = content || "";
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) text = text.slice(end + 4).replace(/^\n+/, "");
  }
  return text.replace(/%%[\s\S]*?%%/g, "");
}

/** Page ground colour for the doc page / notebook matte, by appearance. */
export function pageGround(themeCtx) {
  return themeCtx.appearance === "dark" ? "#000000" : "#ffffff";
}

/** Rough sRGB luminance of a #rgb / #rrggbb color; null when unparsable. */
function hexLuminance(color) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((color || "").trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/** The doc page is always white (light) / black (dark), whatever the
 *  canvas theme — so make sure the ink still contrasts when the user
 *  paired a dark theme with light appearance (or vice versa). */
export function docPageTheme(themeCtx) {
  const dark = themeCtx.appearance === "dark";
  const t = themeCtx.theme;
  const fixInk = (color, fallback) => {
    const lum = hexLuminance(color);
    if (lum == null) return color;
    if (dark && lum < 0.35) return fallback;
    if (!dark && lum > 0.65) return fallback;
    return color;
  };
  return {
    ...t,
    foreground: fixInk(t.foreground, dark ? "#e8e8e8" : "#1a1a1a"),
    headingColor: fixInk(t.headingColor, dark ? "#e8e8e8" : "#1a1a1a"),
  };
}
