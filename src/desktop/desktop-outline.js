/**
 * Desktop outline feature — the clickable outline column shown to the
 * left of a doc thumbnail's page, and (with file rows instead of
 * headings) to the left of a nested project's composite. See README
 * "Desktops". Two halves:
 *
 *   Render helpers (`layoutDocOutline` / `drawDocOutline`) — used by
 *   desktop-thumbs when baking a doc thumbnail with its outline on.
 *
 *   `createDesktopOutline(deps)` — the Desktop-side controller owning
 *   the per-doc outline state: the baked row hit-geometry (keyed by
 *   fileRef key), the canvas click handler that opens a doc at the
 *   clicked heading, and the per-doc / bulk toggles that regenerate a
 *   doc's thumbnail with the outline on or off.
 */

import { raisedLast } from "./desktop-content.js";

/** Thumbnail kinds that can carry an outline column: a doc's headings,
 *  a nested project's file list. */
const OUTLINE_KINDS = new Set(["doc", "project"]);

// Outline column geometry. Unscaled; scaled by the thumbnail's optScale.
export const OUTLINE_W = 190;
export const OUTLINE_GAP = 18;
export const OUTLINE_PAD_Y = 14;
export const OUTLINE_PAD_X = 8;
export const OUTLINE_ROW_H = 19;
export const OUTLINE_FONT = 11;
export const OUTLINE_INDENT = 11;

/** Lay out the outline column, which attaches to the **left** of the
 *  page block: the column occupies `[colX, colX + colW]` and the page
 *  sits immediately to its right, so the gap between the two is the
 *  column's trailing edge. Row hit-boxes span the whole column so a
 *  click anywhere on a row navigates. Coordinates are in the thumbnail's
 *  own (scaled) CSS space = the shape's local space, so the stored rows
 *  map straight through `world − shape.position`. `headings` is
 *  `{ text, level, startOffset? , target? }` — docs supply an offset
 *  into their own body, projects a file to open. */
export function layoutDocOutline(headings, scale, colX = 0) {
  const gap = Math.round(OUTLINE_GAP * scale);
  const padY = Math.round(OUTLINE_PAD_Y * scale);
  const rowH = Math.round(OUTLINE_ROW_H * scale);
  const indentStep = Math.round(OUTLINE_INDENT * scale);
  const usableW = Math.round(OUTLINE_W * scale);
  // Layout across the column: [padX][headings][gap][page]. The gap is
  // the divider's lane; padX just keeps the text off the outer edge.
  const padX = Math.round(OUTLINE_PAD_X * scale);
  const colW = padX + usableW + gap;
  const textX0 = colX + padX;
  const rows = headings.map((hd, i) => {
    const indent = (Math.max(1, hd.level) - 1) * indentStep;
    return {
      text: hd.text, level: hd.level, startOffset: hd.startOffset,
      // A project's rows point at whole files rather than an offset in
      // the doc the column belongs to; the click handler routes on it.
      ...(hd.target ? { target: hd.target } : {}),
      x: colX, w: colW, y: padY + i * rowH, h: rowH,
      textX: textX0 + indent, indent,
    };
  });
  const contentH = padY * 2 + Math.max(1, headings.length) * rowH;
  // Divider sits in the gap between the headings and the page.
  const dividerX = colX + colW - Math.round(gap / 2);
  return { rows, colW, contentH, textX0, usableW, rowH, padY, gap, scale, colX, dividerX };
}

function truncateToWidth(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

/** Paint the outline column: its own page-ground panel (the column
 *  reaches past the page and floats over neighbouring thumbnails, so it
 *  needs to be opaque), a light divider in the gap, then one indented
 *  heading per row (H1 bolder, deeper headings dimmer). */
export function drawDocOutline(ctx, outline, { ink, border, fontFamily, bg, height }) {
  const fontPx = Math.round(OUTLINE_FONT * outline.scale);
  const panelH = height || outline.contentH;
  if (bg) {
    ctx.save();
    ctx.fillStyle = bg;
    ctx.fillRect(outline.colX, 0, outline.colW, panelH);
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.strokeRect(outline.colX + 0.5, 0.5, outline.colW - 1, panelH - 1);
    ctx.restore();
  }
  ctx.save();
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  const dx = outline.dividerX + 0.5;
  ctx.beginPath();
  ctx.moveTo(dx, outline.padY);
  ctx.lineTo(dx, outline.contentH - outline.padY);
  ctx.stroke();

  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  if (!outline.rows.length) {
    ctx.font = `italic ${fontPx}px ${fontFamily}`;
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.45;
    ctx.fillText("No headings", outline.textX0, outline.padY + outline.rowH / 2);
    ctx.restore();
    return;
  }
  for (const r of outline.rows) {
    ctx.font = `${r.level <= 1 ? "600 " : ""}${fontPx}px ${fontFamily}`;
    ctx.fillStyle = ink;
    ctx.globalAlpha = r.level <= 1 ? 0.9 : r.level === 2 ? 0.72 : 0.58;
    const t = truncateToWidth(ctx, r.text || "", outline.usableW - r.indent - 4);
    ctx.fillText(t, r.textX, r.y + r.h / 2);
  }
  ctx.restore();
}

/** Open `fileId` and scroll its editor to `offset` (a heading). Mirrors
 *  the Find panel's open-then-scroll dance. */
export async function openDocAtOffset(state, fileId, offset) {
  await state.openFile(fileId); // closes the Desktop (file-opened)
  const startedAt = Date.now();
  while (Date.now() - startedAt < 900) {
    if (state.currentFileId === fileId && state.editor?.view) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  const view = state.editor?.view;
  if (!view) return;
  const { EditorView } = await import("@codemirror/view");
  const safe = Math.max(0, Math.min(offset, view.state.doc.length));
  view.dispatch({
    selection: { anchor: safe },
    effects: EditorView.scrollIntoView(safe, { y: "start", yMargin: 80 }),
  });
  view.focus();
}

/**
 * Controller owning the Desktop's per-doc outline state + interaction.
 * `deps` bridges back to desktop-view's canvas + thumbnail machinery:
 *   getCanvas, getHost, getState, getContainerId, getThemeCtx, getToken,
 *   collectOpts, ensureThumb(state, entry, themeCtx),
 *   collectFiles(state, containerId, opts), applyThumb(key, thumb),
 *   screenToCanvas(pt, camera), scheduleSave(), openRef(fileRef).
 */
export function createDesktopOutline(deps) {
  const rows = new Map();

  const has = (key) => rows.has(key);
  const setRows = (key, v) => { if (v) rows.set(key, v); else rows.delete(key); };
  const clear = () => rows.clear();

  /** Resolve a client point to an outline heading row, or null. The hit
   *  carries the shape + row geometry so the caller can both navigate
   *  (startOffset) and paint the hover underline (shape-local rect). */
  function hitAt(clientX, clientY) {
    const canvas = deps.getCanvas();
    const host = deps.getHost();
    const st = canvas?.state;
    if (!st || !host) return null;
    const rect = host.getBoundingClientRect();
    const world = deps.screenToCanvas({ x: clientX - rect.left, y: clientY - rect.top }, st.camera);
    // Topmost first, in the renderer's raised-last paint order so an
    // outline column that overlaps a neighbour wins the contested point.
    const ordered = raisedLast(st.shapes, st.selectedIds);
    for (let i = ordered.length - 1; i >= 0; i--) {
      const s = ordered[i];
      // `key`, not `fileId` — a nested project's thumbnail carries an
      // outline too and has no fileId of its own.
      if (s.type !== "image" || !s.fileRef?.key) continue;
      const rowList = rows.get(s.fileRef.key);
      if (!rowList) continue;
      const lx = world.x - s.position.x, ly = world.y - s.position.y;
      if (lx < 0 || ly < 0 || lx > s.width || ly > s.height) continue;
      for (const r of rowList) {
        if (lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h) {
          return {
            fileId: s.fileRef.fileId, startOffset: r.startOffset,
            target: r.target || null,
            hover: { shapeId: s.id, x: r.x, y: r.y, w: r.w, h: r.h },
          };
        }
      }
      return null; // inside this thumbnail but not on a row
    }
    return null;
  }

  /** Publish the hovered row so the renderer can underline it. */
  function setHover(next) {
    const st = deps.getCanvas()?.state;
    if (!st) return;
    const prev = st.desktopOutlineHover;
    if (prev?.shapeId === next?.shapeId && prev?.y === next?.y) return;
    st.desktopOutlineHover = next;
    st.notify("desktopOutlineHover");
  }

  /** Wire pointer handlers that open a doc at a clicked heading, telling
   *  a click from a drag by pointer travel, plus the hover underline
   *  that marks the row a click would follow. Returns a cleanup fn. */
  function attachClicks() {
    const el = deps.getCanvas()?.state?.canvasEl;
    if (!el) return () => {};
    let down = null;
    const onDown = (e) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; };
    const onUp = (e) => {
      const start = down; down = null;
      if (!start) return;
      if (Math.abs(e.clientX - start.x) > 4 || Math.abs(e.clientY - start.y) > 4) return;
      const st = deps.getCanvas()?.state;
      if (!st || st.tool !== "select") return;
      const hit = hitAt(e.clientX, e.clientY);
      if (!hit) return;
      e.stopPropagation();
      // A project row opens the whole file it names; a doc row scrolls
      // the doc the column belongs to to that heading.
      if (hit.target) deps.openRef(hit.target);
      else if (hit.fileId) openDocAtOffset(deps.getState(), hit.fileId, hit.startOffset);
    };
    const onMove = (e) => {
      const st = deps.getCanvas()?.state;
      if (!st) return;
      // No hover feedback mid-gesture or under another tool — the row
      // isn't clickable then, so it shouldn't look like it is.
      if (down || st.tool !== "select" || st.isPanning || st.editingText) { setHover(null); return; }
      const hit = hitAt(e.clientX, e.clientY);
      setHover(hit ? hit.hover : null);
      el.style.cursor = hit ? "pointer" : "";
    };
    const onLeave = () => setHover(null);
    // iOS cancels the pointer stream when a second finger lands and the
    // canvas takes over the gesture. Drop the pending press with it, so
    // a later pointerup can't pair with it and read as a row click
    // in the middle of a two-finger pan.
    const onCancel = () => { down = null; setHover(null); };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("pointercancel", onCancel);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("pointercancel", onCancel);
      setHover(null);
    };
  }

  /** Regenerate one doc's thumbnail with `outline` on/off, applying the
   *  new dataUrl / dims / rows in place. The column attaches to the left
   *  of the page, so the shape slides left by exactly the width it
   *  gained (and back right on close) — the page itself stays put
   *  instead of jumping sideways under the pointer. */
  async function regenDoc(entry, on) {
    const st = deps.getCanvas().state;
    const prevW = st.shapes.find((s) => s.type === "image" && s.fileRef?.key === entry.key)?.width || 0;
    st.shapes = st.shapes.map((s) =>
      (s.type === "image" && s.fileRef?.key === entry.key)
        ? { ...s, fileRef: { ...s.fileRef, outline: on || undefined } } : s);
    entry.outline = on;
    deps.applyThumb(entry.key, await deps.ensureThumb(deps.getState(), entry, deps.getThemeCtx()));
    const after = deps.getCanvas()?.state;
    if (!after || !prevW) return;
    const shape = after.shapes.find((s) => s.type === "image" && s.fileRef?.key === entry.key);
    const dx = (shape?.width || 0) - prevW;
    if (!shape || !dx) return;
    after.shapes = after.shapes.map((s) =>
      s.id === shape.id ? { ...s, position: { ...s.position, x: s.position.x - dx } } : s);
    after.notify("shapes");
  }

  /** Toggle a single thumbnail's outline (hover Outline button). Docs
   *  and nested projects both have one. */
  async function toggle(ref) {
    if (!deps.getCanvas() || !ref || !OUTLINE_KINDS.has(ref.kind)) return;
    const collected = deps.collectFiles(deps.getState(), deps.getContainerId(), deps.collectOpts());
    const entry = collected?.entries.find((e) => e.key === ref.key);
    if (!entry) return;
    const shape = deps.getCanvas().state.shapes.find((s) => s.fileRef?.key === ref.key);
    await regenDoc(entry, !shape?.fileRef?.outline);
    deps.scheduleSave();
  }

  /** Open or close the outline on every doc + nested project (Desktop
   *  settings). */
  async function setAll(on) {
    if (!deps.getCanvas() || !deps.getContainerId()) return;
    const token = deps.getToken();
    const collected = deps.collectFiles(deps.getState(), deps.getContainerId(), deps.collectOpts());
    for (const entry of (collected?.entries || []).filter((e) => OUTLINE_KINDS.has(e.kind))) {
      await regenDoc(entry, on);
      if (token !== deps.getToken()) return;
    }
    deps.scheduleSave();
  }

  return { has, setRows, clear, attachClicks, toggle, setAll };
}
