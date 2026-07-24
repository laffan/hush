/**
 * Desktop doc-outline feature — the clickable outline column shown to
 * the right of a doc thumbnail (see README "Desktops"). Two halves:
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

// Outline column geometry. Unscaled; scaled by the thumbnail's optScale.
export const OUTLINE_W = 190;
export const OUTLINE_GAP = 18;
export const OUTLINE_PAD_Y = 14;
export const OUTLINE_ROW_H = 19;
export const OUTLINE_FONT = 11;
export const OUTLINE_INDENT = 11;

/** Lay out the outline column to the right of the page block (`blockX`
 *  = the page block's right edge). Row hit-boxes span the whole column
 *  so a click anywhere on a heading's row navigates. Coordinates are in
 *  the thumbnail's own (scaled) CSS space = the shape's local space, so
 *  the stored rows map straight through `world − shape.position`. */
export function layoutDocOutline(headings, scale, blockX) {
  const gap = Math.round(OUTLINE_GAP * scale);
  const padY = Math.round(OUTLINE_PAD_Y * scale);
  const rowH = Math.round(OUTLINE_ROW_H * scale);
  const indentStep = Math.round(OUTLINE_INDENT * scale);
  const usableW = Math.round(OUTLINE_W * scale);
  const colW = gap + usableW;
  const textX0 = blockX + gap;
  const rows = headings.map((hd, i) => {
    const indent = (Math.max(1, hd.level) - 1) * indentStep;
    return {
      text: hd.text, level: hd.level, startOffset: hd.startOffset,
      x: blockX, w: colW, y: padY + i * rowH, h: rowH,
      textX: textX0 + indent, indent,
    };
  });
  const contentH = padY * 2 + Math.max(1, headings.length) * rowH;
  return { rows, colW, contentH, textX0, usableW, rowH, padY, gap, scale, blockX };
}

function truncateToWidth(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

/** Paint the outline column: a light divider in the gap, then one
 *  indented heading per row (H1 bolder, deeper headings dimmer). */
export function drawDocOutline(ctx, outline, { ink, border, fontFamily }) {
  const fontPx = Math.round(OUTLINE_FONT * outline.scale);
  ctx.save();
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  const dx = outline.blockX + Math.round(outline.gap / 2) + 0.5;
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
 *   screenToCanvas(pt, camera), scheduleSave().
 */
export function createDesktopOutline(deps) {
  const rows = new Map();

  const has = (key) => rows.has(key);
  const setRows = (key, v) => { if (v) rows.set(key, v); else rows.delete(key); };
  const clear = () => rows.clear();

  /** Resolve a client point to an outline heading row, or null. */
  function hitAt(clientX, clientY) {
    const canvas = deps.getCanvas();
    const host = deps.getHost();
    const st = canvas?.state;
    if (!st || !host) return null;
    const rect = host.getBoundingClientRect();
    const world = deps.screenToCanvas({ x: clientX - rect.left, y: clientY - rect.top }, st.camera);
    for (let i = st.shapes.length - 1; i >= 0; i--) {
      const s = st.shapes[i];
      if (s.type !== "image" || !s.fileRef?.fileId) continue;
      const rowList = rows.get(s.fileRef.key);
      if (!rowList) continue;
      const lx = world.x - s.position.x, ly = world.y - s.position.y;
      if (lx < 0 || ly < 0 || lx > s.width || ly > s.height) continue;
      for (const r of rowList) {
        if (lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h) {
          return { fileId: s.fileRef.fileId, startOffset: r.startOffset };
        }
      }
      return null; // inside this thumbnail but not on a row
    }
    return null;
  }

  /** Wire pointer handlers that open a doc at a clicked heading, telling
   *  a click from a drag by pointer travel. Returns a cleanup fn. */
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
      if (hit) { e.stopPropagation(); openDocAtOffset(deps.getState(), hit.fileId, hit.startOffset); }
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }

  /** Regenerate one doc's thumbnail with `outline` on/off, applying the
   *  new dataUrl / dims / rows in place. */
  async function regenDoc(entry, on) {
    const st = deps.getCanvas().state;
    st.shapes = st.shapes.map((s) =>
      (s.type === "image" && s.fileRef?.key === entry.key)
        ? { ...s, fileRef: { ...s.fileRef, outline: on || undefined } } : s);
    entry.outline = on;
    deps.applyThumb(entry.key, await deps.ensureThumb(deps.getState(), entry, deps.getThemeCtx()));
  }

  /** Toggle a single doc's outline (hover Outline button). */
  async function toggleDoc(ref) {
    if (!deps.getCanvas() || !ref || ref.kind !== "doc") return;
    const collected = deps.collectFiles(deps.getState(), deps.getContainerId(), deps.collectOpts());
    const entry = collected?.entries.find((e) => e.key === ref.key);
    if (!entry) return;
    const shape = deps.getCanvas().state.shapes.find((s) => s.fileRef?.key === ref.key);
    await regenDoc(entry, !shape?.fileRef?.outline);
    deps.scheduleSave();
  }

  /** Open or close the outline on every doc (Desktop settings). */
  async function setAll(on) {
    if (!deps.getCanvas() || !deps.getContainerId()) return;
    const token = deps.getToken();
    const collected = deps.collectFiles(deps.getState(), deps.getContainerId(), deps.collectOpts());
    for (const entry of (collected?.entries || []).filter((e) => e.kind === "doc")) {
      await regenDoc(entry, on);
      if (token !== deps.getToken()) return;
    }
    deps.scheduleSave();
  }

  return { has, setRows, clear, attachClicks, toggleDoc, setAll };
}
