/**
 * Pane + sticky indicator strip painted under each doc/notebook row in
 * the files panel. One small outlined rectangle per floating pane the
 * file owns, followed by one small filled square per File Sticky
 * attached to it; cmd-hovering a cell reveals the pane's filename (or
 * the sticky's excerpt) in a small tooltip.
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

function buildStrip(ctxPanes, stickies, hidden, inline) {
  const strip = document.createElement("span");
  strip.className = inline ? "tree-pane-indicators-inline" : "tree-pane-indicators";
  for (const p of ctxPanes) {
    const cell = document.createElement("span");
    cell.className = "tree-pane-cell" + (hidden ? " dimmed" : "");
    cell.dataset.paneName = p.fileName || "Untitled";
    strip.appendChild(cell);
  }
  for (const s of stickies) {
    const cell = document.createElement("span");
    cell.className = "tree-pane-cell tree-sticky-cell";
    const excerpt = (s.text || "").trim().split("\n")[0].slice(0, 42);
    cell.dataset.paneName = excerpt || "Sticky";
    strip.appendChild(cell);
  }
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
    const docPanes = getPanesForContext(ctx).filter((p) => !p.gutter);
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
    const cell = e.target instanceof Element ? e.target.closest(".tree-pane-cell") : null;
    if (cell && e.metaKey) showFor(cell, e.clientX, e.clientY);
    else hide();
  });
  root.addEventListener("mouseleave", hide);
}
