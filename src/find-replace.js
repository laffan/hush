/**
 * Find & Replace UI for the editor.
 * - Cmd+F: find/replace within current file
 * - Cmd+Shift+F: find across all files
 */

let findBar = null;

export function openFindReplace(view, state) {
  if (findBar) {
    // If already open, focus the search field
    const input = findBar.querySelector(".find-input");
    if (input) input.focus();
    return;
  }

  // Pre-fill with current selection
  const sel = view.state.selection.main;
  const initialQuery = sel.empty ? "" : view.state.sliceDoc(sel.from, sel.to);

  findBar = document.createElement("div");
  findBar.className = "find-bar";
  findBar.innerHTML = `
    <div class="find-bar-row">
      <input type="text" class="find-input" placeholder="Find..." value="${escAttr(initialQuery)}" />
      <button class="find-btn find-prev" title="Previous">&#9650;</button>
      <button class="find-btn find-next" title="Next">&#9660;</button>
      <span class="find-count"></span>
      <button class="find-btn find-close" title="Close">&times;</button>
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
  let matches = [];
  let currentMatch = -1;
  let decorations = [];

  function search() {
    const query = findInput.value;
    matches = [];
    clearHighlights(view);
    if (!query) {
      countEl.textContent = "";
      currentMatch = -1;
      return;
    }
    const doc = view.state.doc.toString();
    let idx = 0;
    while ((idx = doc.indexOf(query, idx)) !== -1) {
      matches.push({ from: idx, to: idx + query.length });
      idx += 1;
    }
    countEl.textContent = matches.length > 0 ? `${matches.length} found` : "No results";
    if (matches.length > 0) {
      // Find match nearest to cursor
      const cursorPos = view.state.selection.main.head;
      currentMatch = 0;
      for (let i = 0; i < matches.length; i++) {
        if (matches[i].from >= cursorPos) { currentMatch = i; break; }
      }
      goToMatch(view);
    } else {
      currentMatch = -1;
    }
  }

  function goToMatch(view) {
    if (currentMatch < 0 || currentMatch >= matches.length) return;
    const m = matches[currentMatch];
    view.dispatch({
      selection: { anchor: m.from, head: m.to },
      scrollIntoView: true,
    });
    countEl.textContent = `${currentMatch + 1} / ${matches.length}`;
  }

  function clearHighlights() {
    // Highlighting is handled by selection, no extra decorations needed
  }

  findInput.addEventListener("input", search);

  findBar.querySelector(".find-next").addEventListener("click", () => {
    if (matches.length === 0) return;
    currentMatch = (currentMatch + 1) % matches.length;
    goToMatch(view);
  });

  findBar.querySelector(".find-prev").addEventListener("click", () => {
    if (matches.length === 0) return;
    currentMatch = (currentMatch - 1 + matches.length) % matches.length;
    goToMatch(view);
  });

  findBar.querySelector(".replace-one").addEventListener("click", () => {
    if (currentMatch < 0 || currentMatch >= matches.length) return;
    const m = matches[currentMatch];
    const replacement = replaceInput.value;
    view.dispatch({ changes: { from: m.from, to: m.to, insert: replacement } });
    search(); // re-search after replacement
  });

  findBar.querySelector(".replace-all").addEventListener("click", () => {
    if (matches.length === 0) return;
    const replacement = replaceInput.value;
    // Apply all replacements in reverse order to maintain positions
    const changes = matches.slice().reverse().map(m => ({
      from: m.from, to: m.to, insert: replacement,
    }));
    view.dispatch({ changes });
    search();
  });

  findBar.querySelector(".find-close").addEventListener("click", closeFindBar);

  // Escape closes find bar
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFindBar();
    if (e.key === "Enter") {
      e.preventDefault();
      if (matches.length > 0) {
        currentMatch = (currentMatch + 1) % matches.length;
        goToMatch(view);
      }
    }
  });

  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFindBar();
  });

  findInput.focus();
  if (initialQuery) search();
}

function closeFindBar() {
  if (findBar) {
    findBar.remove();
    findBar = null;
  }
}

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
      // Load file content
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

    // Bind result clicks
    resultsEl.querySelectorAll(".find-all-match").forEach(el => {
      el.addEventListener("click", async () => {
        const fileId = el.dataset.id;
        const lineNum = parseInt(el.dataset.line, 10);
        if (fileId !== state.currentFileId) {
          await state.openFile(fileId);
        }
        // Navigate to line
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
