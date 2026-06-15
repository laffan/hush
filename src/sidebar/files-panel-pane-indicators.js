/**
 * Pane indicator strip painted under each doc/notebook row in the
 * files panel. One small rectangle per floating pane the file owns;
 * cmd-hovering a cell reveals the pane's filename in a small tooltip.
 *
 * When the file's panes are hidden via the command palette
 * (`settings.panesHiddenByContext`), the strip collapses to a thin
 * dim bar so the row signals "this is a desktop, just temporarily
 * tucked away" without taking real vertical space.
 */
import { getPanesForContext, contextIdForFile } from "../pane/pane-manager.js";

function buildStrip(ctxPanes, hidden, inline) {
  const strip = document.createElement("span");
  strip.className = (inline ? "tree-pane-indicators-inline" : "tree-pane-indicators") + (hidden ? " dimmed" : "");
  for (const p of ctxPanes) {
    const cell = document.createElement("span");
    cell.className = "tree-pane-cell";
    cell.dataset.paneName = p.fileName || "Untitled";
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
    if (!docPanes.length) return null;
    return buildStrip(docPanes, !!(state.settings?.panesHiddenByContext || {})[ctx], true);
  }
  if (item.type !== "document" && item.type !== "notebook") return null;
  const ctx = contextIdForFile(item.fileId, item.type);
  // Drop the gutter pane — a gutter never shows a square (its row carries the
  // doc's other panes instead).
  const ctxPanes = getPanesForContext(ctx).filter((p) => !p.gutter);
  if (!ctxPanes.length) return null;
  const hidden = !!(state.settings?.panesHiddenByContext || {})[ctx];
  return buildStrip(ctxPanes, hidden, false);
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
