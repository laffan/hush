/**
 * Find & Replace UI for the editor.
 * - Cmd+F: find/replace within current file
 * - Cmd+Shift+F: find across all files
 * - Cmd+G / Cmd+Shift+G: next/prev match (when find bar is open)
 */

let findBar = null;
let findState = { matches: [], currentMatch: -1, goNext: null, goPrev: null };

export function openFindReplace(view, state) {
  if (findBar) {
    const input = findBar.querySelector(".find-input");
    if (input) input.focus();
    return;
  }

  const sel = view.state.selection.main;
  const initialQuery = sel.empty ? "" : view.state.sliceDoc(sel.from, sel.to);

  let caseSensitive = false;
  let useRegex = false;

  findBar = document.createElement("div");
  findBar.className = "find-bar";
  findBar.innerHTML = `
    <div class="find-bar-row">
      <input type="text" class="find-input" placeholder="Find..." value="${escAttr(initialQuery)}" />
      <div class="find-toggle-group">
        <button class="find-toggle" data-mode="case" title="Match Case">Aa</button>
        <button class="find-toggle" data-mode="regex" title="Use Regular Expression">.*</button>
      </div>
      <button class="find-btn find-prev" title="Previous (${modKey}+Shift+G)">&#9650;</button>
      <button class="find-btn find-next" title="Next (${modKey}+G)">&#9660;</button>
      <span class="find-count"></span>
      <button class="find-btn find-close" title="Close (Esc)">&times;</button>
    </div>
    <div class="find-bar-row">
      <input type="text" class="replace-input" placeholder="Replace..." />
      <button class="find-btn replace-one" title="Replace">Replace</button>
      <button class="find-btn replace-all" title="Replace All">All</button>
    </div>
  `;

  document.body.appendChild(findBar);

  const findInput = findBar.querySelector(".find-input");
  const replaceInput = findBar.querySelector(".replace-input");
  const countEl = findBar.querySelector(".find-count");
  const caseSensitiveBtn = findBar.querySelector('[data-mode="case"]');
  const regexBtn = findBar.querySelector('[data-mode="regex"]');
  let matches = [];
  let currentMatch = -1;

  function search() {
    const query = findInput.value;
    matches = [];
    if (!query) {
      countEl.textContent = "";
      currentMatch = -1;
      updateFindState();
      return;
    }
    const doc = view.state.doc.toString();
    try {
      if (useRegex) {
        const flags = caseSensitive ? "g" : "gi";
        const re = new RegExp(query, flags);
        let m;
        while ((m = re.exec(doc)) !== null) {
          if (m[0].length === 0) { re.lastIndex++; continue; }
          matches.push({ from: m.index, to: m.index + m[0].length });
        }
      } else {
        if (caseSensitive) {
          let idx = 0;
          while ((idx = doc.indexOf(query, idx)) !== -1) {
            matches.push({ from: idx, to: idx + query.length });
            idx += 1;
          }
        } else {
          const lowerDoc = doc.toLowerCase();
          const lowerQuery = query.toLowerCase();
          let idx = 0;
          while ((idx = lowerDoc.indexOf(lowerQuery, idx)) !== -1) {
            matches.push({ from: idx, to: idx + lowerQuery.length });
            idx += 1;
          }
        }
      }
    } catch (_) {
      // Invalid regex — show no results
    }
    countEl.textContent = matches.length > 0 ? `${matches.length} found` : "No results";
    if (matches.length > 0) {
      const cursorPos = view.state.selection.main.head;
      currentMatch = 0;
      for (let i = 0; i < matches.length; i++) {
        if (matches[i].from >= cursorPos) { currentMatch = i; break; }
      }
      goToMatch(view);
    } else {
      currentMatch = -1;
    }
    updateFindState();
  }

  function goToMatch(v) {
    if (currentMatch < 0 || currentMatch >= matches.length) return;
    const m = matches[currentMatch];
    v.dispatch({
      selection: { anchor: m.from, head: m.to },
      scrollIntoView: true,
    });
    countEl.textContent = `${currentMatch + 1} / ${matches.length}`;
  }

  function goNext() {
    if (matches.length === 0) return;
    currentMatch = (currentMatch + 1) % matches.length;
    goToMatch(view);
  }

  function goPrev() {
    if (matches.length === 0) return;
    currentMatch = (currentMatch - 1 + matches.length) % matches.length;
    goToMatch(view);
  }

  function updateFindState() {
    findState.matches = matches;
    findState.currentMatch = currentMatch;
    findState.goNext = goNext;
    findState.goPrev = goPrev;
  }

  // Toggle buttons
  caseSensitiveBtn.addEventListener("click", () => {
    caseSensitive = !caseSensitive;
    caseSensitiveBtn.classList.toggle("active", caseSensitive);
    search();
  });

  regexBtn.addEventListener("click", () => {
    useRegex = !useRegex;
    regexBtn.classList.toggle("active", useRegex);
    search();
  });

  findInput.addEventListener("input", search);

  findBar.querySelector(".find-next").addEventListener("click", goNext);
  findBar.querySelector(".find-prev").addEventListener("click", goPrev);

  findBar.querySelector(".replace-one").addEventListener("click", () => {
    if (currentMatch < 0 || currentMatch >= matches.length) return;
    const m = matches[currentMatch];
    const replacement = replaceInput.value;
    view.dispatch({ changes: { from: m.from, to: m.to, insert: replacement } });
    search();
  });

  findBar.querySelector(".replace-all").addEventListener("click", () => {
    if (matches.length === 0) return;
    const replacement = replaceInput.value;
    const changes = matches.slice().reverse().map(m => ({
      from: m.from, to: m.to, insert: replacement,
    }));
    view.dispatch({ changes });
    search();
  });

  findBar.querySelector(".find-close").addEventListener("click", closeFindBar);

  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFindBar();
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goPrev(); else goNext();
    }
  });

  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFindBar();
  });

  findInput.focus();
  if (initialQuery) search();
}

/** Navigate to next match via Cmd+G (called from editor keymap) */
export function findNext() {
  if (findBar && findState.goNext) {
    findState.goNext();
    return true;
  }
  return false;
}

/** Navigate to prev match via Cmd+Shift+G (called from editor keymap) */
export function findPrev() {
  if (findBar && findState.goPrev) {
    findState.goPrev();
    return true;
  }
  return false;
}

function closeFindBar() {
  if (findBar) {
    findBar.remove();
    findBar = null;
    findState = { matches: [], currentMatch: -1, goNext: null, goPrev: null };
  }
}

// Platform-aware modifier key label
const modKey = navigator.platform?.includes("Mac") ? "\u2318" : "Ctrl";

// ===== Find Across Files =====
let findAllPanel = null;

export function openFindAll(view, state) {
  if (findAllPanel) {
    const input = findAllPanel.querySelector(".find-all-input");
    if (input) input.focus();
    return;
  }

  const sel = view.state.selection.main;
  const initialQuery = sel.empty ? "" : view.state.sliceDoc(sel.from, sel.to);

  findAllPanel = document.createElement("div");
  findAllPanel.className = "find-all-panel";
  findAllPanel.innerHTML = `
    <div class="find-all-header">
      <input type="text" class="find-all-input" placeholder="Search across files..." value="${escAttr(initialQuery)}" />
      <button class="find-btn find-close" title="Close">&times;</button>
    </div>
    <div class="find-all-results"></div>
  `;

  document.body.appendChild(findAllPanel);

  const input = findAllPanel.querySelector(".find-all-input");
  const resultsEl = findAllPanel.querySelector(".find-all-results");

  async function searchAll() {
    const query = input.value.trim();
    if (!query) {
      resultsEl.innerHTML = "";
      return;
    }

    let html = "";
    for (const file of state.files) {
      let content = "";
      if (file.id === state.currentFileId && state.editor) {
        content = state.editor.getContent();
      } else {
        const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
        if (IS_TAURI) {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            const loaded = await invoke("load_file", { id: file.id });
            content = loaded.content;
          } catch (_) { continue; }
        } else {
          const localFile = state.files.find(f => f.id === file.id);
          content = localFile ? localFile.content : "";
        }
      }

      const lines = content.split("\n");
      const matchLines = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(query.toLowerCase())) {
          matchLines.push({ line: i + 1, text: lines[i].trim() });
        }
      }

      if (matchLines.length > 0) {
        html += `<div class="find-all-file" data-id="${file.id}">
          <div class="find-all-filename">${escHtml(file.name)} (${matchLines.length})</div>
          ${matchLines.slice(0, 10).map(m =>
            `<div class="find-all-match" data-id="${file.id}" data-line="${m.line}">
              <span class="find-all-line-num">${m.line}</span>
              <span class="find-all-line-text">${escHtml(m.text.slice(0, 80))}</span>
            </div>`
          ).join("")}
          ${matchLines.length > 10 ? `<div class="find-all-more">...and ${matchLines.length - 10} more</div>` : ""}
        </div>`;
      }
    }

    resultsEl.innerHTML = html || `<div class="find-all-empty">No results</div>`;

    resultsEl.querySelectorAll(".find-all-match").forEach(el => {
      el.addEventListener("click", async () => {
        const fileId = el.dataset.id;
        const lineNum = parseInt(el.dataset.line, 10);
        if (fileId !== state.currentFileId) {
          await state.openFile(fileId);
        }
        setTimeout(() => {
          if (state.editor) {
            const v = state.editor.view;
            const line = v.state.doc.line(Math.min(lineNum, v.state.doc.lines));
            v.dispatch({
              selection: { anchor: line.from },
              scrollIntoView: true,
            });
            v.focus();
          }
        }, 100);
      });
    });
  }

  let searchTimeout;
  input.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(searchAll, 200);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFindAll();
  });

  findAllPanel.querySelector(".find-close").addEventListener("click", closeFindAll);

  input.focus();
  if (initialQuery) searchAll();
}

function closeFindAll() {
  if (findAllPanel) {
    findAllPanel.remove();
    findAllPanel = null;
  }
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escAttr(str) {
  return (str || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
