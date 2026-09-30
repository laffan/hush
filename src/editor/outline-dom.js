/**
 * Outline chrome for a Doc — the footer, and the one row Zen Focus shows.
 *
 * Shared by the two places an outline shows its footer: the block widget
 * that sits under an in-flow outline, and the panel a pinned outline
 * docks to the bottom of the editor. They are different surfaces (one is
 * a CodeMirror widget inside the document, the other is chrome outside
 * the pinned outline's own editor) but the same controls, so the
 * buttons are built once here.
 */

import { applyTooltip } from "../tooltips.js";
import { firstOpenIndex, stripInlineMarkdown } from "../outline/outline-model.ts";

/** Bounds of the footer's − / + (`outlineFontStep`, px off the default). */
export const OUTLINE_FONT_STEP_MIN = -6;
export const OUTLINE_FONT_STEP_MAX = 16;

/** Publish the outline type step for both outline surfaces — the in-flow
 *  lines and the pinned panel read `--outline-font-size`, which is built
 *  on it (styles/outline.css). One property on <html>: the setting is per
 *  device, not per document, so every outline on screen takes it. */
export function applyOutlineFontStep(step) {
  const n = Number(step);
  const px = Number.isFinite(n) ? Math.max(OUTLINE_FONT_STEP_MIN, Math.min(OUTLINE_FONT_STEP_MAX, Math.round(n))) : 0;
  document.documentElement.style.setProperty("--outline-font-step", `${px}px`);
}

/**
 * Hide-completed: a box with a stroke through it.
 *
 * The box held a tick until the stroke was looked at closely — the
 * tick's long arm runs up-right at 45 degrees and so does the stroke, so
 * at the 14px this renders at they landed on each other and the icon
 * read as a plain ticked box. The tick is gone and the box is smaller,
 * which leaves the stroke running clear past both corners. The canvas
 * footer (`drawOutlineIcon`, notebook/renderer.ts) is drawn to match.
 */
const ICON_HIDE_DONE =
  '<svg viewBox="0 0 16 16" aria-hidden="true">'
  + '<rect x="4" y="4" width="8" height="8" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/>'
  + '<path class="outline-icon-slash" d="M2.4 13.6 L13.6 2.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
  + '</svg>';

/** Pin-to-bottom: an arrow coming down onto a bar. */
const ICON_PIN_BOTTOM =
  '<svg viewBox="0 0 16 16" aria-hidden="true">'
  + '<path d="M8 2 V9.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
  + '<path d="M5 6.8 L8 9.8 L11 6.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<path d="M3 13 H13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
  + '</svg>';

function makeToggle(icon, label, active, onClick) {
  const btn = makeButton(icon, label, onClick);
  if (active) btn.classList.add("active");
  btn.setAttribute("aria-pressed", active ? "true" : "false");
  return btn;
}

function makeButton(icon, label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "outline-footer-btn";
  btn.innerHTML = icon;
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
 * The footer strip: the type size's − / + on the left, the two toggles
 * on the right. It deliberately carries no tally — an outline already
 * says how much is left by how much of it isn't struck through, and a
 * second reading of the same fact is noise on a surface this small.
 *
 * @param {object} o
 * @param {boolean} o.hideDone
 * @param {boolean} o.pinned
 * @param {() => void} o.onToggleHideDone
 * @param {() => void} o.onTogglePin
 * @param {(delta: number) => void} [o.onFontStep]
 */
export function buildOutlineFooter(o) {
  const footer = document.createElement("div");
  footer.className = "outline-footer";

  if (o.onFontStep) {
    const smaller = makeButton("\u2212", "Smaller text", () => o.onFontStep(-1));
    const larger = makeButton("+", "Larger text", () => o.onFontStep(1));
    smaller.classList.add("outline-footer-size");
    larger.classList.add("outline-footer-size");
    footer.append(smaller, larger);
  }

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
 * The one row Zen Focus shows: the current item, pinned to the top of
 * the window.
 *
 * Zen's bottom third is a gradient curtain painted over everything in
 * the overlay, so the pinned panel's usual home is exactly where it
 * cannot be read — and a whole outline would be clutter in a mode whose
 * point is one line at a time. What survives the trip is the one thing
 * that still matters while writing: what you are meant to be doing.
 * Returns null when nothing is left to do.
 *
 * @param {import("../outline/outline-model.ts").OutlineItem[]} items
 * @param {(item) => void} onToggle
 */
export function buildOutlineZenStrip(items, onToggle) {
  const idx = firstOpenIndex(items);
  if (idx < 0) return null;
  const item = items[idx];

  const strip = document.createElement("div");
  strip.className = "outline-zen-strip";

  const row = document.createElement("div");
  row.className = "outline-row outline-row-next";

  const box = document.createElement("span");
  box.className = "cm-task-checkbox outline-row-box";
  box.setAttribute("role", "checkbox");
  box.setAttribute("aria-checked", "false");
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

  strip.appendChild(row);
  return strip;
}
