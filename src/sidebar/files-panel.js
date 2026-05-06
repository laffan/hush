/**
 * Files panel — nested tree view with folders, projects and documents
 * Uses SortableList for drag-and-drop reordering
 * Special nodes: Inbox (pinned top), Trash (pinned bottom), Flagged (virtual)
 */

import { SortableList } from "./sortable-list/sortable-list.js";
import { AppState } from "../state/state.js";
import { findNode, collectFlaggedItems, findAncestorIds, normalizeProjectChildren } from "../state/tree-helpers.js";
import { isDropboxConnected } from "../sync/sync-polling.js";
import { createPane } from "../pane/pane-manager.js";
import { typeIcons, escHtml, attachLeafHoverHandlers, showConfirmModal, showDeleteConfirmModal } from "./files-panel-shared.js";
import { refreshTooltips } from "../tooltips.js";
import { renderLocalSyncSection, getLocalSyncContainer } from "./files-panel-local-sync.js";
import { mountDeskThumbnail, unmountDeskThumbnail, refreshDeskThumbnail } from "./desk-thumbnail.js";

let sortableInstance = null;
let flaggedContainerEl = null;
let storedHidePanel = null;
let storedState = null;

function getIcon(item) {
  if (item.id === AppState.INBOX_ID) return typeIcons.inbox;
  if (item.id === AppState.IMAGES_ID) return typeIcons.images;
  if (item.id === AppState.TRASH_ID) return typeIcons.trash;
  // Individual image nodes render without an icon so the sidebar stays
  // readable — hovering the row is the primary affordance anyway.
  if (item.type === "image") return "";
  if (item.syncFolderId && item.type === "folder") {
    // Legacy synced folder nodes — show broken icon if Dropbox disconnected
    if (!isDropboxConnected()) return typeIcons.syncedFolderBroken;
    return typeIcons.syncedFolder;
  }
  if (item.flagged) {
    return typeIcons[item.type + "Flagged"] || typeIcons[item.type] || typeIcons.document;
  }
  if (item.lockedStyleId && item.type === "document") return typeIcons.documentLocked;
  return typeIcons[item.type] || typeIcons.document;
}

/** Multi-window numeral badges for a tree row: one chip per window
 *  currently displaying this file. Documents/notebooks key off `fileId`,
 *  projects off the tree-node `id`. Returns "" when fewer than two
 *  Hush windows are open or no window matches. */
function windowBadgesHtml(item, state) {
  const list = state.windowList || [];
  if (list.length < 2) return "";
  const key = item.type === "project" ? item.id : item.fileId;
  if (!key) return "";
  const matches = list.filter(w => w.fileType === item.type && w.fileId === key);
  return matches.map(w => `<span class="tree-window-badge">${w.number}</span>`).join("");
}

// Hover action buttons — no rename for untitled docs or special nodes, no flag in trash
function actionButtons(nodeId, nodeType, inTrash, item) {
  if (nodeId === AppState.TRASH_ID) {
    return `<span class="tree-actions" data-node-id="${nodeId}">
      <button data-tree-action="empty-trash" class="tree-action-text" data-tooltip="Empty Trash">Empty</button>
    </span>`;
  }
  // Legacy synced folder root
  if (item?.syncFolderId && item.type === "folder") {
    return "";
  }
  const isSpecial = nodeId === AppState.INBOX_ID || nodeId === AppState.IMAGES_ID;
  const isDoc = nodeType === "document";
  const isImage = nodeType === "image";
  // Docs auto-derive their name from first line while still "Untitled".
  // Once content has locked in a name, expose rename like notebooks do.
  const docRenameable = isDoc && item?.name && item.name !== "Untitled";
  const renameBtn = (isSpecial || (isDoc && !docRenameable)) ? "" : `<button data-tree-action="rename" data-tooltip="Rename">
      <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    </button>`;
  const flagBtn = (isSpecial || inTrash || isImage) ? "" : `<button data-tree-action="flag" data-tooltip="Toggle flag">
      <svg viewBox="0 0 24 24"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>
    </button>`;
  const dupBtn = (isSpecial || isImage) ? "" : `<button data-tree-action="duplicate" data-tooltip="Duplicate">
      <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    </button>`;
  const delBtn = isSpecial ? "" : `<button data-tree-action="delete" data-tooltip="Delete">
      <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    </button>`;
  // Folder ↔ Project toggle. Only surfaced on real Folder/Project nodes
  // (not Inbox/Trash/Images, not the legacy synced root, never on docs
  // or images). The bi-directional arrow signals "swap container type"
  // — going Project → Folder loses ordering + project preview, so the
  // click handler shows a confirmation prompt for that direction only.
  let convertBtn = "";
  if (!isSpecial && (nodeType === "folder" || nodeType === "project") && !item?.syncFolderId) {
    const target = nodeType === "folder" ? "project" : "folder";
    convertBtn = `<button data-tree-action="convert-container" data-target-type="${target}" data-tooltip="Convert to ${target}">
      <svg viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
    </button>`;
  }
  return `<span class="tree-actions" data-node-id="${nodeId}">
    ${flagBtn}${renameBtn}${convertBtn}${dupBtn}${delBtn}
  </span>`;
}

// Flag-only action button for the virtual Flagged folder items
function flagOnlyButton(nodeId) {
  return `<span class="tree-actions" data-node-id="${nodeId}">
    <button data-tree-action="flag" data-tooltip="Unflag">
      <svg viewBox="0 0 24 24"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>
    </button>
  </span>`;
}

export function createFilesPanel(container, state, hidePanel) {
  storedHidePanel = hidePanel;
  storedState = state;
  container.innerHTML = "";

  // Create buttons row
  const btnRow = document.createElement("div");
  btnRow.className = "tree-create-btns";
  btnRow.innerHTML = `
    <button id="tree-new-doc" data-tooltip="New Document">${typeIcons.document}</button>
    <button id="tree-new-notebook" data-tooltip="New Notebook">${typeIcons.notebook}</button>
    <button id="tree-new-folder" data-tooltip="New Folder">${typeIcons.folder}</button>
    <button id="tree-new-project" data-tooltip="New Project">${typeIcons.project}</button>
  `;
  container.appendChild(btnRow);

  // Local Sync section — rendered above the flagged/files trees. Each
  // entry is a top-level disclosure that expands to show its on-disk
  // contents. Populated asynchronously after the main tree renders.
  const localSyncContainer = document.createElement("ul");
  localSyncContainer.className = "tree-list-root local-sync-root";
  container.appendChild(localSyncContainer);
  renderLocalSyncSection(localSyncContainer, state, hidePanel, refreshFilesPanel);

  // Flagged section — its own container, separate from SortableList
  flaggedContainerEl = document.createElement("ul");
  flaggedContainerEl.className = "tree-list-root flagged-section-root";
  container.appendChild(flaggedContainerEl);

  // Sortable list container
  const listContainer = document.createElement("ul");
  listContainer.className = "tree-list-root";
  container.appendChild(listContainer);

  // Destroy previous instance
  if (sortableInstance) {
    sortableInstance.destroy();
    sortableInstance = null;
  }

  const sortedTree = sortFlaggedItems(normalizeProjectChildren(state.fileTree));

  sortableInstance = new SortableList(listContainer, {
    data: sortedTree,
    getId: (item) => item.id,
    getChildren: (item) => item.children || [],
    setChildren: (item, children) => { item.children = children; },
    canNest: (item) => (item.type === "folder" || item.type === "project") && item.id !== AppState.IMAGES_ID,
    canDrop: (draggedItem, targetItem) => {
      // Images must stay inside the Images folder — root-level drops
      // (targetItem === null) are rejected for them too.
      if (draggedItem.type === "image") {
        return !!targetItem && targetItem.id === AppState.IMAGES_ID;
      }
      if (targetItem === null) {
        // Root-level drop — the files panel accepts every non-image node.
        return true;
      }
      if (targetItem.id === AppState.IMAGES_ID) return draggedItem.type === "image";
      if (targetItem.type === "folder") return true;
      // Projects accept docs (joined into the editor buffer), notebooks
      // (the supplementary sidebar block under the dashed line), and
      // nested projects.
      if (targetItem.type === "project") return ["document", "notebook", "project"].includes(draggedItem.type);
      return false;
    },
    canDrag: (item) => {
      return item.id !== AppState.INBOX_ID && item.id !== AppState.IMAGES_ID && item.id !== AppState.TRASH_ID;
    },
    enableKeyboard: false,
    dragStartDelay: 180,

    renderItem: (item, context) => {
      const icon = getIcon(item);
      const isActive = isItemActive(item, state);
      const inTrash = state.isInTrash(item.id);
      const el = document.createElement("span");
      el.className = "tree-item-row" + (isActive ? " active" : "");
      el.innerHTML = `${icon}<span class="tree-item-name">${escHtml(item.name)}</span>${windowBadgesHtml(item, state)}${actionButtons(item.id, item.type, inTrash, item)}`;
      if (item.type === "image" && item.fileId) {
        attachImageTooltipToRow(el, item.fileId, item.name);
      }
      return el;
    },

    onClick: (item) => {
      // Clicking anywhere on a folder-like row toggles its collapsed state.
      // This applies to Inbox, Images, Trash, and any user-created folder.
      // User projects still open into project view.
      const isFolderLike = item.type === "folder" || item.id === AppState.INBOX_ID;
      if (isFolderLike) {
        if (sortableInstance) sortableInstance.toggle(item.id);
        return;
      }
      if (item.type === "document" && item.fileId) {
        state.openFile(item.fileId);
        if (!container.closest("#panel-overlay")?.classList.contains("panel-inset")) hidePanel();
      } else if (item.type === "notebook" && item.fileId) {
        state.openNotebook(item.fileId);
        if (!container.closest("#panel-overlay")?.classList.contains("panel-inset")) hidePanel();
      } else if (item.type === "project") {
        state.openProject(item.id);
        if (!container.closest("#panel-overlay")?.classList.contains("panel-inset")) hidePanel();
      } else if (item.type === "image" && item.fileId) {
        openImagePreview(item.fileId, item.name);
      }
    },

    // Images can always escape the panel (no Cmd required) so the drop
    // lands in whatever editor/notebook is under the pointer.
    forceDragOutside: (item) => item && item.type === "image",

    onDragOutside: (item, clientX, clientY) => {
      if (item.type === "image" && item.fileId) {
        import("../pane/text-drag.js").then(({ dropSidebarImageAt }) => {
          dropSidebarImageAt(item.fileId, clientX, clientY);
        });
        return;
      }
      if ((item.type === "document" || item.type === "notebook") && item.fileId) {
        createPane(item.fileId, item.name, item.type, clientX, clientY);
      }
    },

    onChange: (newData) => {
      enforceSpecialPositions(newData);
      normalizeProjectChildren(newData);
      state.fileTree = newData;
      state.saveFileTree();
      state.reconcileSync();
      if (state.currentProjectId) state.openProject(state.currentProjectId);
    },
  });

  // Ensure Inbox is expanded by default
  if (sortableInstance.state.collapsedIds.has(AppState.INBOX_ID)) {
    sortableInstance.state.collapsedIds.delete(AppState.INBOX_ID);
  }

  // Trash and Images stay collapsed unless the user explicitly opens them
  // (mirroring each other — both are "drawer" special nodes at the tail).
  [AppState.TRASH_ID, AppState.IMAGES_ID].forEach(id => sortableInstance.state.collapsedIds.add(id));
  sortableInstance.render();

  // Render the virtual Flagged folder
  renderFlaggedSection(state);

  btnRow.querySelector("#tree-new-doc").addEventListener("click", () => state.newFile());
  btnRow.querySelector("#tree-new-notebook").addEventListener("click", async () => {
    await state.createNotebook("New Notebook");
    refreshList(state);
  });
  btnRow.querySelector("#tree-new-folder").addEventListener("click", async () => {
    await state.createFolder("New Folder");
    refreshList(state);
  });
  btnRow.querySelector("#tree-new-project").addEventListener("click", async () => {
    await state.createProject("New Project");
    refreshList(state);
  });

  // Delegated action handler for the sortable list
  listContainer.addEventListener("click", onActionClick);

  // Delegated action handler for the flagged section
  flaggedContainerEl.addEventListener("click", onActionClick);

  // Desk thumbnail — pinned to the bottom of the panel-overlay.
  mountDeskThumbnail(container, state);
}

function onActionClick(e) {
  const actionBtn = e.target.closest("[data-tree-action]");
  if (!actionBtn) return;
  e.stopPropagation();

  const action = actionBtn.dataset.treeAction;
  const actionsEl = actionBtn.closest(".tree-actions");
  const nodeId = actionsEl?.dataset.nodeId;
  if (!nodeId || !storedState) return;

  if (action === "rename") {
    handleRename(nodeId, actionBtn, storedState);
  } else if (action === "duplicate") {
    handleDuplicate(nodeId, storedState);
  } else if (action === "convert-container") {
    handleConvertContainer(nodeId, actionBtn.dataset.targetType, storedState);
  } else if (action === "delete") {
    handleDelete(nodeId, storedState);
  } else if (action === "flag") {
    storedState.toggleFlagged(nodeId).then(() => refreshList(storedState));
  } else if (action === "reveal-in-finder") {
    handleRevealInFinder(nodeId, storedState);
  } else if (action === "empty-trash") {
    handleEmptyTrash(storedState);
  }
}

// ===== Virtual Flagged Folder =====

let flaggedCollapsed = false;
// Per-node collapse state for nested entries inside the Flagged section.
// Keyed by the real tree node id — not stored cross-session, matching
// how the main tree's SortableList handles collapse.
const flaggedNodeCollapsed = new Set();

function renderFlaggedSection(state) {
  if (!flaggedContainerEl) return;
  flaggedContainerEl.innerHTML = "";

  const flaggedItems = collectFlaggedItems(state.fileTree);
  if (flaggedItems.length === 0) return;

  // Create the flagged folder as a regular li that looks like a folder
  const folderLi = document.createElement("li");
  folderLi.className = "sl-item flagged-virtual-folder";
  folderLi.dataset.id = "__flagged__";

  const contentWrapper = document.createElement("div");
  contentWrapper.className = "sl-item-content";

  // Fold arrow
  const foldArrow = document.createElement("button");
  foldArrow.className = "sl-fold-arrow";
  foldArrow.type = "button";
  foldArrow.textContent = flaggedCollapsed ? "\u25B6\uFE0E" : "\u25BC";
  foldArrow.setAttribute("aria-label", flaggedCollapsed ? "Expand" : "Collapse");
  foldArrow.addEventListener("click", (e) => {
    e.stopPropagation();
    flaggedCollapsed = !flaggedCollapsed;
    renderFlaggedSection(state);
  });
  contentWrapper.appendChild(foldArrow);

  // Label
  const label = document.createElement("span");
  label.className = "sl-item-label";
  const mainLabel = document.createElement("span");
  mainLabel.className = "sl-item-main-label";
  const row = document.createElement("span");
  row.className = "tree-item-row";
  row.innerHTML = `${typeIcons.flaggedFolder}<span class="tree-item-name">Flagged</span>`;
  mainLabel.appendChild(row);
  label.appendChild(mainLabel);
  contentWrapper.appendChild(label);
  folderLi.appendChild(contentWrapper);

  // Render children if not collapsed
  if (!flaggedCollapsed) {
    const childList = document.createElement("ul");
    childList.className = "sl-list";
    for (const item of flaggedItems) {
      childList.appendChild(renderFlaggedNode(item, state, /*isBubbled=*/false));
    }
    folderLi.appendChild(childList);
  }

  flaggedContainerEl.appendChild(folderLi);
}

/**
 * Render one node inside the Flagged section. Folders/projects render
 * their children nested underneath, matching the main file tree layout.
 * `isBubbled` is true for descendants of a flagged folder — those get
 * no unflag button (clicking it would flag them independently).
 */
function renderFlaggedNode(item, state, isBubbled) {
  const li = document.createElement("li");
  li.className = "sl-item flagged-link-item";
  li.dataset.id = item.id;

  const itemContent = document.createElement("div");
  itemContent.className = "sl-item-content";

  const hasChildren = Array.isArray(item.children) && item.children.length > 0;
  const isCollapsed = flaggedNodeCollapsed.has(item.id);
  if (hasChildren) li.classList.add("has-children");
  if (hasChildren && isCollapsed) li.classList.add("collapsed");

  const foldBtn = document.createElement("button");
  foldBtn.className = "sl-fold-arrow" + (hasChildren ? "" : " sl-fold-empty");
  foldBtn.type = "button";
  if (hasChildren) {
    foldBtn.textContent = isCollapsed ? "\u25B6\uFE0E" : "\u25BC";
    foldBtn.setAttribute("aria-label", isCollapsed ? "Expand" : "Collapse");
    foldBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (flaggedNodeCollapsed.has(item.id)) flaggedNodeCollapsed.delete(item.id);
      else flaggedNodeCollapsed.add(item.id);
      renderFlaggedSection(state);
    });
  } else {
    foldBtn.tabIndex = -1;
  }
  itemContent.appendChild(foldBtn);

  const itemLabel = document.createElement("span");
  itemLabel.className = "sl-item-label";
  const itemMain = document.createElement("span");
  itemMain.className = "sl-item-main-label";
  const itemRow = document.createElement("span");
  itemRow.className = "tree-item-row";
  // Only items directly flagged by the user get the unflag button —
  // descendants of a flagged folder bubble up without one.
  const button = (item.flagged && !isBubbled) ? flagOnlyButton(item.id) : "";
  itemRow.innerHTML = `${getIcon(item)}<span class="tree-item-name">${escHtml(item.name)}</span>${button}`;
  itemMain.appendChild(itemRow);
  itemLabel.appendChild(itemMain);
  itemContent.appendChild(itemLabel);
  li.appendChild(itemContent);

  attachLeafHoverHandlers(li);

  // Click the row: for docs/notebooks/projects, open + reveal. For
  // folders, toggle the nested children in place.
  itemContent.addEventListener("click", (e) => {
    if (e.target.closest("[data-tree-action]")) return;
    if (e.target.closest(".sl-fold-arrow")) return;
    if (item.type === "folder") {
      if (flaggedNodeCollapsed.has(item.id)) flaggedNodeCollapsed.delete(item.id);
      else flaggedNodeCollapsed.add(item.id);
      renderFlaggedSection(state);
      return;
    }
    revealAndOpen(item, state);
  });

  // Nested children (for a flagged folder or any of its sub-folders)
  if (hasChildren && !isCollapsed) {
    const childUl = document.createElement("ul");
    childUl.className = "sl-list";
    for (const child of item.children) {
      childUl.appendChild(renderFlaggedNode(child, state, /*isBubbled=*/true));
    }
    li.appendChild(childUl);
  }

  return li;
}

function revealAndOpen(item, state) {
  // Expand all ancestors in the sortable list so the item is visible
  const ancestors = findAncestorIds(state.fileTree, item.id);
  if (ancestors && sortableInstance) {
    for (const aid of ancestors) {
      sortableInstance.state.collapsedIds.delete(aid);
    }
    sortableInstance.render();
    renderFlaggedSection(state);
  }

  // Open the item
  const isInset = document.querySelector("#panel-overlay")?.classList.contains("panel-inset");
  if (item.type === "document" && item.fileId) {
    state.openFile(item.fileId);
    if (!isInset && storedHidePanel) storedHidePanel();
  } else if (item.type === "notebook" && item.fileId) {
    state.openNotebook(item.fileId);
    if (!isInset && storedHidePanel) storedHidePanel();
  } else if (item.type === "project") {
    state.openProject(item.id);
    if (!isInset && storedHidePanel) storedHidePanel();
  }
}

// ===== Tree Helpers =====

function enforceSpecialPositions(data) {
  const inboxIdx = data.findIndex(n => n.id === AppState.INBOX_ID);
  if (inboxIdx > 0) {
    const [inbox] = data.splice(inboxIdx, 1);
    data.unshift(inbox);
  }
  const trashIdx = data.findIndex(n => n.id === AppState.TRASH_ID);
  if (trashIdx >= 0 && trashIdx < data.length - 1) {
    const [trash] = data.splice(trashIdx, 1);
    data.push(trash);
  }
  // Images stays directly above Trash.
  const imgIdx = data.findIndex(n => n.id === AppState.IMAGES_ID);
  if (imgIdx >= 0) {
    const trashAt = data.findIndex(n => n.id === AppState.TRASH_ID);
    const target = trashAt >= 0 ? trashAt : data.length;
    if (imgIdx !== target - 1) {
      const [img] = data.splice(imgIdx, 1);
      const newTrashAt = data.findIndex(n => n.id === AppState.TRASH_ID);
      data.splice(newTrashAt >= 0 ? newTrashAt : data.length, 0, img);
    }
  }
}

function sortFlaggedItems(tree) {
  return tree.map(node => {
    if (!node.children || node.children.length === 0) return node;
    const sortedChildren = sortFlaggedItems(node.children);
    if (node.type === "folder") {
      const flagged = sortedChildren.filter(c => c.flagged);
      const unflagged = sortedChildren.filter(c => !c.flagged);
      return { ...node, children: [...flagged, ...unflagged] };
    }
    return { ...node, children: sortedChildren };
  });
}

function isItemActive(item, state) {
  if (item.type === "document" && item.fileId) {
    return item.fileId === state.currentFileId && !state.currentProjectId;
  }
  if (item.type === "notebook" && item.fileId) {
    return item.fileId === state.currentNotebookFileId;
  }
  if (item.type === "project") return item.id === state.currentProjectId;
  return false;
}

function refreshList(state) {
  if (sortableInstance) {
    const sorted = sortFlaggedItems(normalizeProjectChildren(state.fileTree));
    sortableInstance.setData(sorted);
  }
  renderFlaggedSection(state);
  // Any rows we might have had a tooltip open over may have been re-
  // rendered or removed — drop the tooltip so it can't linger.
  import("../editor/image-preview.js").then(({ hideImageTooltip }) => hideImageTooltip());
  // Newly-rendered rows carry `data-tooltip` markers; the global gate's
  // walk only runs on settings change, so re-apply here so freshly added
  // hover-action buttons pick up the user's Show Tooltips setting.
  refreshTooltips();
}

function handleRename(nodeId, triggerEl, state) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  const li = triggerEl.closest(".sl-item");
  if (!li) return;
  const nameEl = li.querySelector(".tree-item-name");
  if (!nameEl) return;
  const rowEl = li.querySelector(".tree-item-row");
  if (rowEl) rowEl.classList.add("renaming");

  const currentName = nameEl.textContent;
  nameEl.innerHTML = `<input class="tree-rename-input" type="text" value="${escAttrValue(currentName)}" />`;
  const input = nameEl.querySelector("input");
  input.focus();
  input.select();

  function finishRename() {
    if (rowEl) rowEl.classList.remove("renaming");
    const newName = input.value.trim();
    if (newName && newName !== currentName) {
      state.renameTreeNode(nodeId, newName).then(() => refreshList(state));
    } else {
      nameEl.textContent = currentName;
    }
  }

  input.addEventListener("blur", finishRename, { once: true });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { input.value = currentName; input.blur(); }
  });
}

function escAttrValue(str) {
  return (str || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

async function handleRevealInFinder(nodeId, state) {
  const node = findNode(state.fileTree, nodeId);
  if (!node?.syncFolderId) return;
  const folder = (state.settings.syncFolders || []).find(f => f.id === node.syncFolderId);
  if (!folder?.path) return;
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.revealItemInDir(folder.path);
  } catch (e) {
    console.error("Failed to reveal in Finder:", e);
  }
}

function handleConvertContainer(nodeId, targetType, state) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  if (targetType !== "folder" && targetType !== "project") return;
  if (node.type === targetType) return;

  const doConvert = () => {
    state.convertContainerType(nodeId, targetType).then(() => refreshList(state));
  };

  if (node.type === "project" && targetType === "folder") {
    showConfirmModal({
      title: `Convert "${node.name}" to a folder?`,
      message: "Switching from a project to a folder loses the project's ordering and the joined preview view. Files will be preserved.",
      confirmLabel: "Convert",
      onConfirm: doConvert,
    });
  } else {
    doConvert();
  }
}

function handleDuplicate(nodeId, state) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  const typeName = node.type === "notebook" ? "notebook" : "document";
  showConfirmModal({
    title: `Duplicate ${typeName} "${node.name}"?`,
    message: `A copy named "${node.name}-Copy" will be created next to the original.`,
    confirmLabel: "Duplicate",
    onConfirm: () => {
      state.duplicateTreeNode(nodeId).then(() => refreshList(state));
    },
  });
}

function handleDelete(nodeId, state) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;
  const inTrash = state.isInTrash(nodeId);

  if (node.type === "folder" || node.type === "project" || inTrash) {
    const items = collectAllNames(node.children || []);
    const itemList = items.length > 0
      ? items.map((n) => `  \u2022 ${n}`).join("\n")
      : "  (empty)";
    const typeName = node.type === "folder" ? "folder" : node.type === "project" ? "project" : node.type === "notebook" ? "notebook" : "document";

    const title = inTrash
      ? `Permanently delete "${node.name}"?`
      : `Delete ${typeName} "${node.name}"?`;
    const message = inTrash
      ? `This will permanently delete this item and cannot be undone.${items.length > 0 ? `\n\nContents:\n${itemList}` : ""}`
      : `This will move the ${typeName} to Trash.\n\nContents:\n${itemList}`;

    showDeleteConfirmModal(title, message, () => {
      state.deleteTreeNode(nodeId).then(() => refreshList(state));
    });
  } else {
    state.deleteTreeNode(nodeId).then(() => refreshList(state));
  }
}

function handleEmptyTrash(state) {
  const trash = findNode(state.fileTree, AppState.TRASH_ID);
  if (!trash?.children?.length) return;
  const items = collectAllNames(trash.children);
  const itemList = items.map(n => `  \u2022 ${n}`).join("\n");
  showDeleteConfirmModal(
    "Empty Trash?",
    `This will permanently delete all items and cannot be undone.\n\nContents:\n${itemList}`,
    () => { state.emptyTrash().then(() => refreshList(state)); },
  );
}

function collectAllNames(nodes) {
  const names = [];
  for (const n of nodes) {
    names.push(n.name);
    if (n.children) names.push(...collectAllNames(n.children));
  }
  return names;
}

export function refreshFilesPanel(state) {
  refreshList(state);
  // Re-render the local-sync section as well so newly added/removed
  // folders or watcher-pushed changes land in the panel. Prefer the
  // cached reference, but fall back to a live DOM query so the refresh
  // still works if the cached container got out of sync (e.g. the panel
  // was rebuilt from outside createFilesPanel).
  const cached = getLocalSyncContainer();
  const root = cached?.isConnected
    ? cached
    : document.querySelector(".local-sync-root");
  if (root && storedState && storedHidePanel) {
    renderLocalSyncSection(root, storedState, storedHidePanel, refreshFilesPanel);
  }
  refreshDeskThumbnail();
}


async function openImagePreview(filename, name) {
  const { openImagePreviewModal } = await import("../editor/image-preview.js");
  openImagePreviewModal(filename, name);
}

function attachImageTooltipToRow(rowEl, filename, name) {
  import("../editor/image-preview.js").then(({ attachImageHoverTooltip }) => {
    attachImageHoverTooltip(rowEl, filename, name);
  });
}
