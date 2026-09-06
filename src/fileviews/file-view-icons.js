/**
 * Canvas glyphs for the desktop file view.
 *
 * The list panel's icons are line-art SVG (`typeIcons`); these are their
 * canvas cousins, drawn at desktop-icon size. The one deliberate
 * departure is the folder: the tree draws a folder as a circle, but a
 * desktop where folders don't look like folders isn't a desktop, so
 * containers get the tabbed manila shape and carry the tree's glyph as
 * the mark on their face.
 */

import { rgba, mix, toRgb, uiFont } from "./file-view-surface.js";

const CONTAINER_KINDS = new Set(["folder", "project", "desk", "inbox", "images", "pdfs", "archive", "trash"]);
export const isContainerKind = (k) => CONTAINER_KINDS.has(k);

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** The tabbed folder body, sized to fill `w × h`. */
function folderPath(ctx, x, y, w, h) {
  const r = Math.max(2, w * 0.06);
  const tabW = w * 0.42;
  const tabH = h * 0.16;
  const bodyY = y + tabH;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + tabW - r * 1.2, y);
  ctx.quadraticCurveTo(x + tabW, y, x + tabW + tabH * 0.5, y + tabH * 0.7);
  ctx.lineTo(x + tabW + tabH * 0.7, bodyY);
  ctx.lineTo(x + w - r, bodyY);
  ctx.quadraticCurveTo(x + w, bodyY, x + w, bodyY + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** A page with a folded top-right corner. */
function pagePath(ctx, x, y, w, h, fold) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w - fold, y);
  ctx.lineTo(x + w, y + fold);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
}

/** The small mark on a container's face, echoing the tree's glyph for
 *  that kind (circle = folder, triangle = project, and so on). */
function containerMark(ctx, kind, cx, cy, s) {
  ctx.beginPath();
  switch (kind) {
    case "project":
      ctx.moveTo(cx, cy - s); ctx.lineTo(cx + s, cy + s * 0.8); ctx.lineTo(cx - s, cy + s * 0.8); ctx.closePath();
      break;
    case "inbox":
      ctx.rect(cx - s, cy - s, s * 2, s * 2);
      ctx.moveTo(cx - s, cy); ctx.lineTo(cx - s * 0.35, cy);
      ctx.lineTo(cx - s * 0.1, cy + s * 0.4); ctx.lineTo(cx + s * 0.1, cy + s * 0.4);
      ctx.lineTo(cx + s * 0.35, cy); ctx.lineTo(cx + s, cy);
      break;
    case "images":
      ctx.rect(cx - s, cy - s, s * 2, s * 2);
      ctx.moveTo(cx - s * 0.6, cy + s * 0.6); ctx.lineTo(cx + s * 0.6, cy - s * 0.6);
      break;
    case "pdfs":
      ctx.rect(cx - s * 0.75, cy - s, s * 1.5, s * 2);
      ctx.moveTo(cx - s * 0.4, cy); ctx.lineTo(cx + s * 0.4, cy);
      break;
    case "archive":
      ctx.rect(cx - s, cy - s, s * 2, s * 0.7);
      ctx.moveTo(cx - s * 0.8, cy - s * 0.3); ctx.lineTo(cx - s * 0.8, cy + s);
      ctx.lineTo(cx + s * 0.8, cy + s); ctx.lineTo(cx + s * 0.8, cy - s * 0.3);
      break;
    case "trash":
      ctx.moveTo(cx - s, cy - s * 0.6); ctx.lineTo(cx + s, cy - s * 0.6);
      ctx.moveTo(cx - s * 0.7, cy - s * 0.6); ctx.lineTo(cx - s * 0.55, cy + s);
      ctx.lineTo(cx + s * 0.55, cy + s); ctx.lineTo(cx + s * 0.7, cy - s * 0.6);
      break;
    case "desk":
      ctx.moveTo(cx - s, cy - s * 0.5); ctx.lineTo(cx + s, cy - s * 0.5);
      ctx.moveTo(cx - s * 0.75, cy - s * 0.5); ctx.lineTo(cx - s * 0.75, cy + s);
      ctx.moveTo(cx + s * 0.75, cy - s * 0.5); ctx.lineTo(cx + s * 0.75, cy + s);
      ctx.moveTo(cx, cy - s * 0.5); ctx.lineTo(cx, cy + s);
      break;
    default: // plain folder — the tree's circle
      ctx.arc(cx, cy, s * 0.85, 0, Math.PI * 2);
  }
  ctx.stroke();
}

/** Page contents per leaf kind. */
function leafMark(ctx, kind, x, y, w, h) {
  const px = x + w * 0.22, pw = w * 0.56;
  ctx.beginPath();
  if (kind === "notebook" || kind === "gutter") {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const dx = px + (pw / 2) * c, dy = y + h * 0.3 + (h * 0.2) * r;
        ctx.moveTo(dx + 0.9, dy); ctx.arc(dx, dy, 0.9, 0, Math.PI * 2);
      }
    }
    ctx.fill();
    if (kind === "gutter") {
      ctx.beginPath();
      ctx.moveTo(px - w * 0.06, y + h * 0.24); ctx.lineTo(px - w * 0.06, y + h * 0.78);
      ctx.moveTo(px + pw + w * 0.06, y + h * 0.24); ctx.lineTo(px + pw + w * 0.06, y + h * 0.78);
      ctx.stroke();
    }
    return;
  }
  if (kind === "pdf") {
    ctx.moveTo(px, y + h * 0.55); ctx.lineTo(px + pw, y + h * 0.55);
    ctx.stroke();
    return;
  }
  if (kind === "stack") {
    for (let c = 0; c < 3; c++) {
      const dx = px + (pw / 2) * c;
      ctx.moveTo(dx, y + h * 0.24); ctx.lineTo(dx, y + h * 0.8);
    }
    ctx.stroke();
    return;
  }
  if (kind === "image") {
    ctx.rect(px, y + h * 0.3, pw, h * 0.42);
    ctx.moveTo(px + pw * 0.15, y + h * 0.64); ctx.lineTo(px + pw * 0.85, y + h * 0.38);
    ctx.stroke();
    return;
  }
  // document — the tree's three rules, the last one short
  const ys = [0.36, 0.52, 0.68];
  ys.forEach((f, i) => {
    ctx.moveTo(px, y + h * f);
    ctx.lineTo(px + pw * (i === 2 ? 0.6 : 1), y + h * f);
  });
  ctx.stroke();
}

/**
 * Draw one icon into the box `x, y, w, h`.
 * `opts`: { active, selected, hover, open, dim, flagged, tint } —
 * `active` is the file open in the editor, `open` a container whose ring
 * is showing, `tint` the row colour the node carries in the list. Hover
 * only warms the face; the dashed ring is reserved for selection, or the
 * pointer and the caret end up saying the same thing twice.
 */
export function drawIcon(ctx, kind, x, y, w, h, colors, opts = {}) {
  const ink = opts.active ? colors.link : colors.fg;
  const alpha = opts.dim ? 0.35 : 1;
  const fillT = opts.selected ? 0.24 : opts.hover ? 0.16 : (opts.open ? 0.14 : 0.07);
  // A tinted row keeps its colour here: the list paints it as a faint
  // wash behind the row, so the icon's face carries the same wash.
  const tint = opts.tint ? toRgb(opts.tint, null) : null;
  const face = tint
    ? mix(colors.bg, tint, opts.selected ? 0.44 : opts.hover ? 0.34 : 0.26)
    : mix(colors.bg, ink, fillT);
  // Flagged nodes read heavier, the way the tree's filled glyph does.
  const markWidth = opts.flagged ? 2.1 : 1.2;
  ctx.save();
  ctx.lineWidth = 1.2;
  ctx.lineJoin = "round";
  ctx.strokeStyle = rgba(ink, 0.75 * alpha);
  ctx.fillStyle = rgba(face, alpha);
  if (isContainerKind(kind)) {
    folderPath(ctx, x, y, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = rgba(ink, (opts.flagged ? 0.85 : 0.6) * alpha);
    ctx.lineWidth = markWidth;
    containerMark(ctx, kind, x + w * 0.5, y + h * 0.62, Math.min(w, h) * 0.16);
  } else {
    const pw = w * 0.72, px = x + (w - pw) / 2;
    pagePath(ctx, px, y, pw, h, Math.max(4, pw * 0.26));
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = rgba(ink, (opts.flagged ? 0.9 : 0.55) * alpha);
    ctx.fillStyle = rgba(ink, (opts.flagged ? 0.9 : 0.55) * alpha);
    ctx.lineWidth = markWidth;
    leafMark(ctx, kind, px, y, pw, h);
  }
  if (opts.selected) {
    ctx.strokeStyle = rgba(ink, 0.9 * alpha);
    ctx.lineWidth = 1;
    roundRect(ctx, x - 4, y - 4, w + 8, h + 8, 5);
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/** Icon label: up to `opts.lines` centred lines, ellipsised. Returns the
 *  height it painted so callers can stack under it. */
export function drawLabel(ctx, text, cx, top, maxWidth, colors, opts = {}) {
  const size = opts.size || 10.5;
  const lh = size + 3;
  const maxLines = opts.lines || 2;
  ctx.save();
  ctx.font = uiFont(size, opts.active ? 600 : 400);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = rgba(opts.active ? colors.link : colors.fg, opts.dim ? 0.4 : 0.82);

  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  let i = 0;
  for (; i < words.length; i++) {
    const next = line ? line + " " + words[i] : words[i];
    if (!line || ctx.measureText(next).width <= maxWidth) { line = next; continue; }
    lines.push(line);
    line = words[i];
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) { lines.push(line); i = words.length; }
  // Anything that didn't fit — leftover words, or a single word wider
  // than the box — is ellipsised onto the last line.
  if (lines.length) {
    const truncated = i < words.length;
    let last = lines[lines.length - 1];
    if (truncated || ctx.measureText(last).width > maxWidth) {
      while (last.length > 1 && ctx.measureText(last + "…").width > maxWidth) last = last.slice(0, -1);
      lines[lines.length - 1] = last + "…";
    }
  }
  // A label that sits over the scrimmed desktop gets a plate under it,
  // or a ring item's name lands on top of the name of whatever icon it
  // happens to be floating over.
  if (opts.plate) {
    const w = Math.min(maxWidth, Math.max(...lines.map((l) => ctx.measureText(l).width), 0)) + 6;
    ctx.fillStyle = rgba(colors.bg, 0.82);
    ctx.fillRect(cx - w / 2, top - 2, w, lines.length * lh + 2);
    ctx.fillStyle = rgba(opts.active ? colors.link : colors.fg, opts.dim ? 0.4 : 0.82);
  }
  lines.forEach((l, n) => ctx.fillText(l, cx, top + n * lh));
  ctx.restore();
  return lines.length * lh;
}

export { roundRect };
