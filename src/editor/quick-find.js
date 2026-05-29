/**
 * Quick find — an extremely minimal, current-document-only search.
 *
 * Bound to Cmd+F (see `shortcutQuickFind`). Unlike the sidebar Find panel
 * (Cmd+Shift+F), this is a tiny floating input anchored to the focused
 * editor. As you type it highlights every match and automatically selects
 * the first instance at or after the cursor. Cmd+G / Cmd+Shift+G (the
 * find-next / find-prev shortcuts) step through matches, wrapping at the
 * ends. Esc closes and returns focus to the editor.
 *
 * Highlighting reuses the shared `findHighlightField` decorations
 * (`cm-find-match` / `cm-find-match-current`) so we don't need a second
 * StateField wired into every editor surface.
 */

import { EditorSelection } from "@codemirror/state";
import { setFindHighlights, clearFindHighlights } from "./find-decorations.js";

let activeView = null;
let queryStr = "";
let matches = [];      // [{ from, to }]
let currentIdx = -1;
let barEl = null;
let inputEl = null;
let countEl = null;
let repositionHandler = null;

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
  if (barEl) { barEl.remove(); barEl = null; inputEl = null; countEl = null; }
  if (repositionHandler) {
    window.removeEventListener("resize", repositionHandler, true);
    window.removeEventListener("scroll", repositionHandler, true);
    repositionHandler = null;
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
  inputEl = document.createElement("input");
  inputEl.type = "text";
  inputEl.className = "quick-find-input";
  inputEl.placeholder = "Find";
  inputEl.spellcheck = false;
  countEl = document.createElement("span");
  countEl.className = "quick-find-count";
  barEl.appendChild(inputEl);
  barEl.appendChild(countEl);
  document.body.appendChild(barEl);

  inputEl.addEventListener("input", () => {
    queryStr = inputEl.value;
    recompute(/*selectAfterCursor=*/true);
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeQuickFind();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) quickFindGoPrev(); else quickFindGoNext();
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
}

function position() {
  if (!barEl || !activeView) return;
  const r = activeView.dom.getBoundingClientRect();
  // Top-right corner of the editor, nudged in so it clears the scrollbar.
  barEl.style.top = `${Math.max(8, r.top + 8)}px`;
  barEl.style.left = `${Math.min(window.innerWidth - 240, r.right - 232)}px`;
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
  // can keep refining the query) and scroll it into view.
  activeView.dispatch({
    selection: EditorSelection.single(m.from, m.to),
    scrollIntoView: true,
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
