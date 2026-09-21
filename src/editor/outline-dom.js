/**
 * Outline chrome for a Doc — the footer, and the rows the pinned panel
 * paints.
 *
 * Shared by the two places an outline shows its footer: the block widget
 * that sits under an in-flow outline, and the panel a pinned outline
 * docks to the bottom of the editor. They are different surfaces (one is
 * a CodeMirror widget inside the document, the other is chrome outside
 * it) but the same two toggles, so the buttons are built once here.
 */

import { applyTooltip } from "../tooltips.js";
import { firstOpenIndex, stripInlineMarkdown } from "../outline/outline-model.ts";

/** Hide-completed: a checkbox with a stroke through it. */
const ICON_HIDE_DONE =
  '<svg viewBox="0 0 16 16" aria-hidden="true">'
  + '<rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/>'
  + '<path d="M5 8.4 L7.2 10.6 L11 5.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<path class="outline-icon-slash" d="M3 13 L13 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
  + '</svg>';

/** Pin-to-bottom: an arrow coming down onto a bar. */
const ICON_PIN_BOTTOM =
  '<svg viewBox="0 0 16 16" aria-hidden="true">'
  + '<path d="M8 2 V9.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
  + '<path d="M5 6.8 L8 9.8 L11 6.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<path d="M3 13 H13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
  + '</svg>';

function makeToggle(icon, label, active, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "outline-footer-btn" + (active ? " active" : "");
  btn.innerHTML = icon;
  btn.setAttribute("aria-pressed", active ? "true" : "false");
  btn.setAttribute("aria-label", label);
  applyTooltip(btn, label);
  // Commit on pointerdown: a press inside the editor moves focus, and a
  // widget torn down on that blur would never see the click. Same rule
  // the spellcheck popover learned the hard way (README-TECHNICAL).
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.detail === 0) onClick(); // keyboard activation only
  });
  return btn;
}

/**
 * The footer strip: a count on the left, the two toggles on the right.
 *
 * @param {object} o
 * @param {number} o.done      completed item count
 * @param {number} o.total     item count
 * @param {boolean} o.hideDone
 * @param {boolean} o.pinned
 * @param {() => void} o.onToggleHideDone
 * @param {() => void} o.onTogglePin
 */
export function buildOutlineFooter(o) {
  const footer = document.createElement("div");
  footer.className = "outline-footer";

  const count = document.createElement("span");
  count.className = "outline-footer-count";
  count.textContent = o.total ? `${o.done}/${o.total}` : "";
  footer.appendChild(count);

  const spacer = document.createElement("span");
  spacer.className = "outline-footer-spacer";
  footer.appendChild(spacer);

  footer.appendChild(makeToggle(
    ICON_HIDE_DONE,
    o.hideDone ? "Show completed items" : "Hide completed items",
    o.hideDone, o.onToggleHideDone,
  ));
  footer.appendChild(makeToggle(
    ICON_PIN_BOTTOM,
    o.pinned ? "Unpin from bottom" : "Pin to bottom",
    o.pinned, o.onTogglePin,
  ));
  return footer;
}

/**
 * The pinned panel's body: one row per item, indented by depth, with a
 * live checkbox.
 *
 * The rows are chrome, not document text — CodeMirror only renders the
 * lines near the scroll position, so an outline pinned to the frame has
 * to be drawn outside `.cm-content` or it would simply vanish the moment
 * the user scrolled away from it, which is the one thing a pinned
 * outline must not do.
 *
 * @param {import("../outline/outline-model.ts").OutlineItem[]} items
 * @param {boolean} hideDone
 * @param {(item) => void} onToggle
 */
export function buildOutlineRows(items, hideDone, onToggle) {
  const list = document.createElement("div");
  list.className = "outline-rows";
  const nextIdx = firstOpenIndex(items);
  const baseDepth = items.reduce((m, it) => Math.min(m, it.depth), Infinity) || 0;

  items.forEach((item, i) => {
    if (hideDone && item.checked) return;
    const row = document.createElement("div");
    row.className = "outline-row"
      + (item.checked ? " outline-row-done" : "")
      + (i === nextIdx ? " outline-row-next" : "");
    row.style.setProperty("--outline-depth", String(Math.max(0, item.depth - baseDepth)));

    const box = document.createElement("span");
    box.className = "cm-task-checkbox outline-row-box" + (item.checked ? " checked" : "");
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", item.checked ? "true" : "false");
    box.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onToggle(item);
    });
    row.appendChild(box);

    const label = document.createElement("span");
    label.className = "outline-row-text";
    label.textContent = stripInlineMarkdown(item.text);
    row.appendChild(label);

    list.appendChild(row);
  });
  return list;
}
