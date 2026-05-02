/**
 * Local Sync rendering for the files panel. Renders mounted folders as
 * lazy-expanded subtrees outside the main SortableList, since their
 * content is sourced live from disk rather than from the file_tree.
 *
 * Shared icons / escapers live in files-panel-shared.js to avoid a
 * circular import with files-panel.js (which imports from this module).
 */
import { typeIcons, escHtml, escAttrValue, attachLeafHoverHandlers } from "./files-panel-shared.js";

let storedLocalSyncContainer = null;
let storedState = null;
let storedHidePanel = null;
const localSyncExpanded = new Set(); // folderId:relPath strings

// Track which folder ids we've already set an initial expansion state for
// so re-renders don't keep "resetting" a folder the user chose to collapse.
const localSyncExpandedInitialized = new Set();

/** Returns the stored container reference for refresh callers. */
export function getLocalSyncContainer() {
  return storedLocalSyncContainer;
}

export async function renderLocalSyncSection(container, state, hidePanel, refreshFilesPanel) {
  storedLocalSyncContainer = container;
  storedState = state;
  storedHidePanel = hidePanel;
  container.innerHTML = "";
  let folders = [];
  try {
    const { listLocalSyncFolders } = await import("../sync/local-sync.js");
    folders = await listLocalSyncFolders();
  } catch (e) {
    console.error("Local Sync: failed to load folders", e);
  }
  // If the container was replaced (panel re-opened) while the async load
  // was running, bail out — the newer render will paint the new container.
  if (storedLocalSyncContainer !== container) return;
  if (!folders || folders.length === 0) return;

  // Seed the root-level expanded state so a freshly-added folder opens
  // by default (better default than requiring the user to click to see
  // there's nothing inside yet). Subsequent user toggles override this.
  for (const folder of folders) {
    const key = `${folder.id}:`;
    if (!localSyncExpandedInitialized.has(folder.id)) {
      localSyncExpanded.add(key);
      localSyncExpandedInitialized.add(folder.id);
    }
  }

  for (const folder of folders) {
    try {
      const rootLi = buildLocalSyncNode(folder, "", folder.name || folder.path, true, state, hidePanel, refreshFilesPanel);
      container.appendChild(rootLi);
    } catch (e) {
      console.error("Local Sync: failed to render folder", folder, e);
    }
  }
}

function buildLocalSyncNode(folder, relPath, displayName, isRoot, state, hidePanel, refreshFilesPanel) {
  const key = `${folder.id}:${relPath}`;
  const isExpanded = localSyncExpanded.has(key) || (isRoot && localSyncExpanded.size === 0 && false);

  const li = document.createElement("li");
  li.className = "sl-item has-children" + (isExpanded ? "" : " collapsed");
  li.dataset.id = key;
  attachLeafHoverHandlers(li);

  const contentWrapper = document.createElement("div");
  contentWrapper.className = "sl-item-content";

  const foldArrow = document.createElement("button");
  foldArrow.className = "sl-fold-arrow";
  foldArrow.type = "button";
  foldArrow.textContent = isExpanded ? "▼" : "▶︎";
  foldArrow.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleLocalSyncNode(key);
    if (storedLocalSyncContainer && storedState && storedHidePanel) {
      renderLocalSyncSection(storedLocalSyncContainer, storedState, storedHidePanel, refreshFilesPanel);
    }
  });
  contentWrapper.appendChild(foldArrow);

  const label = document.createElement("span");
  label.className = "sl-item-label";
  const main = document.createElement("span");
  main.className = "sl-item-main-label";
  const row = document.createElement("span");
  row.className = "tree-item-row";
  const removeBtn = isRoot
    ? `<span class="tree-actions" data-node-id="${escAttrValue(folder.id)}"><button data-local-sync-action="remove" title="Remove from Local Sync">&times;</button></span>`
    : "";
  // The Local Sync icon marks only the mount root; nested folders use
  // the regular folder icon so the tree reads as a normal filesystem
  // view inside the mount.
  const icon = isRoot ? typeIcons.localSync : typeIcons.folder;
  row.innerHTML = `${icon}<span class="tree-item-name">${escHtml(displayName)}</span>${removeBtn}`;
  main.appendChild(row);
  label.appendChild(main);
  contentWrapper.appendChild(label);

  // Row click toggles the folder open/closed (matches Inbox/Trash UX)
  contentWrapper.addEventListener("click", (e) => {
    if (e.target.closest("[data-local-sync-action]")) return;
    if (e.target.closest(".sl-fold-arrow")) return;
    toggleLocalSyncNode(key);
    if (storedLocalSyncContainer && storedState && storedHidePanel) {
      renderLocalSyncSection(storedLocalSyncContainer, storedState, storedHidePanel, refreshFilesPanel);
    }
  });

  li.appendChild(contentWrapper);

  // Delegated remove-button handler
  if (isRoot) {
    const btn = contentWrapper.querySelector('[data-local-sync-action="remove"]');
    if (btn) {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const { removeLocalSyncFolder } = await import("../sync/local-sync.js");
        await removeLocalSyncFolder(folder.id);
        if (refreshFilesPanel) refreshFilesPanel(state);
      });
    }
  }

  if (isExpanded) {
    const childList = document.createElement("ul");
    childList.className = "sl-list";
    li.appendChild(childList);
    populateLocalSyncChildren(childList, folder, relPath, state, hidePanel, refreshFilesPanel);
  }

  return li;
}

function toggleLocalSyncNode(key) {
  if (localSyncExpanded.has(key)) localSyncExpanded.delete(key);
  else localSyncExpanded.add(key);
}

async function populateLocalSyncChildren(container, folder, relPath, state, hidePanel, refreshFilesPanel) {
  container.innerHTML = '<li class="local-sync-loading"><span class="sl-item-label">Loading…</span></li>';
  try {
    const { readDir, openLocalSyncFile } = await import("../sync/local-sync.js");
    const entries = await readDir(folder.id, relPath);
    container.innerHTML = "";
    if (entries.length === 0) {
      const empty = document.createElement("li");
      empty.className = "local-sync-empty";
      empty.innerHTML = `<span class="sl-item-content"><span class="sl-fold-arrow sl-fold-empty"></span><span class="sl-item-label"><em>(empty)</em></span></span>`;
      container.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      if (entry.is_dir || entry.isDir) {
        const sub = buildLocalSyncNode(folder, entry.relPath || entry.rel_path, entry.name, false, state, hidePanel, refreshFilesPanel);
        container.appendChild(sub);
      } else {
        const fileLi = buildLocalSyncFileRow(folder, entry, state, hidePanel, openLocalSyncFile);
        container.appendChild(fileLi);
      }
    }
  } catch (e) {
    console.error("Failed to list local-sync folder:", e);
    container.innerHTML = `<li class="local-sync-error"><span class="sl-item-label">Failed to read directory</span></li>`;
  }
}

function buildLocalSyncFileRow(folder, entry, state, hidePanel, openLocalSyncFile) {
  const relPath = entry.relPath || entry.rel_path;
  const isImage = entry.isImage || entry.is_image || false;
  const li = document.createElement("li");
  li.className = "sl-item local-sync-file" + (isImage ? " local-sync-image" : "");
  li.dataset.id = `${folder.id}:${relPath}`;
  attachLeafHoverHandlers(li);

  const activeKey = state.currentLocalSync
    ? `${state.currentLocalSync.folderId}:${state.currentLocalSync.relPath}`
    : null;
  if (activeKey === `${folder.id}:${relPath}`) li.classList.add("active");

  const itemContent = document.createElement("div");
  itemContent.className = "sl-item-content";
  const spacer = document.createElement("button");
  spacer.className = "sl-fold-arrow sl-fold-empty";
  spacer.tabIndex = -1;
  itemContent.appendChild(spacer);

  const label = document.createElement("span");
  label.className = "sl-item-label";
  const main = document.createElement("span");
  main.className = "sl-item-main-label";
  const row = document.createElement("span");
  row.className = "tree-item-row" + (li.classList.contains("active") ? " active" : "");
  const icon = isImage ? (typeIcons.image || typeIcons.document) : typeIcons.document;
  row.innerHTML = `${icon}<span class="tree-item-name">${escHtml(entry.name)}</span>`;
  main.appendChild(row);
  label.appendChild(main);
  itemContent.appendChild(label);
  li.appendChild(itemContent);

  if (isImage) {
    // Sibling-file context so the preview path (and hover) reads bytes
    // straight from the mounted folder rather than the global Images
    // store. baseDir is the relPath's parent ("" at the mount root).
    const slash = relPath.lastIndexOf("/");
    const baseDir = slash >= 0 ? relPath.slice(0, slash) : "";
    const ctx = { kind: "localSync", folderId: folder.id, baseDir };
    (async () => {
      const { attachImageHoverTooltip } = await import("../editor/image-preview.js");
      attachImageHoverTooltip(itemContent, entry.name, entry.name, ctx);
    })();
    itemContent.addEventListener("click", async (e) => {
      e.preventDefault();
      const { openImagePreviewModal } = await import("../editor/image-preview.js");
      openImagePreviewModal(entry.name, entry.name, ctx);
    });
    return li;
  }

  // Cmd/Ctrl-drag to spawn a floating pane for this file.  Mirrors the
  // SortableList's drag-outside behaviour so Local Sync files feel
  // identical to normal sidebar docs.
  attachLocalSyncFileDrag(itemContent, folder, entry, relPath);

  itemContent.addEventListener("click", async (e) => {
    // A drag-out consumed the gesture — don't also open the file.
    if (itemContent.dataset.dragConsumed === "1") {
      delete itemContent.dataset.dragConsumed;
      return;
    }
    // Cmd+click alone (no drag) is treated as "open" as well.
    await openLocalSyncFile(state, folder.id, relPath);
    const overlay = document.querySelector("#panel-overlay");
    if (overlay && !overlay.classList.contains("panel-inset") && hidePanel) hidePanel();
  });

  return li;
}

/**
 * Wire a pointerdown→move→up sequence on a Local Sync file row so a
 * Cmd/Ctrl-drag past the panel's right edge spawns a floating pane for
 * the file. The ghost element matches the SortableList's ghost so the
 * visual affordance is consistent with dragging a doc out of the
 * regular file tree.
 */
function attachLocalSyncFileDrag(rowEl, folder, entry, relPath) {
  rowEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let ghost = null;

    const buildGhost = () => {
      const g = document.createElement("div");
      g.className = "sl-drag-ghost";
      g.textContent = entry.name;
      g.style.transform = `translate3d(${e.clientX - 40}px, ${e.clientY - 10}px, 0)`;
      document.body.appendChild(g);
      document.body.classList.add("sl-dragging");
      return g;
    };

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) > 6) {
        dragging = true;
        ghost = buildGhost();
      }
      if (ghost) {
        ghost.style.transform = `translate3d(${ev.clientX - 40}px, ${ev.clientY - 10}px, 0)`;
      }
    };

    const onUp = async (ev) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      if (ghost) { ghost.remove(); ghost = null; }
      document.body.classList.remove("sl-dragging");
      if (!dragging) return;
      // Mark this gesture so the subsequent click listener knows to
      // skip "open in main editor" — the drag replaces that action.
      rowEl.dataset.dragConsumed = "1";
      if (!(ev.metaKey || ev.ctrlKey || (typeof window !== "undefined" && window.__hushCmdHeld))) return;
      const panelOverlay = document.getElementById("panel-overlay");
      const rect = panelOverlay?.getBoundingClientRect();
      if (!rect || ev.clientX <= rect.right) return;
      try {
        const { createPane } = await import("../pane/pane-manager.js");
        const paneFileId = `ls:${folder.id}:${relPath}`;
        await createPane(paneFileId, entry.name, "document", ev.clientX, ev.clientY, {
          localSync: { folderId: folder.id, relPath },
        });
      } catch (err) {
        console.error("Failed to spawn Local Sync pane:", err);
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}
