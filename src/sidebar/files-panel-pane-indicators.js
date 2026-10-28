/**
 * Pane + sticky indicators painted under each doc/notebook row in the
 * files panel. One small outlined rectangle per floating pane the file
 * owns, followed by one small filled square per File Sticky attached to
 * it; hovering a cell shows the pane's filename (or the sticky's
 * excerpt) in a small tooltip.
 *
 * A *docked* pane is part of what the file opens onto, so it is listed
 * rather than squared: a line of its own under the row (below any cards
 * the row is open on), the pane icon filled on the side it is docked to,
 * then the pane's filename — what clicking the row will put on screen.
 *
 * When the file's panes are hidden via the command palette
 * (`settings.panesHiddenByContext`), the pane cells dim so the row
 * signals "this is a desktop, just temporarily tucked away" without
 * taking real vertical space — sticky cells stay at full strength
 * since hiding panes doesn't hide stickies.
 */
import { getPanesForContext, contextIdForFile } from "../pane/pane-manager.js";

// tree-node type → the kind key `window.__hushFileStickies` expects.
const STICKY_KIND = { document: "doc", notebook: "notebook", pdf: "pdf", stack: "stack" };

/** File Stickies attached to this file, read live from the sticky
 *  module's registry (registered on window by initStickyNotes — absent
 *  in early boot or non-sticky builds, hence the guard). */
function stickiesForFile(itemType, fileId) {
  const kind = STICKY_KIND[itemType];
  if (!kind || !fileId) return [];
  const fn = typeof window !== "undefined" ? window.__hushFileStickies : null;
  if (typeof fn !== "function") return [];
  try { return fn(kind, fileId) || []; } catch (_) { return []; }
}

/** Persisted-pane fallback for a context with no LIVE panes in this
 *  window. Panes are per-window runtime objects, so a pane opened in a
 *  sibling window never lands in this window's pane manager — but it
 *  does land in the shared `settings.persistedPanes`, and the file
 *  should read as a desktop in every window's sidebar. Only consulted
 *  when the local set is empty so a context with live panes never
 *  double-counts. */
function persistedPanesForContext(state, ctx) {
  const list = state.settings?.persistedPanes;
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && p.ownerContext === ctx && !p.gutter)
    .map((p) => ({ fileName: p.fileName || "Untitled", dockEdge: p.docked ? p.dockEdge || null : null }));
}

/** The pane glyph (sidebar_icons/pane.svg's frame) with the region a
 *  dock on `edge` occupies filled in. */
const DOCK_FILL = {
  left: "M4 3H9V21H4C2.9 21 2 20.1 2 19V5C2 3.9 2.9 3 4 3Z",
  right: "M15 3H20C21.1 3 22 3.9 22 5V19C22 20.1 21.1 21 20 21H15Z",
  top: "M4 3H20C21.1 3 22 3.9 22 5V10H2V5C2 3.9 2.9 3 4 3Z",
  bottom: "M2 14H22V19C22 20.1 21.1 21 20 21H4C2.9 21 2 20.1 2 19Z",
};
function dockGlyph(edge) {
  return `<svg viewBox="0 0 24 24" class="tree-dock-glyph" aria-hidden="true">`
    + `<path class="tree-dock-fill" d="${DOCK_FILL[edge] || ""}"/>`
    + `<path d="M2 19V5C2 3.9 2.9 3 4 3H20C21.1 3 22 3.9 22 5V19C22 20.1 21.1 21 20 21H4C2.9 21 2 20.1 2 19Z"/></svg>`;
}

/** Height the indicators take under the row (the sidebar pads the row
 *  by it — files-panel.css, `--pane-ind-h`): a line of cells, and a line
 *  per docked pane. */
const CELLS_H = 15;
const DOCKED_ROW_H = 17;

function buildStrip(ctxPanes, stickies, hidden, inline) {
  const strip = document.createElement("span");
  strip.className = inline ? "tree-pane-indicators-inline" : "tree-pane-indicators";
  const docked = inline ? [] : ctxPanes.filter((p) => p.dockEdge);
  const floating = inline ? ctxPanes : ctxPanes.filter((p) => !p.dockEdge);
  const cells = inline ? strip : document.createElement("span");
  if (!inline) cells.className = "tree-pane-cells";
  for (const p of floating) {
    const cell = document.createElement("span");
    cell.className = "tree-pane-cell" + (hidden ? " dimmed" : "");
    cell.dataset.paneName = p.fileName || "Untitled";
    cells.appendChild(cell);
  }
  for (const s of stickies) {
    const cell = document.createElement("span");
    cell.className = "tree-pane-cell tree-sticky-cell";
    const excerpt = (s.text || "").trim().split("\n")[0].slice(0, 42);
    cell.dataset.paneName = excerpt || "Sticky";
    cells.appendChild(cell);
  }
  if (inline) return strip;
  const hasCells = cells.childElementCount > 0;
  if (hasCells) strip.appendChild(cells);
  for (const p of docked) {
    const row = document.createElement("span");
    row.className = "tree-docked-pane" + (hidden ? " dimmed" : "");
    row.dataset.paneName = `${p.fileName || "Untitled"} — docked ${p.dockEdge}`;
    row.innerHTML = `${dockGlyph(p.dockEdge)}<span class="tree-docked-pane-name"></span>`;
    row.lastChild.textContent = p.fileName || "Untitled";
    strip.appendChild(row);
  }
  strip.dataset.height = String((hasCells ? CELLS_H : 2) + docked.length * DOCKED_ROW_H);
  return strip;
}

export function paneIndicatorsFor(item, state) {
  if (!item.fileId) return null;
  // The gutter row is where its paired DOC's pane icons live (inline, after the
  // "Gutter" label). The gutter pane ITSELF gets no square — so pull the doc's
  // panes and drop the gutter from them. renderItem appends this inside the
  // name span; the doc's own below-strip is suppressed when it has a gutter.
  if (item.type === "notebook" && item.gutter) {
    const ctx = contextIdForFile(item.gutterForDoc, "document");
    let docPanes = getPanesForContext(ctx).filter((p) => !p.gutter);
    if (!docPanes.length) docPanes = persistedPanesForContext(state, ctx);
    const docStickies = stickiesForFile("document", item.gutterForDoc);
    if (!docPanes.length && !docStickies.length) return null;
    return buildStrip(docPanes, docStickies, !!(state.settings?.panesHiddenByContext || {})[ctx], true);
  }
  if (!(item.type in STICKY_KIND)) return null;
  const stickies = stickiesForFile(item.type, item.fileId);
  // Pane squares stay a doc/notebook affordance; PDF and stack rows can
  // still carry sticky squares.
  let ctxPanes = [];
  let hidden = false;
  if (item.type === "document" || item.type === "notebook") {
    const ctx = contextIdForFile(item.fileId, item.type);
    // Drop the gutter pane — a gutter never shows a square (its row carries the
    // doc's other panes instead).
    ctxPanes = getPanesForContext(ctx).filter((p) => !p.gutter);
    if (!ctxPanes.length) ctxPanes = persistedPanesForContext(state, ctx);
    hidden = !!(state.settings?.panesHiddenByContext || {})[ctx];
  }
  if (!ctxPanes.length && !stickies.length) return null;
  return buildStrip(ctxPanes, stickies, hidden, false);
}

let _paneTooltipEl = null;
function ensureTooltip() {
  if (_paneTooltipEl) return _paneTooltipEl;
  _paneTooltipEl = document.createElement("div");
  _paneTooltipEl.className = "tree-pane-tooltip";
  document.body.appendChild(_paneTooltipEl);
  return _paneTooltipEl;
}

export function attachPaneIndicatorTooltip(root) {
  const showFor = (cell, x, y) => {
    const t = ensureTooltip();
    t.textContent = cell.dataset.paneName || "Untitled";
    t.style.left = x + 12 + "px";
    t.style.top = y + 12 + "px";
    t.style.display = "block";
  };
  const hide = () => { if (_paneTooltipEl) _paneTooltipEl.style.display = "none"; };
  root.addEventListener("mousemove", (e) => {
    const cell = e.target instanceof Element ? e.target.closest(".tree-pane-cell, .tree-docked-pane") : null;
    if (cell) showFor(cell, e.clientX, e.clientY);
    else hide();
  });
  root.addEventListener("mouseleave", hide);
}
