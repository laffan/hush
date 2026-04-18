/**
 * Files panel — nested tree view with folders, projects and documents
 * Uses SortableList for drag-and-drop reordering
 * Special nodes: Inbox (pinned top), Trash (pinned bottom), Flagged (virtual)
 */

import { SortableList } from "./sortable-list/sortable-list.js";
import { AppState } from "../state/state.js";
import { findNode, collectFlaggedItems, findAncestorIds } from "../state/tree-helpers.js";
import { isDropboxConnected } from "../sync/sync-polling.js";
import { createPane } from "../pane/pane-manager.js";

let sortableInstance = null;
let flaggedContainerEl = null;
let storedHidePanel = null;
let storedState = null;

// SVG icons for the three types
const typeIcons = {
  document: `<svg viewBox="0 0 16 16" class="tree-type-icon"><rect x="3" y="1" width="10" height="14" rx="1.5" /></svg>`,
  documentLocked: `<svg viewBox="0 0 16 16" class="tree-type-icon locked-style-icon"><rect x="3" y="1" width="10" height="14" rx="1.5" /><circle cx="8" cy="8" r="2.5" /></svg>`,
  documentFlagged: `<svg viewBox="0 0 16 16" class="tree-type-icon flagged-icon"><rect x="3" y="1" width="10" height="14" rx="1.5" /></svg>`,
  folder: `<svg viewBox="0 0 16 16" class="tree-type-icon"><circle cx="8" cy="8" r="6" /></svg>`,
  folderFlagged: `<svg viewBox="0 0 16 16" class="tree-type-icon flagged-icon"><circle cx="8" cy="8" r="6" /></svg>`,
  project: `<svg viewBox="0 0 16 16" class="tree-type-icon"><polygon points="8,1 15,15 1,15" /></svg>`,
  projectFlagged: `<svg viewBox="0 0 16 16" class="tree-type-icon flagged-icon"><polygon points="8,1 15,15 1,15" /></svg>`,
  notebook: `<svg viewBox="0 0 16 16" class="tree-type-icon"><rect x="3" y="1" width="10" height="14" rx="1.5" /><line x1="5" y1="4" x2="11" y2="4" /><line x1="5" y1="7" x2="11" y2="7" /><line x1="5" y1="10" x2="9" y2="10" /></svg>`,
  notebookFlagged: `<svg viewBox="0 0 16 16" class="tree-type-icon flagged-icon"><rect x="3" y="1" width="10" height="14" rx="1.5" /><line x1="5" y1="4" x2="11" y2="4" /><line x1="5" y1="7" x2="11" y2="7" /><line x1="5" y1="10" x2="9" y2="10" /></svg>`,
  syncedFolder: `<svg viewBox="0 0 16 16" class="tree-type-icon"><circle cx="8" cy="8" r="6" /><line x1="2" y1="8" x2="14" y2="8" /></svg>`,
  syncedFolderBroken: `<svg viewBox="0 0 16 16" class="tree-type-icon sync-broken-icon"><circle cx="8" cy="8" r="6" /><polyline points="2,8 5,8 6,6 7,10 8,6 9,10 10,8 14,8" /></svg>`,
  inbox: `<svg viewBox="0 0 16 16" class="tree-type-icon"><polyline points="2 9 5 9 6.5 11 9.5 11 11 9 14 9" /><path d="M3 2h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" /></svg>`,
  // Images folder: a centered square with the same rounded corners as the
  // `document` head and a single diagonal slash through it.
  images: `<svg viewBox="0 0 16 16" class="tree-type-icon"><rect x="3" y="3" width="10" height="10" rx="1.5" /><line x1="4.5" y1="11.5" x2="11.5" y2="4.5" /></svg>`,
  trash: `<svg viewBox="0 0 16 16" class="tree-type-icon"><polyline points="2 4 4 4 14 4" /><path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" /><path d="M12 4v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4" /></svg>`,
  flaggedFolder: `<svg viewBox="0 0 16 16" class="tree-type-icon"><path d="M3 10s1-1 3-1 4 2 6 2 3-1 3-1V2s-1 1-3 1-4-2-6-2-3 1-3 1z" /><line x1="3" y1="14" x2="3" y2="10" /></svg>`,
  // Local Sync folder icon: circle with a horizontal line through the
  // middle — visually distinct from the plain folder (filled circle).
  localSync: `<svg viewBox="0 0 16 16" class="tree-type-icon"><circle cx="8" cy="8" r="6" /><line x1="2" y1="8" x2="14" y2="8" /></svg>`,
};

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

// Hover action buttons — no rename for untitled docs or special nodes, no flag in trash
function actionButtons(nodeId, nodeType, inTrash, item) {
  if (nodeId === AppState.TRASH_ID) {
    return `<span class="tree-actions" data-node-id="${nodeId}">
      <button data-tree-action="empty-trash" class="tree-action-text" title="Empty Trash">Empty</button>
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
  const renameBtn = (isSpecial || (isDoc && !docRenameable)) ? "" : `<button data-tree-action="rename" title="Rename">
      <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    </button>`;
  const flagBtn = (isSpecial || inTrash || isImage) ? "" : `<button data-tree-action="flag" title="Toggle flag">
      <svg viewBox="0 0 24 24"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>
    </button>`;
  const dupBtn = (isSpecial || isImage) ? "" : `<button data-tree-action="duplicate" title="Duplicate">
      <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    </button>`;
  const delBtn = isSpecial ? "" : `<button data-tree-action="delete" title="Delete">
      <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    </button>`;
  return `<span class="tree-actions" data-node-id="${nodeId}">
    ${flagBtn}${renameBtn}${dupBtn}${delBtn}
  </span>`;
}

// Flag-only action button for the virtual Flagged folder items
function flagOnlyButton(nodeId) {
  return `<span class="tree-actions" data-node-id="${nodeId}">
    <button data-tree-action="flag" title="Unflag">
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
    <button id="tree-new-doc" title="New Document">${typeIcons.document}</button>
    <button id="tree-new-notebook" title="New Notebook">${typeIcons.notebook}</button>
    <button id="tree-new-folder" title="New Folder">${typeIcons.folder}</button>
    <button id="tree-new-project" title="New Project">${typeIcons.project}</button>
  `;
  container.appendChild(btnRow);

  // Local Sync section — rendered above the flagged/files trees. Each
  // entry is a top-level disclosure that expands to show its on-disk
  // contents. Populated asynchronously after the main tree renders.
  const localSyncContainer = document.createElement("ul");
  localSyncContainer.className = "tree-list-root local-sync-root";
  container.appendChild(localSyncContainer);
  renderLocalSyncSection(localSyncContainer, state, hidePanel);

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

  const sortedTree = sortFlaggedItems(state.fileTree);

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
      if (targetItem.type === "project") return draggedItem.type === "document" || draggedItem.type === "project";
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
      el.innerHTML = `${icon}<span class="tree-item-name">${escHtml(item.name)}</span>${actionButtons(item.id, item.type, inTrash, item)}`;
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
  sortableInstance.state.collapsedIds.add(AppState.TRASH_ID);
  sortableInstance.state.collapsedIds.add(AppState.IMAGES_ID);
  sortableInstance.render();

  // Render the virtual Flagged folder
  renderFlaggedSection(state);

  // Bind create buttons
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
    storedState.duplicateTreeNode(nodeId).then(() => refreshList(storedState));
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
    const sorted = sortFlaggedItems(state.fileTree);
    sortableInstance.setData(sorted);
  }
  renderFlaggedSection(state);
  // Any rows we might have had a tooltip open over may have been re-
  // rendered or removed — drop the tooltip so it can't linger.
  import("../editor/image-preview.js").then(({ hideImageTooltip }) => hideImageTooltip());
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

function showDeleteConfirmModal(title, message, onConfirm) {
  document.querySelectorAll(".tree-delete-modal-backdrop").forEach((el) => el.remove());

  const backdrop = document.createElement("div");
  backdrop.className = "tree-delete-modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "tree-delete-modal";
  modal.innerHTML = `
    <div class="tree-delete-modal-title">${escHtml(title)}</div>
    <pre class="tree-delete-modal-message">${escHtml(message)}</pre>
    <div class="tree-delete-modal-btns">
      <button class="tree-delete-cancel">Cancel</button>
      <button class="tree-delete-confirm">Delete</button>
    </div>
  `;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  modal.querySelector(".tree-delete-cancel").addEventListener("click", () => backdrop.remove());
  modal.querySelector(".tree-delete-confirm").addEventListener("click", () => {
    backdrop.remove();
    onConfirm();
  });
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
}

export function refreshFilesPanel(state) {
  refreshList(state);
  // Re-render the local-sync section as well so newly added/removed
  // folders or watcher-pushed changes land in the panel. Prefer the
  // cached reference, but fall back to a live DOM query so the refresh
  // still works if `storedLocalSyncContainer` got out of sync (e.g. the
  // panel was rebuilt from outside createFilesPanel).
  const root = storedLocalSyncContainer?.isConnected
    ? storedLocalSyncContainer
    : document.querySelector(".local-sync-root");
  if (root && storedState && storedHidePanel) {
    renderLocalSyncSection(root, storedState, storedHidePanel);
  }
}

// ===== Local Sync =====

let storedLocalSyncContainer = null;
const localSyncExpanded = new Set(); // folderId:relPath strings

async function renderLocalSyncSection(container, state, hidePanel) {
  storedLocalSyncContainer = container;
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
      const rootLi = buildLocalSyncNode(folder, "", folder.name || folder.path, true, state, hidePanel);
      container.appendChild(rootLi);
    } catch (e) {
      console.error("Local Sync: failed to render folder", folder, e);
    }
  }
}

// Track which folder ids we've already set an initial expansion state for
// so re-renders don't keep "resetting" a folder the user chose to collapse.
const localSyncExpandedInitialized = new Set();

function buildLocalSyncNode(folder, relPath, displayName, isRoot, state, hidePanel) {
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
  foldArrow.textContent = isExpanded ? "\u25BC" : "\u25B6\uFE0E";
  foldArrow.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleLocalSyncNode(key);
    if (storedLocalSyncContainer && storedState && storedHidePanel) {
      renderLocalSyncSection(storedLocalSyncContainer, storedState, storedHidePanel);
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
      renderLocalSyncSection(storedLocalSyncContainer, storedState, storedHidePanel);
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
        refreshFilesPanel(state);
      });
    }
  }

  if (isExpanded) {
    const childList = document.createElement("ul");
    childList.className = "sl-list";
    li.appendChild(childList);
    populateLocalSyncChildren(childList, folder, relPath, state, hidePanel);
  }

  return li;
}

function toggleLocalSyncNode(key) {
  if (localSyncExpanded.has(key)) localSyncExpanded.delete(key);
  else localSyncExpanded.add(key);
}

async function populateLocalSyncChildren(container, folder, relPath, state, hidePanel) {
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
        const sub = buildLocalSyncNode(folder, entry.relPath || entry.rel_path, entry.name, false, state, hidePanel);
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
  const li = document.createElement("li");
  li.className = "sl-item local-sync-file";
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
  row.innerHTML = `${typeIcons.document}<span class="tree-item-name">${escHtml(entry.name)}</span>`;
  main.appendChild(row);
  label.appendChild(main);
  itemContent.appendChild(label);
  li.appendChild(itemContent);

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
      if (!(ev.metaKey || ev.ctrlKey)) return;
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

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Wire mouseenter / mouseleave on a `.sl-item` so only the innermost
 * row under the cursor carries `.sl-hovered` (mirrors the logic in
 * sortable-list/rendering.js). Used by the Flagged section and Local
 * Sync rows, which render outside SortableList's own machinery.
 */
function attachLeafHoverHandlers(li) {
  li.addEventListener("mouseenter", () => {
    let ancestor = li.parentElement?.closest(".sl-item");
    while (ancestor) {
      ancestor.classList.remove("sl-hovered");
      ancestor = ancestor.parentElement?.closest(".sl-item");
    }
    li.classList.add("sl-hovered");
  });
  li.addEventListener("mouseleave", () => {
    li.classList.remove("sl-hovered");
    const parentItem = li.parentElement?.closest(".sl-item");
    if (parentItem) parentItem.classList.add("sl-hovered");
  });
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
