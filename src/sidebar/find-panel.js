/**
 * Find panel — occupies the left sidebar, replacing the file list.
 *
 * Cmd+F mounts this panel via `state.emit("show-find-panel", { initialQuery })`.
 * The current document's matches are listed first, followed by other docs
 * in the active desk (each with a header + count). Clicking a match opens
 * the file and scrolls to the hit. A twirl arrow reveals the replace input;
 * "global replace" toggles whether replacement applies beyond the current doc.
 */

import { setFindHighlights, clearFindHighlights } from "../editor/find-decorations.js";
import { collectDocumentIds, findNodeByFileId } from "../state/tree-helpers.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

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
        <span class="find-panel-twirl-arrow">▸</span>
      </button>
      <input type="text" class="find-panel-input" placeholder="Find" spellcheck="false" />
      <div class="find-panel-toggles">
        <button class="find-panel-toggle" data-mode="case" type="button" title="Match Case">Aa</button>
        <button class="find-panel-toggle" data-mode="word" type="button" title="Whole Word">Ww</button>
        <button class="find-panel-toggle" data-mode="regex" type="button" title="Regular Expression">.*</button>
      </div>
    </div>
    <div class="find-panel-replace-row" hidden>
      <input type="text" class="find-panel-replace-input" placeholder="Replace" spellcheck="false" />
      <label class="find-panel-global-label" title="Apply replacements to every document with matches">
        <input type="checkbox" class="find-panel-global" />
        <span>Global</span>
      </label>
      <button class="find-panel-replace-btn" type="button" title="Replace current match">Replace</button>
      <button class="find-panel-replace-all-btn" type="button" title="Replace all matches in scope">All</button>
    </div>
    <div class="find-panel-status"></div>
    <div class="find-panel-results"></div>
  `;
  container.appendChild(root);

  const closeBtn = root.querySelector(".find-panel-close");
  const twirlBtn = root.querySelector(".find-panel-twirl");
  const twirlArrow = root.querySelector(".find-panel-twirl-arrow");
  const findInput = root.querySelector(".find-panel-input");
  const replaceRow = root.querySelector(".find-panel-replace-row");
  const replaceInput = root.querySelector(".find-panel-replace-input");
  const globalCheckbox = root.querySelector(".find-panel-global");
  const replaceBtn = root.querySelector(".find-panel-replace-btn");
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

  function activeFileId() {
    return state.currentFileId || null;
  }

  function buildRegex(query) {
    let flags = caseSensitive ? "g" : "gi";
    let pattern;
    if (useRegex) {
      pattern = query;
    } else {
      pattern = escapeRegExp(query);
      if (wholeWord) pattern = `\\b${pattern}\\b`;
    }
    return new RegExp(pattern, flags);
  }

  function findMatchesIn(content, query) {
    const matches = [];
    if (!content || !query) return matches;
    let re;
    try { re = buildRegex(query); } catch (_) { return matches; }
    let m;
    let guard = 0;
    while ((m = re.exec(content)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      matches.push({ from: m.index, to: m.index + m[0].length });
      if (++guard > 50000) break;
    }
    return matches;
  }

  function lineAndSnippet(content, from, to) {
    // Find the start of the line containing `from`.
    const lineStart = content.lastIndexOf("\n", from - 1) + 1;
    const lineEnd = content.indexOf("\n", to);
    const endIdx = lineEnd === -1 ? content.length : lineEnd;
    const lineText = content.slice(lineStart, endIdx);
    const matchStartInLine = from - lineStart;
    const matchEndInLine = to - lineStart;
    // Trim wide lines to ~80 chars centered on the match, preserving the
    // hit so we can render context before/after with the match emphasized.
    const targetLen = 80;
    let snipStart = 0;
    let snipEnd = lineText.length;
    if (lineText.length > targetLen) {
      const half = Math.floor(targetLen / 2);
      snipStart = Math.max(0, matchStartInLine - half);
      snipEnd = Math.min(lineText.length, snipStart + targetLen);
      snipStart = Math.max(0, snipEnd - targetLen);
    }
    const prefix = lineText.slice(snipStart, matchStartInLine);
    const matchText = lineText.slice(matchStartInLine, matchEndInLine);
    const suffix = lineText.slice(matchEndInLine, snipEnd);
    // Compute 1-based line number by counting newlines before lineStart.
    let line = 1;
    for (let i = 0; i < lineStart; i++) if (content.charCodeAt(i) === 10) line++;
    return {
      line,
      leading: snipStart > 0 ? "…" : "",
      trailing: snipEnd < lineText.length ? "…" : "",
      prefix, matchText, suffix,
    };
  }

  function isSearchableDocNode(node) {
    if (!node) return false;
    if (node.type !== "document") return false;
    if (!node.fileId) return false;
    return true;
  }

  function getActiveDeskDocFileIds() {
    const desks = state.fileTree.filter(n => n.type === "desk");
    const active = desks.find(n => n.id === state.settings?.activeDeskId) || desks[0];
    const children = active ? (active.children || []) : state.fileTree;
    return collectDocumentIds(children);
  }

  async function loadContent(fileId) {
    if (fileId === state.currentFileId && state.editor) {
      return state.editor.getContent();
    }
    if (IS_TAURI) {
      try {
        const file = await tauriInvoke("load_file", { id: fileId });
        return file?.content || "";
      } catch (_) { return ""; }
    }
    const f = state.files.find(x => x.id === fileId);
    return f ? f.content : "";
  }

  function fileDisplayName(fileId) {
    const node = findNodeByFileId(state.fileTree, fileId);
    if (node?.name) return node.name;
    const f = state.files.find(x => x.id === fileId);
    return f?.name || "Untitled";
  }

  async function runSearch() {
    const query = findInput.value;
    const token = ++searchToken;
    fileResults = [];
    flatMatches = [];
    currentFlat = -1;

    if (!query) {
      statusEl.textContent = "";
      resultsEl.innerHTML = "";
      pushHighlightsToEditor();
      return;
    }

    // 1) Current document (if any) — always shown first.
    const curId = activeFileId();
    if (curId) {
      const content = state.editor ? state.editor.getContent() : await loadContent(curId);
      const matches = findMatchesIn(content, query).map(m => ({
        ...m,
        snippet: lineAndSnippet(content, m.from, m.to),
      }));
      if (matches.length > 0) {
        fileResults.push({
          fileId: curId,
          name: fileDisplayName(curId),
          isCurrent: true,
          content,
          matches,
        });
      }
    }

    // 2) Other docs in the active desk. Loaded sequentially to keep
    //    memory + Tauri load pressure modest; abort if a newer search
    //    has superseded ours.
    const docIds = getActiveDeskDocFileIds().filter(id => id !== curId);
    for (const id of docIds) {
      if (token !== searchToken) return;
      const content = await loadContent(id);
      if (token !== searchToken) return;
      const matches = findMatchesIn(content, query).map(m => ({
        ...m,
        snippet: lineAndSnippet(content, m.from, m.to),
      }));
      if (matches.length > 0) {
        fileResults.push({
          fileId: id,
          name: fileDisplayName(id),
          isCurrent: false,
          content,
          matches,
        });
      }
    }

    // Build flat match index.
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
      const headerLabel = fr.isCurrent ? "Current document" : escHtml(fr.name);
      const sectionClass = fr.isCurrent ? "find-section find-section-current" : "find-section";
      const dimmed = (replaceOpen && !globalCheckbox.checked && !fr.isCurrent) ? " find-section-dimmed" : "";
      html += `<div class="${sectionClass}${dimmed}" data-file-idx="${fi}">`;
      html += `<div class="find-section-header">`;
      html += `<span class="find-section-name">${headerLabel}</span>`;
      if (!fr.isCurrent) {
        html += `<span class="find-section-filename">${escHtml(fr.name)}</span>`;
      }
      html += `<span class="find-section-count">${fr.matches.length}</span>`;
      html += `</div>`;
      html += `<div class="find-section-matches">`;
      for (let mi = 0; mi < fr.matches.length; mi++) {
        const s = fr.matches[mi].snippet;
        html += `<div class="find-match" data-file-idx="${fi}" data-match-idx="${mi}">`;
        html += `<span class="find-match-line">${s.line}</span>`;
        html += `<span class="find-match-text">`;
        html += `${escHtml(s.leading)}${escHtml(s.prefix)}<mark>${escHtml(s.matchText)}</mark>${escHtml(s.suffix)}${escHtml(s.trailing)}`;
        html += `</span></div>`;
      }
      html += `</div></div>`;
    }
    resultsEl.innerHTML = html;
    highlightActiveResult();
    resultsEl.querySelectorAll(".find-match").forEach(el => {
      el.addEventListener("click", () => {
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

  /** Push highlights to the active editor for the currently-active doc. */
  function pushHighlightsToEditor() {
    const view = state.editor?.view;
    if (!view) return;
    const curId = activeFileId();
    const fr = fileResults.find(f => f.fileId === curId);
    if (!fr) { clearFindHighlights(view); return; }
    // Compute which (if any) flat-match is the "current" within this file.
    let currentInFile = -1;
    if (currentFlat >= 0) {
      const cur = flatMatches[currentFlat];
      const idx = fileResults.findIndex(f => f.fileId === curId);
      if (cur.fileIdx === idx) currentInFile = cur.matchIdx;
    }
    setFindHighlights(view, fr.matches.map(m => ({ from: m.from, to: m.to })), currentInFile);
  }

  function scrollCurrentMatchInEditor() {
    const view = state.editor?.view;
    if (!view || currentFlat < 0) return;
    const { fileIdx, matchIdx } = flatMatches[currentFlat];
    const fr = fileResults[fileIdx];
    if (!fr || fr.fileId !== activeFileId()) return;
    const m = fr.matches[matchIdx];
    view.dispatch({
      selection: { anchor: m.from, head: m.to },
      scrollIntoView: true,
    });
  }

  // Set true while we're driving `state.openFile` ourselves so the
  // `file-opened` listener doesn't kick off a redundant whole-desk
  // re-search (which would also reset `currentFlat` to 0).
  let suppressNextFileOpened = false;

  async function jumpToFlat(flat, openIfNeeded) {
    if (flat < 0 || flat >= flatMatches.length) return;
    currentFlat = flat;
    const { fileIdx } = flatMatches[flat];
    const target = fileResults[fileIdx];
    if (openIfNeeded && target.fileId !== activeFileId()) {
      suppressNextFileOpened = true;
      await state.openFile(target.fileId);
      // After the editor swaps, push highlights and scroll.
      setTimeout(() => {
        pushHighlightsToEditor();
        scrollCurrentMatchInEditor();
        updateStatus();
        highlightActiveResult();
        suppressNextFileOpened = false;
      }, 50);
    } else {
      pushHighlightsToEditor();
      scrollCurrentMatchInEditor();
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

  function openReplace() {
    replaceOpen = true;
    replaceRow.hidden = false;
    twirlBtn.setAttribute("aria-expanded", "true");
    twirlArrow.textContent = "▾";
    if (fileResults.length > 0) renderResults();
  }

  function closeReplace() {
    replaceOpen = false;
    replaceRow.hidden = true;
    twirlBtn.setAttribute("aria-expanded", "false");
    twirlArrow.textContent = "▸";
    if (fileResults.length > 0) renderResults();
  }

  async function doReplaceCurrent() {
    if (currentFlat < 0 || flatMatches.length === 0) return;
    const { fileIdx, matchIdx } = flatMatches[currentFlat];
    const fr = fileResults[fileIdx];
    if (!replaceOpen) return;
    if (!globalCheckbox.checked && !fr.isCurrent) return;
    const replacement = replaceInput.value;
    const match = fr.matches[matchIdx];
    if (fr.isCurrent) {
      // Apply via editor so undo + dirty tracking flow normally.
      const view = state.editor?.view;
      if (!view) return;
      view.dispatch({ changes: { from: match.from, to: match.to, insert: replacement } });
    } else {
      // Patch the saved doc content directly. Requires Tauri (web build
      // shares the in-memory copy of every file).
      const newContent = fr.content.slice(0, match.from) + replacement + fr.content.slice(match.to);
      await writeDocContent(fr.fileId, newContent);
    }
    await runSearch();
  }

  async function doReplaceAll() {
    if (fileResults.length === 0) return;
    if (!replaceOpen) return;
    const replacement = replaceInput.value;
    const scope = globalCheckbox.checked
      ? fileResults
      : fileResults.filter(f => f.isCurrent);
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
        await writeDocContent(fr.fileId, buf);
      }
    }
    await runSearch();
  }

  async function writeDocContent(fileId, content) {
    if (IS_TAURI) {
      try { await tauriInvoke("save_file", { id: fileId, content }); }
      catch (e) { console.error("Find replace save failed:", e); return; }
      try {
        state.files = await tauriInvoke("list_files");
        state.syncFileToExternal?.(fileId, content);
      } catch (_) {}
    } else {
      const f = state.files.find(x => x.id === fileId);
      if (f) {
        f.content = content;
        f.modified = Math.floor(Date.now() / 1000);
        state._saveFilesLocal?.();
      }
    }
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
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) doReplaceAll(); else doReplaceCurrent();
    }
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

  globalCheckbox.addEventListener("change", () => {
    if (fileResults.length > 0) renderResults();
  });

  replaceBtn.addEventListener("click", () => doReplaceCurrent());
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

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
