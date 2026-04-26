/**
 * Native-`title` tooltip gating. The user's "Show Tooltips" setting flips
 * native browser tooltips on or off across the app — sidebar buttons,
 * pane header buttons, and notebook toolbar buttons all consult the same
 * setting.
 *
 * Implementation: every gated element stashes its label on `data-tooltip`.
 * When tooltips are enabled we mirror that to the `title` attribute (so
 * the browser shows the tooltip on hover); when disabled we strip it.
 *
 * The sidebar uses its own custom-styled tooltip (see sidebar.js); it
 * gates on the same setting but doesn't go through this module — its
 * tooltips don't rely on the `title` attribute.
 */

let _enabled = false;

/** Apply enable/disable globally. Walks the DOM once to add or strip
 *  `title` attributes on every element that previously called
 *  `applyTooltip`. */
export function setTooltipsEnabled(enabled) {
  _enabled = !!enabled;
  document.body.classList.toggle("tooltips-on", _enabled);
  for (const el of document.querySelectorAll("[data-tooltip]")) {
    if (_enabled) el.title = el.dataset.tooltip;
    else el.removeAttribute("title");
  }
}

/** Mark `el` as tooltip-bearing with `label`. Stashes the label on
 *  `data-tooltip` so future toggles can find it; sets the live `title`
 *  attribute only when tooltips are currently enabled. Pass `null`/empty
 *  to clear. */
export function applyTooltip(el, label) {
  if (!el) return;
  if (!label) {
    delete el.dataset.tooltip;
    el.removeAttribute("title");
    return;
  }
  el.dataset.tooltip = label;
  if (_enabled) el.title = label;
  else el.removeAttribute("title");
}

export function tooltipsEnabled() { return _enabled; }
