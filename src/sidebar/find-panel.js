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
import { findNodeByFileId } from "../state/tree-helpers.js";
import { decodeNotebookContent } from "../notebook/notebook-content.ts";
import { getCanvasInstance } from "../notebook/notebook-bridge.js";

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
        <label class="find-panel-global-label" title="Apply replacements to every document with matches">
          <input type="checkbox" class="find-panel-global" />
          <span>Global</span>
        </label>
      </div>
      <div class="find-panel-replace-actions">
        <button class="find-panel-replace-btn" type="button" title="Replace the current match in the current document">Replace in Document</button>
        <button class="find-panel-replace-all-btn" type="button" title="Replace every match in every document in scope">Replace in All Documents</button>
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
    // Pull the surrounding line, then trim to ~3 words of leading
    // context and ~8 words of trailing context. Word boundaries are
    // whitespace runs — punctuation rides with the neighbouring word.
    const lineStart = content.lastIndexOf("\n", from - 1) + 1;
    const lineEnd = content.indexOf("\n", to);
    const endIdx = lineEnd === -1 ? content.length : lineEnd;
    const lineText = content.slice(lineStart, endIdx);
    const matchStartInLine = from - lineStart;
    const matchEndInLine = to - lineStart;

    const beforeRaw = lineText.slice(0, matchStartInLine);
    const matchText = lineText.slice(matchStartInLine, matchEndInLine);
    const afterRaw = lineText.slice(matchEndInLine);

    // Preserve whatever whitespace sits flush against the match so the
    // prefix / suffix don't run into the highlighted text on render.
    const trailingWsBefore = beforeRaw.match(/\s*$/)?.[0] ?? "";
    const leadingWsAfter = afterRaw.match(/^\s*/)?.[0] ?? "";

    const { trimmed: prefixBody, truncated: prefixTrimmed } = takeLastWords(beforeRaw.slice(0, beforeRaw.length - trailingWsBefore.length), 3);
    const { trimmed: suffixBody, truncated: suffixTrimmed } = takeFirstWords(afterRaw.slice(leadingWsAfter.length), 8);
    const prefix = prefixBody + trailingWsBefore;
    const suffix = leadingWsAfter + suffixBody;

    let line = 1;
    for (let i = 0; i < lineStart; i++) if (content.charCodeAt(i) === 10) line++;
    return {
      line,
      leading: prefixTrimmed ? "…" : "",
      trailing: suffixTrimmed ? "…" : "",
      prefix, matchText, suffix,
    };
  }

  /** Keep the trailing `n` whitespace-separated tokens of `s`, preserving
   *  the original whitespace that joins them. Returns `{ trimmed, truncated }`
   *  where `truncated` is true if we dropped any leading text. */
  function takeLastWords(s, n) {
    if (!s) return { trimmed: "", truncated: false };
    // Match: optional leading whitespace + one non-whitespace run.
    const tokens = [];
    const re = /\s*\S+/g;
    let m;
    while ((m = re.exec(s)) !== null) tokens.push(m[0]);
    if (tokens.length <= n) return { trimmed: s, truncated: false };
    const kept = tokens.slice(-n).join("").replace(/^\s+/, "");
    return { trimmed: kept, truncated: true };
  }

  function takeFirstWords(s, n) {
    if (!s) return { trimmed: "", truncated: false };
    const tokens = [];
    const re = /\S+\s*/g;
    let m;
    while ((m = re.exec(s)) !== null) tokens.push(m[0]);
    if (tokens.length <= n) return { trimmed: s, truncated: false };
    const kept = tokens.slice(0, n).join("").replace(/\s+$/, "");
    return { trimmed: kept, truncated: true };
  }

  // Walk the active desk's tree and collect every searchable file along
  // with the folder / project ancestors so each result row can show its
  // location underneath the filename. Documents and notebooks are both
  // searchable — notebooks are JSON-decoded so each text shape's body
  // can be matched against the query.
  function collectSearchableFiles() {
    const desks = state.fileTree.filter(n => n.type === "desk");
    const active = desks.find(n => n.id === state.settings?.activeDeskId) || desks[0];
    const rootChildren = active ? (active.children || []) : state.fileTree;
    const out = [];
    function walk(nodes, ancestors) {
      for (const n of nodes) {
        if ((n.type === "document" || n.type === "notebook") && n.fileId && !n.useAsNote) {
          out.push({
            fileId: n.fileId,
            name: n.name || "Untitled",
            kind: n.type,
            pathParts: ancestors.slice(),
          });
        }
        if (n.children && (n.type === "folder" || n.type === "project")) {
          walk(n.children, [...ancestors, n.name || (n.type === "project" ? "Project" : "Folder")]);
        } else if (n.children) {
          walk(n.children, ancestors);
        }
      }
    }
    walk(rootChildren, []);
    return out;
  }

  async function loadContent(fileId) {
    if (fileId === state.currentFileId && state.editor) {
      return state.editor.getContent();
    }
    if (fileId === state.currentNotebookFileId) {
      // Reach into the live canvas so unsaved shape edits show up in
      // results immediately rather than waiting for the next autosave.
      const ci = getCanvasInstance?.();
      if (ci && typeof ci.getShapes === "function") {
        try {
          const shapes = ci.getShapes();
          return JSON.stringify({ format: "hushnote", version: 1, shapes });
        } catch (_) {}
      }
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

  function searchDocFile(info, query, content, isCurrent) {
    const matches = findMatchesIn(content, query).map(m => ({
      ...m,
      snippet: lineAndSnippet(content, m.from, m.to),
    }));
    if (matches.length === 0) return null;
    return {
      fileId: info.fileId,
      name: info.name,
      kind: "document",
      pathParts: info.pathParts,
      isCurrent,
      content,
      matches,
    };
  }

  function searchNotebookFile(info, query, content, isCurrent) {
    let parsed;
    try { parsed = decodeNotebookContent(content); }
    catch (_) { parsed = null; }
    if (!parsed || !Array.isArray(parsed.shapes)) return null;
    const matches = [];
    for (const shape of parsed.shapes) {
      if (!shape || shape.type !== "text" || typeof shape.text !== "string") continue;
      if (shape.headerLabel) continue; // shadow header labels are computed, not user text
      const hits = findMatchesIn(shape.text, query);
      for (const h of hits) {
        matches.push({
          shapeId: shape.id,
          from: h.from,
          to: h.to,
          snippet: lineAndSnippet(shape.text, h.from, h.to),
        });
      }
    }
    if (matches.length === 0) return null;
    return {
      fileId: info.fileId,
      name: info.name,
      kind: "notebook",
      pathParts: info.pathParts,
      isCurrent,
      content,
      matches,
    };
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

    const allFiles = collectSearchableFiles();
    const curDocId = state.currentFileId || null;
    const curNotebookId = state.currentNotebookFileId || null;
    const curId = curDocId || curNotebookId;

    // 1) Current doc / notebook first.
    const currentInfo = allFiles.find(f => f.fileId === curId);
    if (currentInfo) {
      const content = await loadContent(currentInfo.fileId);
      if (token !== searchToken) return;
      const fr = currentInfo.kind === "notebook"
        ? searchNotebookFile(currentInfo, query, content, true)
        : searchDocFile(currentInfo, query, content, true);
      if (fr) fileResults.push(fr);
    }

    // 2) Every other file in the active desk, in tree order.
    for (const info of allFiles) {
      if (info.fileId === curId) continue;
      if (token !== searchToken) return;
      const content = await loadContent(info.fileId);
      if (token !== searchToken) return;
      const fr = info.kind === "notebook"
        ? searchNotebookFile(info, query, content, false)
        : searchDocFile(info, query, content, false);
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
      if (replaceOpen && !globalCheckbox.checked && !fr.isCurrent) sectionClasses.push("find-section-dimmed");
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

  function openReplace() {
    replaceOpen = true;
    replaceRow.hidden = false;
    twirlBtn.setAttribute("aria-expanded", "true");
    twirlArrow.textContent = "▼";
    if (fileResults.length > 0) renderResults();
  }

  function closeReplace() {
    replaceOpen = false;
    replaceRow.hidden = true;
    twirlBtn.setAttribute("aria-expanded", "false");
    twirlArrow.textContent = "▶";
    if (fileResults.length > 0) renderResults();
  }

  async function doReplaceCurrent() {
    if (currentFlat < 0 || flatMatches.length === 0) return;
    const { fileIdx, matchIdx } = flatMatches[currentFlat];
    const fr = fileResults[fileIdx];
    if (!replaceOpen) return;
    if (!globalCheckbox.checked && !fr.isCurrent) return;
    // Notebook replace would require editing shape text + re-serialising
    // the canvas — left out of v1 to keep replace logic local to docs.
    if (fr.kind === "notebook") return;
    const replacement = replaceInput.value;
    const match = fr.matches[matchIdx];
    if (fr.isCurrent) {
      const view = state.editor?.view;
      if (!view) return;
      view.dispatch({ changes: { from: match.from, to: match.to, insert: replacement } });
    } else {
      const newContent = fr.content.slice(0, match.from) + replacement + fr.content.slice(match.to);
      await writeDocContent(fr.fileId, newContent);
    }
    await runSearch();
  }

  async function doReplaceAll() {
    if (fileResults.length === 0) return;
    if (!replaceOpen) return;
    const replacement = replaceInput.value;
    const scope = (globalCheckbox.checked
      ? fileResults
      : fileResults.filter(f => f.isCurrent))
      .filter(f => f.kind !== "notebook");
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
