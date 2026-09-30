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
import { GRIP_ICON } from "./outline-move.js";

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
 * The pinned panel's body: one row per item, indented by depth, with a
 * live checkbox, a grip to drag it by and text that can be edited where
 * it stands.
 *
 * The rows are chrome, not document text — CodeMirror only renders the
 * lines near the scroll position, so an outline pinned to the frame has
 * to be drawn outside `.cm-content` or it would simply vanish the moment
 * the user scrolled away from it, which is the one thing a pinned
 * outline must not do. Every edit made here goes straight back into the
 * document through `h`, which is what keeps the two one outline.
 *
 * A row shows its item with the inline markdown taken off; the raw text
 * goes into the field while it is being edited, so what is typed is what
 * is stored.
 *
 * @param {import("../outline/outline-model.ts").OutlineItem[]} items
 * @param {boolean} hideDone
 * @param {object} h
 * @param {(item) => void} h.onToggle
 * @param {(item, text: string) => void} [h.onEdit]
 * @param {(item, e: KeyboardEvent, label: HTMLElement) => boolean} [h.onKey]
 *   A key in an item's text; true when it was handled.
 * @param {(index: number, e: PointerEvent, row: HTMLElement) => void} [h.onDragStart]
 * @param {() => void} [h.onBlur]
 */
export function buildOutlineRows(items, hideDone, h) {
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
    row.dataset.index = String(i);
    row.style.setProperty("--outline-depth", String(Math.max(0, item.depth - baseDepth)));

    if (h.onDragStart) {
      const grip = document.createElement("span");
      grip.className = "outline-row-handle";
      grip.innerHTML = GRIP_ICON;
      grip.setAttribute("aria-hidden", "true");
      grip.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
      grip.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        h.onDragStart(i, e, row);
      });
      row.appendChild(grip);
    }

    const box = document.createElement("span");
    box.className = "cm-task-checkbox outline-row-box" + (item.checked ? " checked" : "");
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", item.checked ? "true" : "false");
    box.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      h.onToggle(item);
    });
    row.appendChild(box);

    const label = document.createElement("span");
    label.className = "outline-row-text";
    label.dataset.line = String(item.line);
    label.textContent = stripInlineMarkdown(item.text);
    if (h.onEdit) makeEditable(label, item, h);
    row.appendChild(label);

    list.appendChild(row);
  });
  return list;
}

/** Turn a row's label into a one-line text field over its item. */
function makeEditable(label, item, h) {
  label.contentEditable = "plaintext-only";
  label.spellcheck = false;
  label.addEventListener("focus", () => {
    if (label.dataset.raw === "1") return;
    label.dataset.raw = "1";
    // The stored text only differs from what the row shows when it
    // carries markdown; then the caret can't be mapped across the swap,
    // so it goes to the end.
    if (label.textContent !== item.text) {
      label.textContent = item.text;
      placeCaret(label, item.text.length);
    }
  });
  label.addEventListener("input", () => {
    h.onEdit(item, (label.textContent || "").replace(/[\r\n]+/g, " "));
  });
  label.addEventListener("keydown", (e) => {
    // A key the row acts on stops here. Everything else goes on: the
    // window-level fallback already leaves an editable target's keys
    // alone, apart from the ones meant to work anywhere (⌘P, ⌘O, the
    // panel toggles).
    if (h.onKey && h.onKey(item, e, label)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  label.addEventListener("blur", () => { h.onBlur?.(); });
}

/** Caret offset inside a row's label (its one text node). */
export function caretOffset(label) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !label.contains(sel.anchorNode)) return (label.textContent || "").length;
  const r = sel.getRangeAt(0).cloneRange();
  r.selectNodeContents(label);
  r.setEnd(sel.anchorNode, sel.anchorOffset);
  return r.toString().length;
}

function placeCaret(label, offset) {
  const sel = window.getSelection();
  if (!sel) return;
  const node = label.firstChild;
  const range = document.createRange();
  if (node && node.nodeType === 3) {
    range.setStart(node, Math.max(0, Math.min(offset, node.length)));
  } else {
    range.setStart(label, 0);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Put the caret back into the row for document line `line` after the
 *  rows were rebuilt, in raw-text form, at `offset`. */
export function focusRowText(list, line, offset, rawText) {
  const label = list.querySelector(`.outline-row-text[data-line="${line}"]`);
  if (!label) return false;
  label.dataset.raw = "1";
  label.textContent = rawText;
  label.focus({ preventScroll: true });
  placeCaret(label, offset);
  // Scroll the rows by hand: `scrollIntoView` also scrolls every
  // `overflow: hidden` box above the panel — a stack column's among
  // them (README-TECHNICAL, Platform gotchas).
  const lr = list.getBoundingClientRect();
  const r = label.getBoundingClientRect();
  if (r.top < lr.top) list.scrollTop -= lr.top - r.top;
  else if (r.bottom > lr.bottom) list.scrollTop += r.bottom - lr.bottom;
  return true;
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
