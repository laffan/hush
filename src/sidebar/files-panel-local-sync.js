/**
 * Local Sync rendering for the files panel. Renders mounted folders as
 * lazy-expanded subtrees outside the main SortableList, since their
 * content is sourced live from disk rather than from the file_tree.
 *
 * Shared icons / escapers live in files-panel-shared.js to avoid a
 * circular import with files-panel.js (which imports from this module).
 */
import { typeIcons, escHtml, escAttrValue, attachLeafHoverHandlers } from "./files-panel-shared.js";

const HAMBURGER_SVG = `<svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;
let openLocalSyncMenu = null;

function closeLocalSyncMenu() {
  if (!openLocalSyncMenu) return;
  document.removeEventListener("mousedown", openLocalSyncMenu.onMouseDown, true);
  document.removeEventListener("keydown", openLocalSyncMenu.onKey, true);
  window.removeEventListener("blur", closeLocalSyncMenu);
  openLocalSyncMenu.el.remove();
  openLocalSyncMenu = null;
}

function openLocalSyncFolderMenu(anchorBtn, folder, state, refreshFilesPanel) {
  closeLocalSyncMenu();
  const menu = document.createElement("div");
  menu.className = "tree-row-menu";
  const unlink = document.createElement("button");
  unlink.type = "button";
  unlink.className = "tree-row-menu-item";
  unlink.textContent = "Unlink Folder";
  unlink.addEventListener("click", async (e) => {
    e.stopPropagation();
    closeLocalSyncMenu();
    const { removeLocalSyncFolder } = await import("../sync/local-sync.js");
    // Rust persists settings.json inside local_sync_remove — mirror the
    // removal into the in-memory cache and refresh the panel. Skipping
    // the JS-side updateSettings here avoids round-tripping the full
    // settings object back through save_settings, which can clobber
    // unrelated fields Rust touched in the meantime.
    await removeLocalSyncFolder(folder.id);
    state.settings.localSyncFolders = (state.settings.localSyncFolders || []).filter(f => f.id !== folder.id);
    invalidateLocalSyncCache();
    if (refreshFilesPanel) refreshFilesPanel(state);
  });
  menu.appendChild(unlink);

  document.body.appendChild(menu);
  const rect = anchorBtn.getBoundingClientRect();
  const menuW = menu.offsetWidth;
  const menuH = menu.offsetHeight;
  let top = rect.bottom + 4;
  if (top + menuH > window.innerHeight - 6) top = Math.max(6, rect.top - menuH - 4);
  let left = rect.right - menuW;
  if (left < 6) left = 6;
  if (left + menuW > window.innerWidth - 6) left = window.innerWidth - menuW - 6;
  menu.style.top = top + "px";
  menu.style.left = left + "px";

  const onMouseDown = (e) => { if (!menu.contains(e.target)) closeLocalSyncMenu(); };
  const onKey = (e) => { if (e.key === "Escape") closeLocalSyncMenu(); };
  openLocalSyncMenu = { el: menu, onMouseDown, onKey };
  requestAnimationFrame(() => {
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", closeLocalSyncMenu);
  });
}

let storedLocalSyncContainer = null;
let storedState = null;
let storedHidePanel = null;
const localSyncExpanded = new Set(); // folderId:relPath strings

// Render token — bumped on every renderLocalSyncSection call. A stale
// render (one whose async folder list resolves after a newer call has
// started) bails before swapping content so concurrent refreshes can't
// double-append the same folder.
let renderToken = 0;

// Fingerprint of the most recently painted structure (folder list +
// expanded set). refreshFilesPanel fires on every file-opened event,
// which would otherwise rebuild the whole local-sync subtree (including
// async directory reads of every expanded mount) just to re-stamp the
// `.active` class on one row. When the fingerprint matches we skip the
// rebuild and only update active classes. `invalidateLocalSyncCache()`
// is the escape hatch for genuine on-disk changes pushed by the
// watcher.
let lastStructureFingerprint = null;

function computeStructureFingerprint(folders, activeDeskId) {
  const list = (folders || []).map(f => `${f.id}|${f.name || ""}|${f.path || ""}|${f.deskId || ""}`);
  const expanded = [...localSyncExpanded].sort();
  return JSON.stringify({ list, expanded, activeDeskId: activeDeskId || "" });
}

/** Folders attached to the currently active desk. Legacy mounts with no
 *  deskId stay visible across every desk so existing users don't lose
 *  access to a folder they mounted before the desk attachment landed. */
function filterFoldersForDesk(folders, activeDeskId) {
  if (!folders || folders.length === 0) return [];
  if (!activeDeskId) return folders;
  return folders.filter(f => !f.deskId || f.deskId === activeDeskId);
}

function updateActiveRows(container, state) {
  const activeKey = state.currentLocalSync
    ? `${state.currentLocalSync.folderId}:${state.currentLocalSync.relPath}`
    : null;
  container.querySelectorAll(".local-sync-file").forEach((li) => {
    const isActive = activeKey === li.dataset.id;
    li.classList.toggle("active", isActive);
    const row = li.querySelector(".tree-item-row");
    if (row) row.classList.toggle("active", isActive);
  });
}

/** Clear the cached structure fingerprint so the next render performs
 *  a full rebuild. Call this when on-disk content changes (e.g. from
 *  the local-sync watcher) since the folder/expanded set alone can't
 *  capture file-level mutations. */
export function invalidateLocalSyncCache() {
  lastStructureFingerprint = null;
}

/** Returns the stored container reference for refresh callers. */
export function getLocalSyncContainer() {
  return storedLocalSyncContainer;
}

export async function renderLocalSyncSection(container, state, hidePanel, refreshFilesPanel) {
  storedLocalSyncContainer = container;
  storedState = state;
  storedHidePanel = hidePanel;
  const myToken = ++renderToken;

  let folders = [];
  try {
    const { listLocalSyncFolders } = await import("../sync/local-sync.js");
    folders = await listLocalSyncFolders();
  } catch (e) {
    console.error("Local Sync: failed to load folders", e);
  }
  // Bail if another render has started while we were awaiting, or if
  // the container was replaced (panel re-opened).
  if (myToken !== renderToken) return;
  if (storedLocalSyncContainer !== container) return;

  const activeDeskId = state.settings?.activeDeskId || null;
  const visibleFolders = filterFoldersForDesk(folders, activeDeskId);

  // Fast path: the structure (folder list + expanded set + desk) is
  // unchanged since the last paint, so the user-visible delta can only
  // be the active row. Update classes in place and bail before paying
  // for an async directory rebuild.
  const fingerprint = computeStructureFingerprint(visibleFolders, activeDeskId);
  if (fingerprint === lastStructureFingerprint && container.firstChild) {
    updateActiveRows(container, state);
    return;
  }

  // Build the new subtree on a detached fragment so the live container
  // is never visibly empty during the rebuild.
  const fragment = document.createDocumentFragment();
  for (const folder of visibleFolders) {
    try {
      const rootLi = buildLocalSyncNode(folder, "", folder.name || folder.path, true, state, hidePanel, refreshFilesPanel);
      fragment.appendChild(rootLi);
    } catch (e) {
      console.error("Local Sync: failed to render folder", folder, e);
    }
  }
  // Atomic swap — old content stays put until this line runs.
  container.replaceChildren(fragment);
  lastStructureFingerprint = fingerprint;
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
    ? `<span class="tree-actions" data-node-id="${escAttrValue(folder.id)}"><button class="tree-action-menu" data-local-sync-action="menu" data-tooltip="Menu" aria-label="Menu">${HAMBURGER_SVG}</button></span>`
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

  // Delegated menu-button handler — opens a small dropdown with the
  // unlink action (replaces the previous inline × button).
  if (isRoot) {
    const btn = contentWrapper.querySelector('[data-local-sync-action="menu"]');
    if (btn) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openLocalSyncFolderMenu(btn, folder, state, refreshFilesPanel);
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
