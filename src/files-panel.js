/**
 * Files panel — nested tree view with folders, projects and documents
 * Uses SortableList for drag-and-drop reordering
 * Special nodes: Inbox (pinned top, project), Trash (pinned bottom, folder)
 */

import { SortableList } from "./sortable-list/sortable-list.js";
import { AppState } from "./state.js";
import { findNode } from "./tree-helpers.js";

let sortableInstance = null;

// SVG icons for the three types
const typeIcons = {
  // Portrait-oriented rectangle for document
  document: `<svg viewBox="0 0 16 16" class="tree-type-icon"><rect x="3" y="1" width="10" height="14" rx="1.5" /></svg>`,
  // Filled rectangle for flagged document
  documentFlagged: `<svg viewBox="0 0 16 16" class="tree-type-icon flagged-icon"><rect x="3" y="1" width="10" height="14" rx="1.5" /></svg>`,
  // Circle for folder
  folder: `<svg viewBox="0 0 16 16" class="tree-type-icon"><circle cx="8" cy="8" r="6" /></svg>`,
  // Filled circle for flagged folder
  folderFlagged: `<svg viewBox="0 0 16 16" class="tree-type-icon flagged-icon"><circle cx="8" cy="8" r="6" /></svg>`,
  // Triangle for project
  project: `<svg viewBox="0 0 16 16" class="tree-type-icon"><polygon points="8,1 15,15 1,15" /></svg>`,
  // Filled triangle for flagged project
  projectFlagged: `<svg viewBox="0 0 16 16" class="tree-type-icon flagged-icon"><polygon points="8,1 15,15 1,15" /></svg>`,
  // Inbox icon
  inbox: `<svg viewBox="0 0 16 16" class="tree-type-icon"><polyline points="2 9 5 9 6.5 11 9.5 11 11 9 14 9" /><path d="M3 2h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" /></svg>`,
  // Trash icon
  trash: `<svg viewBox="0 0 16 16" class="tree-type-icon"><polyline points="2 4 4 4 14 4" /><path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" /><path d="M12 4v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4" /></svg>`,
};

function getIcon(item) {
  if (item.id === AppState.INBOX_ID) return typeIcons.inbox;
  if (item.id === AppState.TRASH_ID) return typeIcons.trash;
  if (item.flagged) {
    return typeIcons[item.type + "Flagged"] || typeIcons[item.type] || typeIcons.document;
  }
  return typeIcons[item.type] || typeIcons.document;
}

// Hover action buttons HTML — no rename for documents
function actionButtons(nodeId, nodeType) {
  const isSpecial = nodeId === AppState.INBOX_ID || nodeId === AppState.TRASH_ID;
  const isDoc = nodeType === "document";
  const renameBtn = (isDoc || isSpecial) ? "" : `<button data-tree-action="rename" title="Rename">
      <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    </button>`;
  const flagBtn = isSpecial ? "" : `<button data-tree-action="flag" title="Toggle flag">
      <svg viewBox="0 0 24 24"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>
    </button>`;
  const dupBtn = isSpecial ? "" : `<button data-tree-action="duplicate" title="Duplicate">
      <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    </button>`;
  const delBtn = isSpecial ? "" : `<button data-tree-action="delete" title="Delete">
      <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    </button>`;
  return `<span class="tree-actions" data-node-id="${nodeId}">
    ${flagBtn}${renameBtn}${dupBtn}${delBtn}
  </span>`;
}

export function createFilesPanel(container, state, hidePanel) {
  container.innerHTML = "";

  // Create buttons row
  const btnRow = document.createElement("div");
  btnRow.className = "tree-create-btns";
  btnRow.innerHTML = `
    <button id="tree-new-doc" title="New Document">${typeIcons.document} Doc</button>
    <button id="tree-new-folder" title="New Folder">${typeIcons.folder} Folder</button>
    <button id="tree-new-project" title="New Project">${typeIcons.project} Project</button>
  `;
  container.appendChild(btnRow);

  // Sortable list container
  const listContainer = document.createElement("ul");
  listContainer.className = "tree-list-root";
  container.appendChild(listContainer);

  // Destroy previous instance
  if (sortableInstance) {
    sortableInstance.destroy();
    sortableInstance = null;
  }

  // Sort flagged items to top within folders
  const sortedTree = sortFlaggedItems(state.fileTree);

  sortableInstance = new SortableList(listContainer, {
    data: sortedTree,
    getId: (item) => item.id,
    getChildren: (item) => item.children || [],
    setChildren: (item, children) => { item.children = children; },
    canNest: (item) => item.type === "folder" || item.type === "project",
    canDrop: (draggedItem, targetItem) => {
      // Folders accept anything
      if (targetItem.type === "folder") return true;
      // Projects accept documents and projects only (not folders)
      if (targetItem.type === "project") return draggedItem.type === "document" || draggedItem.type === "project";
      // Documents accept nothing
      return false;
    },
    canDrag: (item) => {
      // Inbox and Trash can't be dragged
      return item.id !== AppState.INBOX_ID && item.id !== AppState.TRASH_ID;
    },
    enableKeyboard: false, // Conflicts with editor; use drag only
    dragStartDelay: 180,

    renderItem: (item, context) => {
      const icon = getIcon(item);
      const isActive = isItemActive(item, state);
      const el = document.createElement("span");
      el.className = "tree-item-row" + (isActive ? " active" : "");
      el.innerHTML = `${icon}<span class="tree-item-name">${escHtml(item.name)}</span>${actionButtons(item.id, item.type)}`;
      return el;
    },

    onClick: (item) => {
      if (item.type === "document" && item.fileId) {
        state.openFile(item.fileId);
        if (!container.closest("#panel-overlay")?.classList.contains("panel-inset")) {
          hidePanel();
        }
      } else if (item.type === "project") {
        state.openProject(item.id);
        if (!container.closest("#panel-overlay")?.classList.contains("panel-inset")) {
          hidePanel();
        }
      }
      // Folders: just toggle expand (handled by fold arrow)
    },

    onChange: (newData) => {
      // Enforce Inbox at top, Trash at bottom
      enforceSpecialPositions(newData);
      state.fileTree = newData;
      state.saveFileTree();
      // If a project is open, refresh the editor to reflect new doc order
      if (state.currentProjectId) {
        state.openProject(state.currentProjectId);
      }
    },
  });

  // Ensure Inbox is expanded by default
  if (sortableInstance.state.collapsedIds.has(AppState.INBOX_ID)) {
    sortableInstance.state.collapsedIds.delete(AppState.INBOX_ID);
  }

  // Bind create buttons
  btnRow.querySelector("#tree-new-doc").addEventListener("click", () => {
    state.newFile();
  });

  btnRow.querySelector("#tree-new-folder").addEventListener("click", async () => {
    await state.createFolder("New Folder");
    refreshList(state);
  });

  btnRow.querySelector("#tree-new-project").addEventListener("click", async () => {
    await state.createProject("New Project");
    refreshList(state);
  });

  // Bind action buttons (delegated)
  listContainer.addEventListener("click", (e) => {
    const actionBtn = e.target.closest("[data-tree-action]");
    if (!actionBtn) return;
    e.stopPropagation();

    const action = actionBtn.dataset.treeAction;
    const actionsEl = actionBtn.closest(".tree-actions");
    const nodeId = actionsEl?.dataset.nodeId;
    if (!nodeId) return;

    if (action === "rename") {
      handleRename(nodeId, actionBtn, state);
    } else if (action === "duplicate") {
      state.duplicateTreeNode(nodeId).then(() => refreshList(state));
    } else if (action === "delete") {
      handleDelete(nodeId, state);
    } else if (action === "flag") {
      state.toggleFlagged(nodeId).then(() => refreshList(state));
    }
  });
}

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
}

function sortFlaggedItems(tree) {
  return tree.map(node => {
    if (!node.children || node.children.length === 0) return node;
    const sortedChildren = sortFlaggedItems(node.children);
    // In folders, flagged items rise to top
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
  if (item.type === "project") {
    return item.id === state.currentProjectId;
  }
  return false;
}

function refreshList(state) {
  if (sortableInstance) {
    const sorted = sortFlaggedItems(state.fileTree);
    sortableInstance.setData(sorted);
  }
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

function handleDelete(nodeId, state) {
  const node = findNode(state.fileTree, nodeId);
  if (!node) return;

  const inTrash = state.isInTrash(nodeId);

  // For folders/projects (or items in trash), show confirmation
  if (node.type === "folder" || node.type === "project" || inTrash) {
    const items = collectAllNames(node.children || []);
    const itemList = items.length > 0
      ? items.map((n) => `  \u2022 ${n}`).join("\n")
      : "  (empty)";
    const typeName = node.type === "folder" ? "folder" : node.type === "project" ? "project" : "document";

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
    // Simple documents not in trash — move to trash without confirmation
    state.deleteTreeNode(nodeId).then(() => refreshList(state));
  }
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
  // Remove any existing modal
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
