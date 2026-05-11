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

export function paneIndicatorsFor(item, state) {
  if (!item.fileId) return null;
  if (item.type !== "document" && item.type !== "notebook") return null;
  const ctx = contextIdForFile(item.fileId, item.type);
  const ctxPanes = getPanesForContext(ctx);
  if (!ctxPanes.length) return null;
  const hidden = !!(state.settings?.panesHiddenByContext || {})[ctx];
  const strip = document.createElement("span");
  strip.className = "tree-pane-indicators" + (hidden ? " dimmed" : "");
  for (const p of ctxPanes) {
    const cell = document.createElement("span");
    cell.className = "tree-pane-cell";
    cell.dataset.paneName = p.fileName || "Untitled";
    strip.appendChild(cell);
  }
  return strip;
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
