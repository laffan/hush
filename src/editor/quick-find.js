/**
 * Quick find — an extremely minimal, current-document-only search and
 * replace.
 *
 * Bound to Cmd+F (see `shortcutQuickFind`). Unlike the sidebar Find panel
 * (Cmd+Shift+F), this is a tiny floating input anchored to the focused
 * editor. As you type it highlights every match and automatically selects
 * the first instance at or after the cursor. Cmd+G / Cmd+Shift+G (the
 * find-next / find-prev shortcuts) step through matches, wrapping at the
 * ends. Esc closes and returns focus to the editor.
 *
 * A twirl arrow discloses a second row carrying a replacement and a
 * Confirm button. Confirm rewrites **every** match in the document in
 * one transaction, so the whole replace is a single undo step, and it
 * acts on `activeView` — the surface the bar was opened against. That
 * last part is the substance of the feature, not a detail: this is where
 * per-document replace lives now, having moved out of the desk-wide
 * panel, where it worked one match at a time and always dispatched into
 * the main editor even when a pane held the caret.
 *
 * Highlighting reuses the shared `findHighlightField` decorations
 * (`cm-find-match` / `cm-find-match-current`) so we don't need a second
 * StateField wired into every editor surface.
 */

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setFindHighlights, clearFindHighlights } from "./find-decorations.js";

let activeView = null;
let queryStr = "";
let matches = [];      // [{ from, to }]
let currentIdx = -1;
let barEl = null;
let inputEl = null;
let countEl = null;
let replaceRowEl = null;
let replaceInputEl = null;
let twirlEl = null;
let repositionHandler = null;
let escHandler = null;
// Disclosure state outlives the bar: it's rebuilt from scratch on every
// open, and a user who is replacing tends to keep replacing.
let replaceOpen = false;

export function isQuickFindOpen() {
  return !!barEl && !!activeView;
}

/** Open (or re-focus) the quick-find bar against `view`. */
export function openQuickFind(view) {
  if (!view || !view.dom) return false;
  // If already open on a different editor, move to the new one.
  if (activeView && activeView !== view) clearFindHighlights(activeView);
  activeView = view;

  let seed = "";
  const sel = view.state.selection.main;
  if (sel && !sel.empty) {
    const slice = view.state.sliceDoc(sel.from, sel.to);
    if (slice && !slice.includes("\n")) seed = slice;
  }

  if (!barEl) buildBar();
  inputEl.value = seed;
  queryStr = seed;
  position();
  recompute(/*selectAfterCursor=*/true);
  inputEl.focus();
  inputEl.select();
  return true;
}

export function closeQuickFind() {
  if (activeView) clearFindHighlights(activeView);
  if (barEl) {
    barEl.remove();
    barEl = null; inputEl = null; countEl = null;
    replaceRowEl = null; replaceInputEl = null; twirlEl = null;
  }
  if (repositionHandler) {
    window.removeEventListener("resize", repositionHandler, true);
    window.removeEventListener("scroll", repositionHandler, true);
    repositionHandler = null;
  }
  if (escHandler) {
    document.removeEventListener("keydown", escHandler, true);
    escHandler = null;
  }
  const v = activeView;
  activeView = null;
  matches = [];
  currentIdx = -1;
  queryStr = "";
  if (v) try { v.focus(); } catch (_) {}
}

export function quickFindGoNext() {
  if (!isQuickFindOpen() || matches.length === 0) return false;
  currentIdx = (currentIdx + 1) % matches.length;
  applyCurrent();
  return true;
}

export function quickFindGoPrev() {
  if (!isQuickFindOpen() || matches.length === 0) return false;
  currentIdx = (currentIdx - 1 + matches.length) % matches.length;
  applyCurrent();
  return true;
}

function buildBar() {
  barEl = document.createElement("div");
  barEl.className = "quick-find-bar";

  // Row 1 — the find field, unchanged apart from the twirl at its head.
  const findRow = document.createElement("div");
  findRow.className = "quick-find-row";
  twirlEl = document.createElement("button");
  twirlEl.type = "button";
  twirlEl.className = "quick-find-twirl";
  twirlEl.setAttribute("aria-label", "Show replace");
  twirlEl.innerHTML = `<span class="quick-find-twirl-arrow">▶</span>`;
  twirlEl.addEventListener("click", (e) => {
    e.preventDefault();
    setReplaceOpen(!replaceOpen);
    // The disclosure is a detour on the way to typing a replacement, so
    // land the caret where the user is heading.
    (replaceOpen ? replaceInputEl : inputEl).focus();
  });
  inputEl = document.createElement("input");
  inputEl.type = "text";
  inputEl.className = "quick-find-input";
  inputEl.placeholder = "Find";
  inputEl.spellcheck = false;
  countEl = document.createElement("span");
  countEl.className = "quick-find-count";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "quick-find-close";
  closeBtn.setAttribute("aria-label", "Close find");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => closeQuickFind());
  findRow.appendChild(twirlEl);
  findRow.appendChild(inputEl);
  findRow.appendChild(countEl);
  findRow.appendChild(closeBtn);

  // Row 2 — the replacement. Spans the bar's full width like the row
  // above it, with Confirm parked against the right edge.
  replaceRowEl = document.createElement("div");
  replaceRowEl.className = "quick-find-row quick-find-replace-row";
  replaceRowEl.hidden = true;
  replaceInputEl = document.createElement("input");
  replaceInputEl.type = "text";
  replaceInputEl.className = "quick-find-input quick-find-replace-input";
  replaceInputEl.placeholder = "Replace";
  replaceInputEl.spellcheck = false;
  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "quick-find-confirm";
  confirmBtn.textContent = "Confirm";
  confirmBtn.title = "Replace every match in this document";
  confirmBtn.addEventListener("click", (e) => { e.preventDefault(); replaceAllInDocument(); });
  replaceRowEl.appendChild(replaceInputEl);
  replaceRowEl.appendChild(confirmBtn);

  replaceInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeQuickFind(); return; }
    if (e.key === "Enter") { e.preventDefault(); replaceAllInDocument(); }
  });

  barEl.appendChild(findRow);
  barEl.appendChild(replaceRowEl);
  document.body.appendChild(barEl);
  setReplaceOpen(replaceOpen);

  inputEl.addEventListener("input", () => {
    queryStr = inputEl.value;
    recompute(/*selectAfterCursor=*/true);
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeQuickFind();
    } else if (e.key === "Enter") {
      // Forward Enter is the "I'm done, drop me at this match" exit —
      // close the bar and leave the cursor parked on the currently
      // selected hit. Shift+Enter keeps the historic step-backwards
      // behaviour for users who want to walk back through matches.
      e.preventDefault();
      if (e.shiftKey) { quickFindGoPrev(); return; }
      commitAndClose();
    } else if (e.key === "ArrowRight" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Right arrow at the end of the input acts like a forward Enter:
      // close the bar and drop the cursor at the current match. When
      // the caret isn't at the end of the input we let the keystroke
      // through so it still moves through the query text.
      const caret = inputEl.selectionStart;
      const len = inputEl.value.length;
      if (caret === len && inputEl.selectionEnd === len) {
        e.preventDefault();
        commitAndClose();
      }
    } else if ((e.metaKey || e.ctrlKey) && (e.key === "g" || e.key === "G")) {
      // Cmd+G fires while the input is focused — handle it here since the
      // editor keymap won't see the keystroke.
      e.preventDefault();
      if (e.shiftKey) quickFindGoPrev(); else quickFindGoNext();
    }
  });

  repositionHandler = () => position();
  window.addEventListener("resize", repositionHandler, true);
  window.addEventListener("scroll", repositionHandler, true);

  // Global Escape — even if focus has drifted to the editor (e.g. the
  // user clicked into the doc to verify the match), Escape should still
  // dismiss the bar. Captured at the document level so it wins before
  // any editor extension swallows the key.
  escHandler = (e) => {
    if (e.key === "Escape" && barEl) {
      e.preventDefault();
      e.stopPropagation();
      closeQuickFind();
    }
  };
  document.addEventListener("keydown", escHandler, true);
}

/** Show or hide the replace row and point the twirl at its state.
 *  Re-positions the bar afterwards: growing it by a row changes its
 *  height, and `position()` centres it on the editor from its own
 *  measured box. */
function setReplaceOpen(open) {
  replaceOpen = !!open;
  if (!barEl) return;
  replaceRowEl.hidden = !replaceOpen;
  barEl.classList.toggle("replace-open", replaceOpen);
  twirlEl.setAttribute("aria-expanded", replaceOpen ? "true" : "false");
  twirlEl.setAttribute("aria-label", replaceOpen ? "Hide replace" : "Show replace");
  const arrow = twirlEl.querySelector(".quick-find-twirl-arrow");
  if (arrow) arrow.textContent = replaceOpen ? "▼" : "▶";
  position();
}

/**
 * Rewrite every match in the document the bar is attached to.
 *
 * One dispatch, not one per match: CodeMirror maps a change set's own
 * offsets for us, so the whole replace collapses to a single undo step
 * and no offset has to be adjusted for the edits ahead of it. Matches
 * are non-overlapping by construction (`recompute` advances past each
 * hit), which is what makes them legal as one change set.
 *
 * The search then re-runs against the rewritten text, so the count
 * settles on whatever the replacement itself matches — replacing "in"
 * with "into" leaves the hits it just created visible rather than
 * quietly looping over them.
 */
function replaceAllInDocument() {
  if (!activeView || matches.length === 0) return false;
  const insert = replaceInputEl ? replaceInputEl.value : "";
  activeView.dispatch({
    changes: matches.map((m) => ({ from: m.from, to: m.to, insert })),
  });
  // Offsets are stale the instant the document changes — rebuild from
  // the new text rather than mapping the old hits forward.
  recompute(/*selectAfterCursor=*/true);
  return true;
}

function position() {
  if (!barEl || !activeView) return;
  // Center horizontally over the editor and drop the bar to the same
  // vertical slot as the Google Docs link pill (sync bar) — both clear
  // the iOS status bar / Dynamic Island via env(safe-area-inset-top)
  // and land just below it. The previous top-right anchor collided
  // with the iPadOS Control Center pull-down area.
  const r = activeView.dom.getBoundingClientRect();
  const barW = barEl.getBoundingClientRect().width || 224;
  const centerX = r.left + (r.width / 2) - (barW / 2);
  barEl.style.left = `${Math.max(8, centerX)}px`;
  // Clear `right` in case an old positioning attempt left it set.
  barEl.style.right = "";
  // Vertical slot mirrors `.gdoc-link-bar`: env(safe-area-inset-top) + 6 px.
  barEl.style.top = `calc(env(safe-area-inset-top, 0px) + 6px)`;
}

/** Move the editor cursor to the currently-selected match (already
 *  done by `applyCurrent()`), then dismiss the bar. */
function commitAndClose() {
  // applyCurrent() has already dispatched a selection at the active
  // match, so closing leaves the cursor parked there.
  closeQuickFind();
}

function recompute(selectAfterCursor) {
  if (!activeView) return;
  matches = [];
  if (!queryStr) {
    currentIdx = -1;
    clearFindHighlights(activeView);
    updateCount();
    return;
  }
  const text = activeView.state.doc.toString();
  const hay = text.toLowerCase();
  const needle = queryStr.toLowerCase();
  let i = 0;
  while (true) {
    const idx = hay.indexOf(needle, i);
    if (idx === -1) break;
    matches.push({ from: idx, to: idx + queryStr.length });
    i = idx + Math.max(1, queryStr.length);
  }
  if (matches.length === 0) {
    currentIdx = -1;
    clearFindHighlights(activeView);
    updateCount();
    return;
  }
  if (selectAfterCursor) {
    const cursor = activeView.state.selection.main.from;
    const found = matches.findIndex((m) => m.from >= cursor);
    currentIdx = found === -1 ? 0 : found;
  } else if (currentIdx < 0 || currentIdx >= matches.length) {
    currentIdx = 0;
  }
  applyCurrent();
}

function applyCurrent() {
  if (!activeView) return;
  const m = matches[currentIdx];
  if (!m) { updateCount(); return; }
  // Select the match in the editor (focus stays in the input so the user
  // can keep refining the query) and scroll it to the vertical centre so the
  // active hit lands somewhere the reader's eye is already aiming.
  activeView.dispatch({
    selection: EditorSelection.single(m.from, m.to),
    effects: EditorView.scrollIntoView(m.from, { y: "center" }),
  });
  setFindHighlights(activeView, matches, currentIdx);
  updateCount();
}

function updateCount() {
  if (!countEl) return;
  if (!queryStr) { countEl.textContent = ""; return; }
  if (matches.length === 0) { countEl.textContent = "0/0"; return; }
  countEl.textContent = `${currentIdx + 1}/${matches.length}`;
}
