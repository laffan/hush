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
  images: `<svg viewBox="0 0 16 16" class="tree-type-icon"><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="6" cy="7" r="1.2" fill="currentColor" stroke="none" /><polyline points="3,12 6.5,8.5 9,11 11,9 13,12" /></svg>`,
  image: `<svg viewBox="0 0 16 16" class="tree-type-icon"><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="6" cy="7" r="1.2" fill="currentColor" stroke="none" /><polyline points="3,12 6.5,8.5 9,11 11,9 13,12" /></svg>`,
  trash: `<svg viewBox="0 0 16 16" class="tree-type-icon"><polyline points="2 4 4 4 14 4" /><path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" /><path d="M12 4v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4" /></svg>`,
  flaggedFolder: `<svg viewBox="0 0 16 16" class="tree-type-icon"><path d="M3 10s1-1 3-1 4 2 6 2 3-1 3-1V2s-1 1-3 1-4-2-6-2-3 1-3 1z" /><line x1="3" y1="14" x2="3" y2="10" /></svg>`,
};

function getIcon(item) {
  if (item.id === AppState.INBOX_ID) return typeIcons.inbox;
  if (item.id === AppState.IMAGES_ID) return typeIcons.images;
  if (item.id === AppState.TRASH_ID) return typeIcons.trash;
  if (item.type === "image") return typeIcons.image;
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
      // Images must stay in the Images folder.
      if (draggedItem.type === "image") return targetItem.id === AppState.IMAGES_ID;
      // The Images folder only accepts image nodes.
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

    onDragOutside: (item, clientX, clientY) => {
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

  // Trash stays collapsed unless the user explicitly opens it
  sortableInstance.state.collapsedIds.add(AppState.TRASH_ID);
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
      const li = document.createElement("li");
      li.className = "sl-item flagged-link-item";
      li.dataset.id = item.id;

      const itemContent = document.createElement("div");
      itemContent.className = "sl-item-content";

      // Empty fold spacer
      const spacer = document.createElement("button");
      spacer.className = "sl-fold-arrow sl-fold-empty";
      spacer.tabIndex = -1;
      itemContent.appendChild(spacer);

      const itemLabel = document.createElement("span");
      itemLabel.className = "sl-item-label";
      const itemMain = document.createElement("span");
      itemMain.className = "sl-item-main-label";
      const itemRow = document.createElement("span");
      itemRow.className = "tree-item-row";
      itemRow.innerHTML = `${getIcon(item)}<span class="tree-item-name">${escHtml(item.name)}</span>${flagOnlyButton(item.id)}`;
      itemMain.appendChild(itemRow);
      itemLabel.appendChild(itemMain);
      itemContent.appendChild(itemLabel);
      li.appendChild(itemContent);

      // Hover handling
      li.addEventListener("mouseenter", () => li.classList.add("sl-hovered"));
      li.addEventListener("mouseleave", () => li.classList.remove("sl-hovered"));

      // Click: open the actual item and reveal it in the tree
      li.addEventListener("click", (e) => {
        if (e.target.closest("[data-tree-action]")) return;
        revealAndOpen(item, state);
      });

      childList.appendChild(li);
    }
    folderLi.appendChild(childList);
  }

  flaggedContainerEl.appendChild(folderLi);
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

  const currentName = nameEl.textContent;
  nameEl.innerHTML = `<input class="tree-rename-input" type="text" value="${currentName}" />`;
  const input = nameEl.querySelector("input");
  input.focus();
  input.select();

  function finishRename() {
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
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
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
