/**
 * Files panel — nested tree view with folders, projects and documents
 * Uses SortableList for drag-and-drop reordering
 */

import { SortableList } from "./sortable-list/sortable-list.js";

let sortableInstance = null;

// SVG icons for the three types
const typeIcons = {
  // Portrait-oriented rectangle for document
  document: `<svg viewBox="0 0 16 16" class="tree-type-icon"><rect x="3" y="1" width="10" height="14" rx="1.5" /></svg>`,
  // Circle for folder
  folder: `<svg viewBox="0 0 16 16" class="tree-type-icon"><circle cx="8" cy="8" r="6" /></svg>`,
  // Triangle for project
  project: `<svg viewBox="0 0 16 16" class="tree-type-icon"><polygon points="8,1 15,15 1,15" /></svg>`,
};

// Hover action buttons HTML
function actionButtons(nodeId) {
  return `<span class="tree-actions" data-node-id="${nodeId}">
    <button data-tree-action="rename" title="Rename">
      <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    </button>
    <button data-tree-action="duplicate" title="Duplicate">
      <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    </button>
    <button data-tree-action="delete" title="Delete">
      <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    </button>
  </span>`;
}

export function createFilesPanel(container, state, hidePanel) {
  container.innerHTML = "";

  // Header
  const header = document.createElement("div");
  header.className = "panel-title";
  header.textContent = "Files";
  container.appendChild(header);

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

  sortableInstance = new SortableList(listContainer, {
    data: state.fileTree,
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
    enableKeyboard: false, // Conflicts with editor; use drag only
    dragStartDelay: 180,

    renderItem: (item, context) => {
      const icon = typeIcons[item.type] || typeIcons.document;
      const isActive = isItemActive(item, state);
      const el = document.createElement("span");
      el.className = "tree-item-row" + (isActive ? " active" : "");
      el.innerHTML = `${icon}<span class="tree-item-name">${escHtml(item.name)}</span>${actionButtons(item.id)}`;
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
      state.fileTree = newData;
      state.saveFileTree();
    },
  });

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
    }
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
    sortableInstance.setData(state.fileTree);
  }
}

function handleRename(nodeId, triggerEl, state) {
  const node = state._findNode(state.fileTree, nodeId);
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
  const node = state._findNode(state.fileTree, nodeId);
  if (!node) return;

  // For folders/projects, show confirmation with contents
  if (node.type === "folder" || node.type === "project") {
    const items = collectAllNames(node.children || []);
    const itemList = items.length > 0
      ? items.map((n) => `  \u2022 ${n}`).join("\n")
      : "  (empty)";
    const typeName = node.type === "folder" ? "folder" : "project";

    showDeleteConfirmModal(
      `Delete ${typeName} "${node.name}"?`,
      `This will permanently delete the ${typeName} and all its contents:\n\n${itemList}`,
      () => {
        state.deleteTreeNode(nodeId).then(() => refreshList(state));
      }
    );
  } else {
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
