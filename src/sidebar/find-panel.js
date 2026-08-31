/**
 * Find panel — occupies the left sidebar, replacing the file list.
 *
 * Cmd+Shift+F mounts this panel via `state.emit("show-find-panel", …)`.
 * Current doc's matches list first, then the rest of the active desk under
 * filename + path headers. A twirl arrow reveals the replace input, whose
 * one button rewrites every match in every document listed below it.
 *
 * Replace here is deliberately whole-desk only. A per-document replace
 * used to sit beside it (a second button, plus a "Global" checkbox that
 * scoped this one) and was the weaker half: it acted on one match at a
 * time and always against the main editor, so with a doc pane focused it
 * wrote to the wrong surface. Single-document replace now lives in the
 * ⌘F bar (`editor/quick-find.js`), which is already bound to the surface
 * the user is reading.
 *
 * Pure search / snippet logic lives in `find-panel-search.js`; tree
 * walking, content loading, and per-kind search adapters live in
 * `find-panel-sources.js`. This module owns the UI, event wiring, and
 * the replace dispatch.
 */

import { setFindHighlights, clearFindHighlights } from "../editor/find-decorations.js";
import { getCanvasInstance } from "../notebook/notebook-bridge.js";
import { escHtml } from "./find-panel-search.js";
import {
  collectSearchableFiles, loadContent, writeDocContent,
  searchDocFile, searchNotebookFile,
} from "./find-panel-sources.js";

// Module-level handles so the Cmd+G / Cmd+Shift+G shortcuts can drive
// the panel while it's open. Reset on close.
let panelHandles = null;

export function isFindPanelOpen() {
  return !!panelHandles;
}

export function findPanelGoNext() {
  if (panelHandles?.goNext) { panelHandles.goNext(); return true; }
  return false;
}

export function findPanelGoPrev() {
  if (panelHandles?.goPrev) { panelHandles.goPrev(); return true; }
  return false;
}

export function closeFindPanel() {
  if (panelHandles?.close) panelHandles.close();
}

/**
 * Mount the find panel into the given container (the sidebar body).
 * Returns a `{ destroy }` handle the caller (sidebar) can use to tear down.
 */
export function createFindPanel(container, state, onClose, opts = {}) {
  container.innerHTML = "";

  const root = document.createElement("div");
  root.className = "find-panel";
  root.innerHTML = `
    <div class="find-panel-toolbar">
      <button class="find-panel-close" type="button" title="Close (Esc)" aria-label="Close find">&times;</button>
      <button class="find-panel-twirl" type="button" title="Show replace" aria-expanded="false">
        <span class="find-panel-twirl-arrow">▶</span>
      </button>
      <input type="text" class="find-panel-input" placeholder="Find" spellcheck="false" />
      <div class="find-panel-toggles">
        <button class="find-panel-toggle" data-mode="case" type="button" title="Match Case">Aa</button>
        <button class="find-panel-toggle" data-mode="word" type="button" title="Whole Word">Ww</button>
        <button class="find-panel-toggle" data-mode="regex" type="button" title="Regular Expression">.*</button>
      </div>
    </div>
    <div class="find-panel-replace-wrap" hidden>
      <div class="find-panel-replace-row">
        <input type="text" class="find-panel-replace-input" placeholder="Replace" spellcheck="false" />
      </div>
      <div class="find-panel-replace-actions">
        <button class="find-panel-replace-all-btn" type="button" title="Replace every match in every document listed below">Replace in All Documents</button>
      </div>
    </div>
    <div class="find-panel-status"></div>
    <div class="find-panel-results"></div>
  `;
  container.appendChild(root);

  const closeBtn = root.querySelector(".find-panel-close");
  const twirlBtn = root.querySelector(".find-panel-twirl");
  const twirlArrow = root.querySelector(".find-panel-twirl-arrow");
  const findInput = root.querySelector(".find-panel-input");
  const replaceRow = root.querySelector(".find-panel-replace-wrap");
  const replaceInput = root.querySelector(".find-panel-replace-input");
  const replaceAllBtn = root.querySelector(".find-panel-replace-all-btn");
  const statusEl = root.querySelector(".find-panel-status");
  const resultsEl = root.querySelector(".find-panel-results");
  const toggleBtns = root.querySelectorAll(".find-panel-toggle");

  let caseSensitive = false;
  let wholeWord = false;
  let useRegex = false;
  let replaceOpen = false;
  // `fileResults` is the ordered list of files with matches. The current
  // doc (if it has any) is always index 0 and gets a "Current document"
  // header; the rest get their filename. Each entry:
  //   { fileId, name, isCurrent, content, matches: [{from,to,line,snippet}] }
  let fileResults = [];
  // Flat index of [{fileIdx, matchIdx}] for keyboard navigation across the
  // entire result set (current doc first, then others).
  let flatMatches = [];
  let currentFlat = -1;
  let searchToken = 0;

  function searchOpts() {
    return { caseSensitive, wholeWord, useRegex };
  }

  async function runSearch() {
    const query = findInput.value;
    const token = ++searchToken;
    const preservedFold = new Map(fileResults.map(f => [f.fileId, !!f.collapsed]));
    fileResults = [];
    flatMatches = [];
    currentFlat = -1;

    if (!query) {
      statusEl.textContent = "";
      resultsEl.innerHTML = "";
      pushHighlightsToEditor();
      return;
    }

    const allFiles = collectSearchableFiles(state);
    const opts = searchOpts();
    const curDocId = state.currentFileId || null;
    const curNotebookId = state.currentNotebookFileId || null;
    const curId = curDocId || curNotebookId;

    // 1) Current doc / notebook first.
    const currentInfo = allFiles.find(f => f.fileId === curId);
    if (currentInfo) {
      const content = await loadContent(state, currentInfo.fileId);
      if (token !== searchToken) return;
      const fr = currentInfo.kind === "notebook"
        ? searchNotebookFile(currentInfo, query, content, true, opts)
        : searchDocFile(currentInfo, query, content, true, opts);
      if (fr) fileResults.push(fr);
    }

    // 2) Every other file in the active desk, in tree order.
    for (const info of allFiles) {
      if (info.fileId === curId) continue;
      if (token !== searchToken) return;
      const content = await loadContent(state, info.fileId);
      if (token !== searchToken) return;
      const fr = info.kind === "notebook"
        ? searchNotebookFile(info, query, content, false, opts)
        : searchDocFile(info, query, content, false, opts);
      if (fr) fileResults.push(fr);
    }

    // Restore per-file collapsed state where applicable.
    for (const fr of fileResults) {
      if (preservedFold.has(fr.fileId)) fr.collapsed = preservedFold.get(fr.fileId);
    }

    // Build flat match index (skipping collapsed sections so nav follows
    // what's visible).
    for (let i = 0; i < fileResults.length; i++) {
      const f = fileResults[i];
      for (let j = 0; j < f.matches.length; j++) {
        flatMatches.push({ fileIdx: i, matchIdx: j });
      }
    }
    currentFlat = flatMatches.length > 0 ? 0 : -1;

    renderResults();
    updateStatus();
    pushHighlightsToEditor();
    scrollCurrentMatchInEditor();
  }

  function updateStatus() {
    const total = flatMatches.length;
    const files = fileResults.length;
    if (!findInput.value) { statusEl.textContent = ""; return; }
    if (total === 0) { statusEl.textContent = "No results"; return; }
    const pos = currentFlat >= 0 ? `${currentFlat + 1} of ${total}` : `${total}`;
    statusEl.textContent = `${pos} in ${files} ${files === 1 ? "file" : "files"}`;
  }

  function renderResults() {
    if (fileResults.length === 0) {
      resultsEl.innerHTML = "";
      return;
    }
    let html = "";
    for (let fi = 0; fi < fileResults.length; fi++) {
      const fr = fileResults[fi];
      const sectionClasses = ["find-section"];
      if (fr.isCurrent) sectionClasses.push("find-section-current");
      if (fr.collapsed) sectionClasses.push("collapsed");
      const pathStr = fr.pathParts && fr.pathParts.length
        ? fr.pathParts.join(" › ")
        : (fr.kind === "notebook" ? "Notebook" : "Document");
      const foldArrow = fr.collapsed ? "▶" : "▼";
      html += `<div class="${sectionClasses.join(" ")}" data-file-idx="${fi}">`;
      html += `<div class="find-section-header" data-file-idx="${fi}">`;
      html += `<button class="find-section-fold" type="button" aria-label="Toggle">${foldArrow}</button>`;
      html += `<div class="find-section-meta">`;
      html += `<span class="find-section-name">${escHtml(fr.name)}</span>`;
      html += `<span class="find-section-path">${escHtml(pathStr)}</span>`;
      html += `</div>`;
      html += `<span class="find-section-count">${fr.matches.length}</span>`;
      html += `</div>`;
      html += `<div class="find-section-matches">`;
      for (let mi = 0; mi < fr.matches.length; mi++) {
        const s = fr.matches[mi].snippet;
        html += `<div class="find-match" data-file-idx="${fi}" data-match-idx="${mi}">`;
        html += `<span class="find-match-text">`;
        html += `${escHtml(s.leading)}${escHtml(s.prefix)}<mark>${escHtml(s.matchText)}</mark>${escHtml(s.suffix)}${escHtml(s.trailing)}`;
        html += `</span></div>`;
      }
      html += `</div></div>`;
    }
    resultsEl.innerHTML = html;
    highlightActiveResult();
    resultsEl.querySelectorAll(".find-section-header").forEach(headerEl => {
      headerEl.addEventListener("click", (e) => {
        // Fold button (or any header click) toggles the section.
        e.stopPropagation();
        const fi = parseInt(headerEl.dataset.fileIdx, 10);
        const fr = fileResults[fi];
        if (!fr) return;
        fr.collapsed = !fr.collapsed;
        renderResults();
      });
    });
    resultsEl.querySelectorAll(".find-match").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const fi = parseInt(el.dataset.fileIdx, 10);
        const mi = parseInt(el.dataset.matchIdx, 10);
        const flat = flatMatches.findIndex(x => x.fileIdx === fi && x.matchIdx === mi);
        if (flat >= 0) jumpToFlat(flat, true);
      });
    });
  }

  function highlightActiveResult() {
    resultsEl.querySelectorAll(".find-match.active").forEach(el => el.classList.remove("active"));
    if (currentFlat < 0) return;
    const { fileIdx, matchIdx } = flatMatches[currentFlat];
    const el = resultsEl.querySelector(`.find-match[data-file-idx="${fileIdx}"][data-match-idx="${matchIdx}"]`);
    if (el) {
      el.classList.add("active");
      el.scrollIntoView({ block: "nearest" });
    }
  }

  /** Push highlights to the active editor — only meaningful when a
   *  document is open. Notebooks render via the canvas and don't use
   *  the editor's decoration pipeline. */
  function pushHighlightsToEditor() {
    const view = state.editor?.view;
    if (!view) return;
    const curId = state.currentFileId || null;
    const fr = curId ? fileResults.find(f => f.fileId === curId && f.kind === "document") : null;
    if (!fr) { clearFindHighlights(view); return; }
    let currentInFile = -1;
    if (currentFlat >= 0) {
      const cur = flatMatches[currentFlat];
      const idx = fileResults.findIndex(f => f.fileId === curId && f.kind === "document");
      if (cur.fileIdx === idx) currentInFile = cur.matchIdx;
    }
    setFindHighlights(view, fr.matches.map(m => ({ from: m.from, to: m.to })), currentInFile);
  }

  function scrollCurrentMatchInEditor() {
    if (currentFlat < 0) return;
    const { fileIdx, matchIdx } = flatMatches[currentFlat];
    const fr = fileResults[fileIdx];
    if (!fr || !currentTargetIsOpen(fr)) return;
    focusMatchInTarget(fr, fr.matches[matchIdx]);
  }

  // Set true while we're driving `state.openFile` ourselves so the
  // `file-opened` listener doesn't kick off a redundant whole-desk
  // re-search (which would also reset `currentFlat` to 0).
  let suppressNextFileOpened = false;

  function currentTargetIsOpen(target) {
    if (target.kind === "notebook") return target.fileId === state.currentNotebookFileId;
    return target.fileId === state.currentFileId;
  }

  async function openTarget(target) {
    if (target.kind === "notebook") {
      if (typeof state.openNotebook === "function") {
        await state.openNotebook(target.fileId);
      }
    } else {
      await state.openFile(target.fileId);
    }
  }

  function focusMatchInTarget(target, match) {
    if (target.kind === "notebook") {
      const ci = getCanvasInstance?.();
      if (ci && typeof ci.state?.focusShape === "function" && match.shapeId) {
        try { ci.state.focusShape(match.shapeId); } catch (_) {}
      }
      return;
    }
    const view = state.editor?.view;
    if (!view) return;
    view.dispatch({
      selection: { anchor: match.from, head: match.to },
      scrollIntoView: true,
    });
  }

  async function waitForTargetReady(target, timeoutMs = 600) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (target.kind === "notebook") {
        const ci = getCanvasInstance?.();
        if (ci && ci.state && Array.isArray(ci.getShapes?.()) &&
            ci.getShapes().some(s => s.id === target.matches[0]?.shapeId)) {
          return;
        }
      } else {
        if (state.currentFileId === target.fileId && state.editor) return;
      }
      await new Promise(r => setTimeout(r, 30));
    }
  }

  async function jumpToFlat(flat, openIfNeeded) {
    if (flat < 0 || flat >= flatMatches.length) return;
    currentFlat = flat;
    const { fileIdx, matchIdx } = flatMatches[flat];
    const target = fileResults[fileIdx];
    const match = target.matches[matchIdx];
    if (openIfNeeded && !currentTargetIsOpen(target)) {
      suppressNextFileOpened = true;
      await openTarget(target);
      // Notebook mount + canvas hydration race the click — poll until the
      // target shape is reachable before trying to focus it.
      await waitForTargetReady(target);
      pushHighlightsToEditor();
      focusMatchInTarget(target, match);
      updateStatus();
      highlightActiveResult();
      suppressNextFileOpened = false;
    } else {
      pushHighlightsToEditor();
      focusMatchInTarget(target, match);
      updateStatus();
      highlightActiveResult();
    }
  }

  function goNext() {
    if (flatMatches.length === 0) return;
    jumpToFlat((currentFlat + 1) % flatMatches.length, true);
  }

  function goPrev() {
    if (flatMatches.length === 0) return;
    jumpToFlat((currentFlat - 1 + flatMatches.length) % flatMatches.length, true);
  }

  function applyToggleState() {
    toggleBtns.forEach(btn => {
      const m = btn.dataset.mode;
      const on = (m === "case" && caseSensitive) || (m === "word" && wholeWord) || (m === "regex" && useRegex);
      btn.classList.toggle("active", on);
    });
  }

  // Neither of these repaints the results any more: the only thing the
  // disclosure used to change about them was dimming the files a
  // current-document-only replace wouldn't touch, and there is no such
  // scope left to signal.
  function openReplace() {
    replaceOpen = true;
    replaceRow.hidden = false;
    twirlBtn.setAttribute("aria-expanded", "true");
    twirlArrow.textContent = "▼";
    replaceInput.focus();
  }

  function closeReplace() {
    replaceOpen = false;
    replaceRow.hidden = true;
    twirlBtn.setAttribute("aria-expanded", "false");
    twirlArrow.textContent = "▶";
  }

  // Desk-wide replace is all-or-nothing by design. Narrowing it to the
  // current document used to live here as a second button (and a
  // "Global" checkbox that scoped this one), but a single-document
  // replace belongs where the user is reading that document — it's now
  // the ⌘F bar's own replace row (`editor/quick-find.js`), which acts on
  // the focused surface. This button does exactly what it says.
  async function doReplaceAll() {
    if (fileResults.length === 0) return;
    if (!replaceOpen) return;
    const replacement = replaceInput.value;
    // Notebook replace would require editing shape text + re-serialising
    // the canvas — left out to keep replace logic local to docs.
    const scope = fileResults.filter(f => f.kind !== "notebook");
    for (const fr of scope) {
      const sorted = fr.matches.slice().sort((a, b) => a.from - b.from);
      if (fr.isCurrent) {
        const view = state.editor?.view;
        if (!view) continue;
        const changes = sorted.slice().reverse().map(m => ({ from: m.from, to: m.to, insert: replacement }));
        view.dispatch({ changes });
      } else {
        let buf = fr.content;
        for (let i = sorted.length - 1; i >= 0; i--) {
          buf = buf.slice(0, sorted[i].from) + replacement + buf.slice(sorted[i].to);
        }
        await writeDocContent(state, fr.fileId, buf);
      }
    }
    await runSearch();
  }

  // --- Wiring --------------------------------------------------------
  closeBtn.addEventListener("click", () => doClose());
  twirlBtn.addEventListener("click", () => { replaceOpen ? closeReplace() : openReplace(); });

  let searchTimer = null;
  findInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 120);
  });
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); doClose(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goPrev(); else goNext();
    }
  });
  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); doClose(); return; }
    if (e.key === "Enter") { e.preventDefault(); doReplaceAll(); }
  });

  toggleBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const m = btn.dataset.mode;
      if (m === "case") caseSensitive = !caseSensitive;
      else if (m === "word") wholeWord = !wholeWord;
      else if (m === "regex") useRegex = !useRegex;
      applyToggleState();
      runSearch();
    });
  });

  replaceAllBtn.addEventListener("click", () => doReplaceAll());

  function onFileOpened() {
    if (suppressNextFileOpened) return;
    // Re-anchor the "current document" block on the newly opened doc.
    if (findInput.value) runSearch();
  }
  state.on("file-opened", onFileOpened);

  function doClose() {
    state.off("file-opened", onFileOpened);
    const view = state.editor?.view;
    if (view) clearFindHighlights(view);
    panelHandles = null;
    if (typeof onClose === "function") onClose();
  }

  // Seed initial state.
  applyToggleState();
  const initial = opts.initialQuery || "";
  if (initial) findInput.value = initial;
  findInput.focus();
  if (initial) {
    findInput.select();
    runSearch();
  }

  panelHandles = {
    goNext, goPrev,
    close: doClose,
    focus: () => findInput.focus(),
    setQuery: (q) => { findInput.value = q; runSearch(); },
  };

  return { destroy: doClose };
}
