/**
 * Versions Panel — shows document snapshots with preview and restore
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

let currentSnapshots = [];
let selectedSnapshotId = null;
let previewOverlay = null;
let panelContainer = null;
let panelState = null;
let keyHandler = null;

/**
 * Creates the versions panel inside the given container.
 */
export function createVersionsPanel(container, state, hidePanel) {
  currentSnapshots = [];
  selectedSnapshotId = null;
  panelContainer = container;
  panelState = state;

  const fileName = getActiveFileName(state) || "Versions";

  container.innerHTML = `
    <div class="versions-panel">
      <div class="panel-title"><span class="panel-title-label">Snapshots of</span><span class="panel-title-filename">${escHtml(fileName)}</span></div>
      <div class="versions-list-container">
        <div class="versions-empty">Loading...</div>
      </div>
    </div>
  `;

  // Arrow key navigation
  keyHandler = (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (currentSnapshots.length === 0) return;
    e.preventDefault();

    const currentIdx = currentSnapshots.findIndex((s) => s.id === selectedSnapshotId);
    let nextIdx;
    if (currentIdx === -1) {
      nextIdx = 0;
    } else if (e.key === "ArrowUp") {
      nextIdx = Math.max(0, currentIdx - 1);
    } else {
      nextIdx = Math.min(currentSnapshots.length - 1, currentIdx + 1);
    }

    selectSnapshot(currentSnapshots[nextIdx], container, state);

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

  renderSnapshotList(container, state);
}

function getActiveDocumentId(state) {
  if (state.currentProjectId) return null; // versions not supported for projects yet
  return state.currentFileId;
}

function renderEmpty(container, message) {
  const listContainer = container.querySelector(".versions-list-container");
  if (listContainer) {
    listContainer.innerHTML = `<div class="versions-empty">${message}</div>`;
  }
}

function renderSnapshotList(container, state) {
  const listContainer = container.querySelector(".versions-list-container");
  if (!listContainer) return;

  const ul = document.createElement("ul");
  ul.className = "versions-list";

  for (const snap of currentSnapshots) {
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

  // Update active state in list
  const items = container.querySelectorAll(".versions-list li");
  items.forEach((li) => {
    li.classList.toggle("active", li.dataset.snapshotId == snap.id);
  });

  showPreview(snap, state);
}

function showPreview(snap, state) {
  removePreview();

  previewOverlay = document.createElement("div");
  previewOverlay.className = "version-preview-overlay";

  const previewContainer = document.createElement("div");
  previewContainer.className = "version-preview-container";

  const content = document.createElement("div");
  content.className = "version-preview-content";
  content.textContent = snap.content;

  previewContainer.appendChild(content);
  previewOverlay.appendChild(previewContainer);

  // Restore bar
  const restoreBar = document.createElement("div");
  restoreBar.className = "version-restore-bar";

  const restoreBtn = document.createElement("button");
  restoreBtn.className = "version-restore-btn";
  restoreBtn.textContent = `Restore current with ${formatTimestamp(snap.createdAt)} Snapshot`;
  restoreBtn.addEventListener("click", () => {
    restoreSnapshot(snap, state);
  });

  restoreBar.appendChild(restoreBtn);
  previewOverlay.appendChild(restoreBar);

  document.body.appendChild(previewOverlay);
}

function removePreview() {
  if (previewOverlay) {
    previewOverlay.remove();
    previewOverlay = null;
  }
}

async function restoreSnapshot(snap, state) {
  console.log("[restore] called", { hasEditor: !!state.editor, fileId: state.currentFileId, contentLength: snap.content?.length, contentPreview: snap.content?.slice(0, 80) });

  if (!state.currentFileId) { console.log("[restore] bail: no currentFileId"); return; }

  const content = snap.content;
  const fileId = state.currentFileId;

  // Save the snapshot content directly to the backend first
  if (IS_TAURI) {
    try {
      await tauriInvoke("save_file", { id: fileId, content });
      await tauriInvoke("create_snapshot", { documentId: fileId, content });
      console.log("[restore] backend save OK");
    } catch (e) {
      console.error("[restore] backend save FAILED:", e);
    }
  } else {
    console.log("[restore] not Tauri, skipping backend save");
  }

  // Close the versions panel, then update the editor
  if (panelState) panelState.emit("hide-panel");

  // Now set the editor content after the panel is closed
  console.log("[restore] about to setContent, editor exists:", !!state.editor);
  if (state.editor) {
    state.editor.setContent(content);
    state.dirty = false;
    console.log("[restore] setContent done, editor now has:", state.editor.getContent()?.slice(0, 80));
  }
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
  selectedSnapshotId = null;
  panelContainer = null;
  panelState = null;
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
  if (!state.currentFileId || !state.fileTree) return null;
  // Search tree for a node with matching fileId
  function searchTree(nodes) {
    for (const node of nodes) {
      if (node.fileId === state.currentFileId) return node.name;
      if (node.children) {
        const found = searchTree(node.children);
        if (found) return found;
      }
    }
    return null;
  }
  return searchTree(state.fileTree);
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
