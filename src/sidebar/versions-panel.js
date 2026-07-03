/**
 * Versions Panel — shows document snapshots with preview and restore
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

let currentSnapshots = [];
let filteredSnapshots = [];
let searchQuery = "";
let highlightChanges = false;
let selectedSnapshotId = null;
let hoveredSnapshotId = null;
let previewOverlay = null;
let previewHost = null;
let panelContainer = null;
let panelState = null;
let panelHidePanel = null;
let keyHandler = null;

/**
 * Creates the versions panel inside the given container.
 */
export function createVersionsPanel(container, state, hidePanel, options = {}) {
  currentSnapshots = [];
  selectedSnapshotId = null;
  hoveredSnapshotId = null;
  panelContainer = container;
  panelState = state;
  panelHidePanel = typeof hidePanel === "function" ? hidePanel : null;
  // Modal callers pass a positioned host element so the preview overlay
  // scopes inside the modal instead of covering the viewport.
  previewHost = options.previewHost || document.body;

  const fileName = getActiveFileName(state) || "Versions";

  const showHighlightToggle = !isNotebookMode(state);

  container.innerHTML = `
    <div class="versions-panel">
      <div class="panel-title"><span class="panel-title-label">Snapshots of</span><span class="panel-title-filename">${escHtml(fileName)}</span></div>
      <div class="versions-search-wrap">
        <input type="text" class="versions-search" placeholder="Search snapshots..." />
        ${showHighlightToggle ? `
          <label class="versions-highlight-toggle">
            <input type="checkbox" class="versions-highlight-checkbox" />
            <span>Highlight changes</span>
          </label>
        ` : ""}
      </div>
      <div class="versions-list-container">
        <div class="versions-empty">Loading...</div>
      </div>
    </div>
  `;

  const searchInput = container.querySelector(".versions-search");
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    applyFilter(container, state).catch((e) => console.error("Versions filter failed:", e));
  });

  const highlightCheckbox = container.querySelector(".versions-highlight-checkbox");
  if (highlightCheckbox) {
    highlightCheckbox.checked = highlightChanges;
    highlightCheckbox.addEventListener("change", () => {
      highlightChanges = highlightCheckbox.checked;
      refreshActivePreview(state);
    });
  }

  // Arrow key navigation
  keyHandler = (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (filteredSnapshots.length === 0) return;
    e.preventDefault();

    const currentIdx = filteredSnapshots.findIndex((s) => s.id === selectedSnapshotId);
    let nextIdx;
    if (currentIdx === -1) {
      nextIdx = 0;
    } else if (e.key === "ArrowUp") {
      nextIdx = Math.max(0, currentIdx - 1);
    } else {
      nextIdx = Math.min(filteredSnapshots.length - 1, currentIdx + 1);
    }

    selectSnapshot(filteredSnapshots[nextIdx], container, state);

    // Scroll the active item into view
    const activeLi = container.querySelector(".versions-list li.active");
    if (activeLi) activeLi.scrollIntoView({ block: "nearest" });
  };
  document.addEventListener("keydown", keyHandler);

  loadSnapshots(container, state);
}

async function loadSnapshots(container, state) {
  const docId = getActiveDocumentId(state);
  if (!docId) {
    renderEmpty(container, "No document open");
    return;
  }

  if (!IS_TAURI) {
    renderEmpty(container, "Version history requires the desktop app");
    return;
  }

  try {
    currentSnapshots = await tauriInvoke("get_snapshots", { documentId: docId });
  } catch (e) {
    console.error("Failed to load snapshots:", e);
    currentSnapshots = [];
  }

  if (currentSnapshots.length === 0) {
    renderEmpty(container, "No versions yet");
    return;
  }

  filteredSnapshots = currentSnapshots;
  renderSnapshotList(container, state);
}

function getActiveDocumentId(state) {
  if (state.currentNotebookFileId) return state.currentNotebookFileId;
  // Projects and Local Folder docs snapshot under synthetic keys — the
  // same mapping the auto-snapshot pipeline writes (state-snapshots.js).
  if (state.currentProjectId) return `project:${state.currentProjectId}`;
  const ls = state.currentLocalSync;
  if (ls && ls.kind === "doc" && ls.folderId && ls.relPath) {
    return `localsync:${ls.folderId}:${ls.relPath}`;
  }
  return state.currentFileId;
}

function isNotebookMode(state) {
  return !!state.currentNotebookFileId;
}

function renderEmpty(container, message) {
  const listContainer = container.querySelector(".versions-list-container");
  if (listContainer) {
    listContainer.innerHTML = `<div class="versions-empty">${message}</div>`;
  }
}

async function applyFilter(container, state) {
  const q = searchQuery.trim().toLowerCase();
  if (!q) {
    filteredSnapshots = currentSnapshots;
  } else if (isNotebookMode(state)) {
    const { extractSnapshotText } = await import("./notebook-snapshot-preview.js");
    filteredSnapshots = currentSnapshots.filter((s) => {
      const text = extractSnapshotText(s.content || "");
      return text.toLowerCase().includes(q);
    });
  } else {
    filteredSnapshots = currentSnapshots.filter(
      (s) => s.content && s.content.toLowerCase().includes(q)
    );
  }
  selectedSnapshotId = null;
  hoveredSnapshotId = null;
  removePreview();
  renderSnapshotList(container, state);
}

function renderSnapshotList(container, state) {
  const listContainer = container.querySelector(".versions-list-container");
  if (!listContainer) return;

  if (filteredSnapshots.length === 0) {
    listContainer.innerHTML = `<div class="versions-empty">${searchQuery ? "No matching snapshots" : "No versions yet"}</div>`;
    return;
  }

  const ul = document.createElement("ul");
  ul.className = "versions-list";

  for (const snap of filteredSnapshots) {
    const li = document.createElement("li");
    li.dataset.snapshotId = snap.id;

    const primary = document.createElement("span");
    primary.className = "version-time-primary";
    primary.textContent = formatTimestamp(snap.createdAt);

    const relative = document.createElement("span");
    relative.className = "version-time-relative";
    relative.textContent = formatRelativeTime(snap.createdAt);

    li.appendChild(primary);
    li.appendChild(relative);

    li.addEventListener("mouseenter", () => {
      hoverSnapshot(snap, state);
    });

    li.addEventListener("mouseleave", () => {
      unhoverSnapshot(state);
    });

    li.addEventListener("click", () => {
      selectSnapshot(snap, container, state);
    });

    ul.appendChild(li);
  }

  listContainer.innerHTML = "";
  listContainer.appendChild(ul);
}

function selectSnapshot(snap, container, state) {
  selectedSnapshotId = snap.id;
  hoveredSnapshotId = null;

  // Update active state in list
  const items = container.querySelectorAll(".versions-list li");
  items.forEach((li) => {
    li.classList.toggle("active", li.dataset.snapshotId == snap.id);
  });

  showPreview(snap, state, true);
}

function hoverSnapshot(snap, state) {
  if (snap.id === selectedSnapshotId) return;
  hoveredSnapshotId = snap.id;
  showPreview(snap, state, false);
}

function unhoverSnapshot(state) {
  if (hoveredSnapshotId === null) return;
  hoveredSnapshotId = null;

  if (selectedSnapshotId !== null) {
    const selected = filteredSnapshots.find((s) => s.id === selectedSnapshotId);
    if (selected) {
      showPreview(selected, state, true);
      return;
    }
  }
  removePreview();
}

function showPreview(snap, state, committed) {
  removePreview();

  previewOverlay = document.createElement("div");
  previewOverlay.className = "version-preview-overlay";

  const previewContainer = document.createElement("div");
  previewContainer.className = "version-preview-container";

  if (isNotebookMode(state)) {
    previewContainer.classList.add("version-preview-notebook");
    renderNotebookPreview(previewContainer, snap, state);
  } else if (highlightChanges) {
    previewContainer.classList.add("version-preview-diff");
    renderDiffPreview(previewContainer, snap);
  } else {
    const content = document.createElement("div");
    content.className = "version-preview-content";
    if (searchQuery.trim()) {
      content.innerHTML = highlightMatches(snap.content, searchQuery.trim());
    } else {
      content.textContent = snap.content;
    }
    previewContainer.appendChild(content);
  }

  previewOverlay.appendChild(previewContainer);

  if (committed) {
    const restoreBar = document.createElement("div");
    restoreBar.className = "version-restore-bar";

    const restoreBtn = document.createElement("button");
    restoreBtn.className = "version-restore-btn";
    restoreBtn.textContent = `Restore current with ${formatTimestamp(snap.createdAt)} Snapshot`;
    restoreBtn.addEventListener("click", () => {
      restoreSnapshot(snap, state);
    });

    const newFileBtn = document.createElement("button");
    newFileBtn.className = "version-restore-btn version-new-file-btn";
    newFileBtn.textContent = "New File From Version";
    newFileBtn.addEventListener("click", () => {
      newFileFromSnapshot(snap, state);
    });

    restoreBar.appendChild(restoreBtn);
    restoreBar.appendChild(newFileBtn);
    previewOverlay.appendChild(restoreBar);
  } else {
    previewContainer.style.bottom = "0";
  }

  (previewHost || document.body).appendChild(previewOverlay);
}

function renderNotebookPreview(container, snap, _state) {
  const wrap = document.createElement("div");
  wrap.className = "version-preview-notebook-wrap";

  const canvas = document.createElement("canvas");
  canvas.className = "version-preview-notebook-canvas";
  wrap.appendChild(canvas);

  const summary = document.createElement("div");
  summary.className = "version-preview-notebook-summary";
  wrap.appendChild(summary);

  container.appendChild(wrap);

  // Defer to next frame so the canvas has its layout dimensions before
  // we measure it for the offscreen render.
  requestAnimationFrame(async () => {
    try {
      const [{ renderNotebookSnapshotThumbnail }, { getCanvasInstance }] = await Promise.all([
        import("./notebook-snapshot-preview.js"),
        import("../notebook/notebook-bridge.js"),
      ]);
      const liveCanvas = getCanvasInstance();
      const stats = renderNotebookSnapshotThumbnail(canvas, snap.content, liveCanvas);
      const parts = [];
      parts.push(`${stats.shapeCount} shape${stats.shapeCount === 1 ? "" : "s"}`);
      if (stats.layerCount) parts.push(`${stats.layerCount} layer${stats.layerCount === 1 ? "" : "s"}`);
      summary.textContent = parts.join(" · ");
    } catch (e) {
      console.error("Notebook snapshot preview failed:", e);
      summary.textContent = "Preview unavailable";
    }
  });
}

function renderDiffPreview(container, snap) {
  const previousSnap = findPreviousSnapshot(snap.id);
  const wrap = document.createElement("div");
  wrap.className = "version-preview-content version-diff-body";

  if (!previousSnap) {
    const note = document.createElement("div");
    note.className = "version-diff-note";
    note.textContent = "First snapshot — no prior version to compare against.";
    wrap.appendChild(note);

    const plain = document.createElement("div");
    plain.className = "version-diff-plain";
    plain.textContent = snap.content || "";
    wrap.appendChild(plain);
    container.appendChild(wrap);
    return;
  }

  // Async-import the diff so we don't load it for users who never toggle the checkbox.
  import("./version-diff.js").then(({ diffLines }) => {
    const entries = diffLines(previousSnap.content || "", snap.content || "");
    for (const entry of entries) {
      const line = document.createElement("div");
      line.className = `diff-line diff-${entry.type}`;
      const gutter = document.createElement("span");
      gutter.className = "diff-gutter";
      gutter.textContent = entry.type === "added" ? "+" : entry.type === "removed" ? "−" : " ";
      const text = document.createElement("span");
      text.className = "diff-text";
      text.textContent = entry.text || "​";
      line.appendChild(gutter);
      line.appendChild(text);
      wrap.appendChild(line);
    }
  }).catch((e) => {
    console.error("Diff render failed:", e);
    wrap.textContent = snap.content || "";
  });

  container.appendChild(wrap);
}

function findPreviousSnapshot(snapshotId) {
  const idx = currentSnapshots.findIndex((s) => s.id === snapshotId);
  if (idx === -1) return null;
  // currentSnapshots is ordered newest-first, so the chronological predecessor
  // sits at idx + 1.
  return currentSnapshots[idx + 1] || null;
}

function refreshActivePreview(state) {
  const targetId = hoveredSnapshotId !== null ? hoveredSnapshotId : selectedSnapshotId;
  if (targetId === null) return;
  const snap = currentSnapshots.find((s) => s.id === targetId);
  if (!snap) return;
  const committed = hoveredSnapshotId === null;
  showPreview(snap, state, committed);
}

function removePreview() {
  if (previewOverlay) {
    previewOverlay.remove();
    previewOverlay = null;
  }
}

async function restoreSnapshot(snap, state) {
  const notebook = isNotebookMode(state);
  const docId = getActiveDocumentId(state);
  if (!docId) return;

  const content = snap.content;
  const isProject = typeof docId === "string" && docId.startsWith("project:");
  const isLocalSync = typeof docId === "string" && docId.startsWith("localsync:");

  // Close the versions panel, then write + update the active surface.
  if (panelState) panelState.emit("hide-panel");

  if (notebook) {
    if (IS_TAURI) {
      try {
        // Local Folder notebooks live on disk as `.hushnote` zips keyed
        // by an `ls:` sentinel — write through the same pack path the
        // notebook autosave uses. Internal notebooks take save_file.
        const { parseLocalSentinel } = await import("../sync/local-sync.js");
        const local = parseLocalSentinel(docId);
        if (local) {
          const { packNotebook } = await import("../sync/notebook-sync.js");
          const { writeFileBytes } = await import("../sync/local-sync.js");
          const bytes = await packNotebook(content);
          if (state.runtime) state.runtime.localSyncWriteFlag = Date.now();
          await writeFileBytes(local.folderId, local.relPath, Array.from(bytes), true);
          await tauriInvoke("create_snapshot", { documentId: docId, content });
        } else {
          await tauriInvoke("save_file", { id: docId, content });
          await tauriInvoke("create_snapshot", { documentId: docId, content });
          try { await state.syncFileToExternal?.(docId, content); } catch (_) {}
        }
      } catch (e) { console.error("Restore failed:", e); }
    }
    try {
      const { reloadNotebookShapes } = await import("../notebook/notebook-bridge.js");
      await reloadNotebookShapes(content);
    } catch (e) {
      console.error("Notebook restore reload failed:", e);
    }
    return;
  }

  if (isProject) {
    // The snapshot is the joined project buffer. Reseed the editor and
    // run the normal project save so the content splits back into the
    // child docs (and each child rides sync as usual).
    if (!state.editor) return;
    state.editor.setContent(content);
    state.dirty = true;
    try { await state.saveCurrentFile(); } catch (e) { console.error("Project restore save failed:", e); }
    if (IS_TAURI) {
      try { await tauriInvoke("create_snapshot", { documentId: docId, content }); } catch (_) {}
    }
    return;
  }

  if (isLocalSync) {
    // Write straight into the mounted folder; the watcher-echo guard
    // keeps the write from bouncing back as an external change.
    try {
      const ls = state.currentLocalSync;
      if (state.runtime) state.runtime.localSyncWriteFlag = Date.now();
      const { writeFile } = await import("../sync/local-sync.js");
      await writeFile(ls.folderId, ls.relPath, content);
      if (IS_TAURI) {
        try { await tauriInvoke("create_snapshot", { documentId: docId, content }); } catch (_) {}
      }
    } catch (e) { console.error("Local Folder restore failed:", e); }
    if (state.editor) {
      state.editor.setContent(content);
      state.dirty = false;
    }
    return;
  }

  // Plain internal doc.
  if (IS_TAURI) {
    try {
      await tauriInvoke("save_file", { id: docId, content });
      await tauriInvoke("create_snapshot", { documentId: docId, content });
      // Push the restore through sync too. Restoring clears the dirty
      // flag (it's not a user edit), so without an explicit push the
      // remote keeps the pre-restore rev and the next poll would pull
      // the old content right back over the restore.
      try { await state.syncFileToExternal?.(docId, content); } catch (_) {}
    } catch (e) {
      console.error("Restore failed:", e);
    }
  }
  if (state.editor) {
    state.editor.setContent(content);
    state.dirty = false;
  }
}

async function newFileFromSnapshot(snap, state) {
  const notebook = isNotebookMode(state);
  const origName = getActiveFileName(state) || (notebook ? "Notebook" : "Document");
  const stamp = snapshotStamp(snap.createdAt);
  const title = `${origName}-${stamp}`;
  const content = snap.content;

  closeVersionsSurface();

  if (notebook) {
    const created = await state.createNotebook(title, null, { openImmediately: false });
    if (!created) return;
    if (IS_TAURI) {
      try { await tauriInvoke("save_file", { id: created.fileId, content }); }
      catch (e) { console.error("Seed new notebook from version failed:", e); return; }
    }
    await state.openNotebook(created.fileId);
  } else {
    // Prepend the chosen title as line 1 so the doc's first-line
    // auto-rename doesn't immediately undo our explicit filename by
    // adopting whatever line 1 the original snapshot started with.
    const seeded = `${title}\n\n${content || ""}`;
    const created = await state.newFile(null, { openImmediately: false, initialName: title, initialContent: seeded });
    if (!created) return;
    await state.openFile(created.fileId);
  }
}

function closeVersionsSurface() {
  // Centered modal owner: prefer the close callback when supplied.
  if (panelHidePanel) {
    try { panelHidePanel(); } catch (e) { console.error("Versions modal close failed:", e); }
    return;
  }
  // Sidebar-style fallback.
  if (panelState) panelState.emit("hide-panel");
}

/** ddmmyy-hhmm zero-padded — mirrors selection-extract's makeStamp but
 *  seeded from the snapshot's own createdAt so the new filename reflects
 *  the version it came from rather than the moment of extraction. */
function snapshotStamp(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}${pad(d.getMonth() + 1)}${pad(d.getFullYear() % 100)}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Call this when the versions panel is closed to clean up.
 */
export function cleanupVersionsPanel() {
  removePreview();
  if (keyHandler) {
    document.removeEventListener("keydown", keyHandler);
    keyHandler = null;
  }
  currentSnapshots = [];
  filteredSnapshots = [];
  searchQuery = "";
  highlightChanges = false;
  selectedSnapshotId = null;
  hoveredSnapshotId = null;
  panelContainer = null;
  panelState = null;
  panelHidePanel = null;
}

// ===== Time Formatting =====

function formatTimestamp(unixSeconds) {
  const date = new Date(unixSeconds * 1000);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  const timeStr = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  if (isToday) {
    return timeStr;
  }

  const dateStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  // Add year if different
  if (date.getFullYear() !== now.getFullYear()) {
    return `${dateStr}, ${date.getFullYear()} ${timeStr}`;
  }

  return `${dateStr}, ${timeStr}`;
}

function getActiveFileName(state) {
  // Projects title by their tree node; Local Folder docs by filename.
  if (!state.currentNotebookFileId && state.currentProjectId && state.fileTree) {
    function searchNodes(nodes) {
      for (const node of nodes) {
        if (node.id === state.currentProjectId) return node.name;
        if (node.children) {
          const found = searchNodes(node.children);
          if (found) return found;
        }
      }
      return null;
    }
    return searchNodes(state.fileTree);
  }
  const ls = state.currentLocalSync;
  if (!state.currentNotebookFileId && ls && ls.kind === "doc" && ls.relPath) {
    const base = String(ls.relPath).split("/").pop() || "";
    return base.replace(/\.[^.]+$/, "") || base;
  }
  const activeId = state.currentNotebookFileId || state.currentFileId;
  if (!activeId || !state.fileTree) return null;
  // Search tree for a node with matching fileId
  function searchTree(nodes) {
    for (const node of nodes) {
      if (node.fileId === activeId) return node.name;
      if (node.children) {
        const found = searchTree(node.children);
        if (found) return found;
      }
    }
    return null;
  }
  return searchTree(state.fileTree);
}

function highlightMatches(text, query) {
  const escaped = escHtml(text);
  const queryEscaped = escHtml(query);
  const regex = new RegExp(`(${queryEscaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  return escaped.replace(regex, `<mark class="version-search-match">$1</mark>`);
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatRelativeTime(unixSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixSeconds;

  if (diff < 60) return "just now";
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  if (diff < 604800) {
    const d = Math.floor(diff / 86400);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }
  if (diff < 2592000) {
    const w = Math.floor(diff / 604800);
    return `${w} week${w === 1 ? "" : "s"} ago`;
  }
  const mo = Math.floor(diff / 2592000);
  return `${mo} month${mo === 1 ? "" : "s"} ago`;
}
