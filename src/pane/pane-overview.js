/**
 * The Overview for a docked doc pane — the same panel the main editor
 * keeps in `#right-panel-overlay`, built over the pane's own editor and
 * mounted inside the pane's content box, against its right edge. ⌘⇧\
 * toggles it while that pane is the active one (main.js).
 *
 * The panel lives in the pane rather than beside it: a docked pane is
 * already carved out of the window by the dock module, and a second bar
 * outside it would have to renegotiate that geometry with every other
 * dock. Inside, it only has to take its width off the editor.
 */
import { createOverview } from "../overview/overview.js";

export function hasPaneOverview(pane) {
  return !!pane?._overview;
}

export function closePaneOverview(pane) {
  const ov = pane?._overview;
  if (!ov) return;
  pane._overview = null;
  try { ov.instance.destroy(); } catch (_) {}
  ov.el.remove();
  pane.el?.classList.remove("has-overview");
}

export function togglePaneOverview(pane, state) {
  if (!pane?.editor?.view || !pane._content) return false;
  if (pane._overview) { closePaneOverview(pane); return true; }
  const el = document.createElement("div");
  el.className = "fp-overview";
  // Clicks in the panel mustn't reach the pane's content handlers, and
  // a press on a row mustn't pull focus out of the pane's editor first.
  el.addEventListener("mousedown", (e) => e.stopPropagation());
  pane._content.appendChild(el);
  pane.el.classList.add("has-overview");
  const instance = createOverview(el, state, { getView: () => pane.editor?.view || null });
  pane._overview = { el, instance };
  instance.render();
  return true;
}
