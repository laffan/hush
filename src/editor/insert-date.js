/**
 * Insert Date / Insert Date-Time — drop the current date (or date + time)
 * at the cursor of whatever editing surface is in focus.
 *
 * Formats (matching the user's examples):
 *   Date       → "September 27, 1983", or any of DATE_FORMATS, picked
 *                from a sub-list the palette swaps in
 *   Date-Time  → "4:30pm Sept 27, 1983"
 *
 * Routing mirrors the touch-mode Paste helper: a focused input/textarea
 * (the notebook's inline text editor lands here) gets a direct
 * setRangeText; otherwise the active CodeMirror view — the focused pane
 * or stack column if one owns the active mode context, else the main
 * editor — receives an insert transaction. This is the same view
 * resolution the fold commands use, so "current context" stays
 * consistent across doc / pane / stack surfaces.
 */

import { getActiveModeContext } from "../state/mode-context.js";

const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
// "Sept" (not the bare "Sep" Intl produces) per the requested example.
const MONTHS_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sept", "Oct", "Nov", "Dec",
];

/** "September 27, 1983" */
export function formatDate(d) {
  return `${MONTHS_FULL[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** The shapes Insert Date offers, in the order the picker lists them.
 *  Month and day are never zero-padded ("2026-9-29", not "2026-09-29"). */
export const DATE_FORMATS = [
  { id: "long", format: formatDate },
  { id: "ymd", format: (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` },
  { id: "month-day", format: (d) => `${MONTHS_ABBR[d.getMonth()]} ${d.getDate()}` },
  { id: "yy-m-d", format: (d) => `${String(d.getFullYear() % 100).padStart(2, "0")}-${d.getMonth() + 1}-${d.getDate()}` },
];

/** "4:30pm Sept 27, 1983" — 12-hour clock, minutes zero-padded, am/pm
 *  lowercase and flush against the time. */
export function formatDateTime(d) {
  let h = d.getHours();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12;
  if (h === 0) h = 12;
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${mm}${ampm} ${MONTHS_ABBR[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Insert `text` at the cursor of the focused input/textarea, firing an
 *  input event so change listeners (notebook shape commit, autosave)
 *  run. */
function insertIntoInput(el, text) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  if (typeof el.setRangeText === "function") {
    el.setRangeText(text, start, end, "end");
  } else {
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + text.length;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Route `text` into the current editing context. Returns true when it
 *  landed somewhere. */
export function insertTextIntoCurrentContext(state, text) {
  const el = document.activeElement;

  // Focused input / textarea — the notebook inline text editor, or any
  // form field. The palette hands focus back to the notebook textarea
  // on close, so this catches an active text-shape edit.
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    insertIntoInput(el, text);
    return true;
  }

  // Active CodeMirror view: focused pane / stack column, else the main
  // editor (skipped in notebook mode, where the main editor is a stale
  // hidden surface). Insert at the primary selection and place the caret
  // after the inserted text.
  const view = getActiveModeContext(state)?.view
    || (!state.currentNotebookFileId ? state.editor?.view : null);
  if (view) {
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
      scrollIntoView: true,
      userEvent: "input.type",
    });
    view.focus();
    return true;
  }

  // A focused contenteditable that isn't the resolved CM view (rare) —
  // last-ditch execCommand insert.
  if (el && el.isContentEditable) {
    try { document.execCommand("insertText", false, text); return true; } catch (_) {}
  }
  return false;
}

export function insertDate(state) {
  insertTextIntoCurrentContext(state, formatDate(new Date()));
}

/** Swap the palette's list for one row per DATE_FORMATS entry, each
 *  labelled with today's date in that shape, so the row is its own
 *  preview. Picking one closes the palette and inserts it like
 *  `insertDate` does; the long form stays first, so Enter twice is the
 *  command's old behaviour. */
export function enterDateFormatPicker(palette, state, icon) {
  const now = new Date();
  const items = DATE_FORMATS.map((f) => {
    const text = f.format(now);
    return {
      id: "insert-date-" + f.id, label: text, icon, shortcutKey: null,
      action: () => insertTextIntoCurrentContext(state, text),
    };
  });
  palette.setItems(items, "Insert date as…");
}

export function insertDateTime(state) {
  insertTextIntoCurrentContext(state, formatDateTime(new Date()));
}
