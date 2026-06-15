/**
 * Files panel — nested tree view with folders, projects and documents.
 * SortableList drag-and-drop; special nodes: Inbox (top), Trash (bottom), Flagged (virtual).
 */

import { SortableList } from "./sortable-list/sortable-list.js";
import { AppState } from "../state/state.js";
import { collectFlaggedItems, findAncestorIds, findNode, findNodeByFileId, normalizeProjectChildren, enforceSpecialPositions, findParentOfNode, reapplyGutterMarkers } from "../state/tree-helpers.js";
import { createPane } from "../pane/pane-manager.js";
import { paneIndicatorsFor, attachPaneIndicatorTooltip } from "./files-panel-pane-indicators.js";
import { typeIcons, escHtml, attachLeafHoverHandlers, showPromptModal, googleLinkBadgeHtml, computeNumberLabels } from "./files-panel-shared.js";
import {
  isInboxId, isImagesId, isPdfsId, isTrashId, isAnySpecialId, allSpecialIds,
  visibleTopLevel, numberSkip, hasPairedGutter, getIcon, windowBadgesHtml,
  actionButtons, flagOnlyButton, getPdfSync, buildPdfRowHtml,
} from "./files-panel-rows.js";
import { refreshTooltips } from "../tooltips.js";
import { renderLocalSyncSection, getLocalSyncContainer, onLocalDropExternal } from "./files-panel-local-sync.js";
import { openRowMenu } from "./files-panel-row-menu.js";
import { collectVisibleDocs, handleDocMultiClick, installDragSelect } from "./files-panel-multi-select.js";
import {
  handleRename, handleRevealInFinder, handleConvertContainer,
  handleDuplicate, handleDelete, handleEmptyTrash, handleOpenAsStack,
  handleConvertProjectToDoc, handleConvertDocToProject,
  handleRestore, handlePermanentDelete,
} from "./files-panel-actions.js";
import {
  isTabMarkerItem, augmentTreeWithTabs, stripTabMarkersFromTree,
  renderTabMarkerRow, openDocAtTab,
} from "./files-panel-tabs.js";

let sortableInstance = null;
let flaggedContainerEl = null;
let storedHidePanel = null;
let storedState = null;

// Outline-number labels for rows inside a project with `showNumbers`.
let numberLabels = new Map();

export function createFilesPanel(container, state, hidePanel) {
  storedHidePanel = hidePanel;
  storedState = state;
  initFilesPanelTabSync(state);
  getPdfSync();
  container.innerHTML = "";

  // (Create buttons moved to the footer's Add popup — see add-popup.js)

  // Flagged section — its own container, separate from SortableList
  flaggedContainerEl = document.createElement("ul");
  flaggedContainerEl.className = "tree-list-root flagged-section-root";
  container.appendChild(flaggedContainerEl);

  // Sortable list container
  const listContainer = document.createElement("ul");
  listContainer.className = "tree-list-root";
  container.appendChild(listContainer);

  // Local Sync section — rendered below the normal tree; each entry is a
  // top-level disclosure that expands to its on-disk contents async.
  const localSyncContainer = document.createElement("ul");
  localSyncContainer.className = "tree-list-root local-sync-root";
  container.appendChild(localSyncContainer);
  renderLocalSyncSection(localSyncContainer, state, hidePanel, refreshFilesPanel);

  // Destroy previous instance
  if (sortableInstance) {
    sortableInstance.destroy();
    sortableInstance = null;
  }

  reapplyGutterMarkers(state.fileTree);
  const sortedTree = augmentTreeWithTabs(state, sortFlaggedItems(normalizeProjectChildren(visibleTopLevel(state))));
  numberLabels = computeNumberLabels(sortedTree, numberSkip, isInboxId);

  sortableInstance = new SortableList(listContainer, {
    data: sortedTree,
    getId: (item) => item.id,
    getChildren: (item) => item.children || [],
    setChildren: (item, children) => { item.children = children; },
    canNest: (item) => (item.type === "folder" || item.type === "project" || item.type === "desk") && !isImagesId(item.id) && !isPdfsId(item.id),
    canDrop: (draggedItem, targetItem) => {
      // Tab markers are synthetic — they can never be a drop target
      // and the dragged item can never be one (canDrag blocks them).
      if (isTabMarkerItem(targetItem)) return false;
      // Images stay inside the Images folder; PDFs in __pdfs__ (no
      // reparenting); desks can't nest (root-level drops only).
      if (draggedItem.type === "image") return !!targetItem && isImagesId(targetItem.id);
      if (draggedItem.type === "pdf") return false;
      if (draggedItem.type === "desk") return targetItem === null;
      if (targetItem === null) return false;
      if (isImagesId(targetItem.id)) return draggedItem.type === "image";
      if (isPdfsId(targetItem.id)) return false;
      if (targetItem.type === "folder") return true;
      if (targetItem.type === "desk") return ["document", "notebook", "stack", "folder", "project"].includes(draggedItem.type);
      if (targetItem.type === "project") return ["document", "notebook", "stack", "project"].includes(draggedItem.type);
      return false;
    },
    canDrag: (item) => {
      // Special nodes and desk containers themselves can't be dragged.
      if (isTabMarkerItem(item)) return false;
      return !isAnySpecialId(item.id) && item.type !== "desk";
    },
    // Multi-drag: if the dragged row belongs to a multi-selection, return
    // the node ids of the *other* selected files so they move together.
    getDraggedSiblings: (moved) => {
      const sel = state.selectedDocIds || [];
      if (sel.length < 2 || !moved?.fileId || !sel.includes(moved.fileId)) return [];
      return sel.filter((fid) => fid !== moved.fileId)
        .map((fid) => findNodeByFileId(state.fileTree, fid)).filter(Boolean).map((n) => n.id);
    },
    enableKeyboard: false,
    dragStartDelay: 180,

    renderItem: (item, context) => {
      if (isTabMarkerItem(item)) {
        return renderTabMarkerRow(item, (entry) => {
          if (state.selectedDocIds.length) state.clearSelectedDocs();
          void openDocAtTab(state, entry.fileId, entry.tabOffset);
          if (!container.closest("#panel-overlay")?.classList.contains("panel-inset")) hidePanel();
        });
      }
      const icon = getIcon(item);
      const isActive = isItemActive(item, state);
      const inTrash = state.isInTrash(item.id);
      const _p = item.type === "document" ? findParentOfNode(state.fileTree, item.id) : null;
      const inProject = !!_p && _p.type === "project" && _p.id !== "__inbox__" && !_p.id?.startsWith("__inbox__:");
      const isMultiSelected = (item.type === "document" || item.type === "notebook" || item.type === "pdf") && item.fileId
        && Array.isArray(state.selectedDocIds) && state.selectedDocIds.includes(item.fileId);
      // `.multi-selected` lives on the outer `.sl-item` so it survives
      // re-renders; `data-file-id` lets the listener toggle it without a
      // full rebuild (which would strand cached row refs mid-drag-select).
      if (context?.li) {
        context.li.classList.toggle("multi-selected", !!isMultiSelected);
        if (item.fileId) context.li.dataset.fileId = item.fileId;
      }
      const row = document.createElement("span");
      row.className = "tree-item-row" + (isActive ? " active" : "");

      if (item.type === "pdf" && item.fileId && !isPdfsId(item.id)) {
        const pdfHtml = buildPdfRowHtml(item, icon, state, inTrash, inProject);
        row.innerHTML = pdfHtml;
      } else {
        const numLabel = numberLabels.get(item.id);
        const numPrefix = numLabel ? `<span class="tree-item-number">${escHtml(numLabel)}</span> ` : "";
        // Gutter notebooks are stored as `<docName>-gutter` but read as "Gutter".
        const displayName = (item.type === "notebook" && item.gutter) ? "Gutter" : item.name;
        row.innerHTML = `${icon}${googleLinkBadgeHtml(item, state)}<span class="tree-item-name">${numPrefix}${escHtml(displayName)}</span>${windowBadgesHtml(item, state)}${actionButtons(item.id, item.type, inTrash, item, inProject)}`;
      }
      if (item.type === "image" && item.fileId) attachImageTooltipToRow(row, item.fileId, item.name);
      const indicators = paneIndicatorsFor(item, state);
      if (!indicators) return row;
      // The gutter row carries the doc's pane icons INLINE, appended inside the
      // name span so they sit directly after the "Gutter" text (not pushed to
      // the row's right edge by the name's flex:1).
      if (item.type === "notebook" && item.gutter) {
        row.querySelector(".tree-item-name")?.append(indicators);
        return row;
      }
      // A doc with a gutter shows its pane icons on the gutter row, not below
      // itself — drop the doc's own strip.
      if (item.type === "document" && hasPairedGutter(state, item)) return row;
      const wrap = document.createElement("span");
      wrap.className = "tree-item-cell";
      wrap.append(row, indicators);
      return wrap;
    },

    onClick: (item, event) => {
      // Docs / notebooks / pdfs / stacks participate in multi-select;
      // everything else falls through and clears any active selection.
      const isMultiSelectable = (item.type === "document" || item.type === "notebook" || item.type === "pdf" || item.type === "stack") && item.fileId;
      if (isMultiSelectable) {
        if (event && (event.shiftKey || event.metaKey || event.ctrlKey)) {
          const visible = collectVisibleDocs(state, visibleTopLevel, sortFlaggedItems, sortableInstance?.state?.collapsedIds);
          handleDocMultiClick(item, event, state, visible);
          refreshList(state);
          return;
        }
        if (state.selectedDocIds.length) state.clearSelectedDocs();
        if (item.type === "notebook") state.openNotebook(item.fileId);
        else if (item.type === "pdf") state.openPdf(item.fileId);
        else if (item.type === "stack") state.openStack(item.fileId);
        else state.openFile(item.fileId);
        if (!container.closest("#panel-overlay")?.classList.contains("panel-inset")) hidePanel();
        return;
      }
      // Folder / project / image click: drop any selection, then route
      // folder-likes to a collapse toggle and the rest to their opener.
      if (state.selectedDocIds.length) state.clearSelectedDocs();
      const isFolderLike = item.type === "folder" || isInboxId(item.id) || isPdfsId(item.id) || item.type === "desk";
      if (isFolderLike) {
        if (sortableInstance) sortableInstance.toggle(item.id);
        return;
      }
      if (item.type === "notebook" && item.fileId) {
        state.openNotebook(item.fileId);
        if (!container.closest("#panel-overlay")?.classList.contains("panel-inset")) hidePanel();
      } else if (item.type === "project") {
        state.openProject(item.id);
        if (!container.closest("#panel-overlay")?.classList.contains("panel-inset")) hidePanel();
      } else if (item.type === "image" && item.fileId) {
        openImagePreview(item.fileId, item.name);
      }
    },

    onDropExternal: (item, ev) => onLocalDropExternal(state, item, ev), // drop onto a Local Sync folder → move to disk
    onCollapseChange: (ids) => state.updateSettings({ collapsedFolderIds: ids }), // persist folder open/closed state
    // Images can always escape the panel (no Cmd required) so the drop
    // lands in whatever editor/notebook is under the pointer.
    forceDragOutside: (item) => item && item.type === "image",

    onDragOutside: (item, clientX, clientY, pointerEvent) => {
      if (item.type === "image" && item.fileId) {
        import("../pane/text-drag.js").then(({ dropSidebarImageAt }) => {
          dropSidebarImageAt(item.fileId, clientX, clientY);
        });
        return;
      }
      const dragId = item.type === "project" ? item.id : item.fileId;
      const eligible = (item.type === "document" || item.type === "notebook" || item.type === "pdf" || item.type === "stack" || item.type === "project") && dragId;
      if (!eligible) return;
      // Alt/Option-drag onto an open stack → add as stack item
      const altHeld = pointerEvent?.altKey;
      if (altHeld && state.currentStackFileId) {
        import("../stack/stack-bridge.js").then(({ getStackInstance }) => {
          const inst = getStackInstance();
          if (inst) inst.handleFileDrop(dragId, item.type, item.name);
        });
        return;
      }
      // Cmd-drag (default) → create floating pane
      createPane(dragId, item.name, item.type, clientX, clientY);
    },

    onChange: (newData) => {
      // Tab markers are synthetic — strip them before any tree write so
      // the persisted tree never inherits one (re-added on next render).
      const cleaned = stripTabMarkersFromTree(newData);
      enforceSpecialPositions(cleaned);
      normalizeProjectChildren(cleaned);
      const active = state.fileTree.find(n => n.type === "desk" && n.id === state.settings?.activeDeskId)
        || state.fileTree.find(n => n.type === "desk");
      if (active) active.children = cleaned; else state.fileTree = cleaned;
      state.saveFileTree();
      state.reconcileSync();
      state.syncProjectOrdering(state.currentProjectId || null);
      if (state.currentProjectId) state.openProject(state.currentProjectId);
    },
  });

  // Restore persisted folder collapse state. On first run (no persisted
  // set) apply the defaults: Inbox open (a fresh set leaves it expanded),
  // Trash / Images / PDFs collapsed.
  const persistedCollapsed = state.settings?.collapsedFolderIds;
  if (Array.isArray(persistedCollapsed)) {
    for (const id of persistedCollapsed) sortableInstance.state.collapsedIds.add(id);
  } else {
    for (const id of allSpecialIds(state, AppState.TRASH_ID)) sortableInstance.state.collapsedIds.add(id);
    for (const id of allSpecialIds(state, AppState.IMAGES_ID)) sortableInstance.state.collapsedIds.add(id);
    for (const id of allSpecialIds(state, AppState.PDFS_ID)) sortableInstance.state.collapsedIds.add(id);
  }
  sortableInstance.render();

  // Render the virtual Flagged folder
  renderFlaggedSection(state);

  // Delegated action handlers
  listContainer.addEventListener("click", onActionClick);
  flaggedContainerEl.addEventListener("click", onActionClick);
  attachPaneIndicatorTooltip(listContainer);
  // Option-click on a row opens the Send-to-desk modal (when desks on).
  import("./send-to-desk-modal.js").then((m) => m.attachDeskShortcuts(listContainer, state));
  // Drag-select gutter on the panel's left edge — a pointerdown in the
  // 16 px strip arms a bounding-box selection over doc rows.
  installDragSelect(container, state);
}

function dispatchRowAction(action, nodeId, opts) {
  if (!storedState) return;
  const refresh = () => refreshList(storedState);
  if (action === "rename") {
    handleRename(nodeId, opts?.anchor || null, storedState, refresh);
  } else if (action === "duplicate") {
    handleDuplicate(nodeId, storedState, refresh);
  } else if (action === "convert-container") {
    handleConvertContainer(nodeId, opts?.targetType, storedState, refresh);
  } else if (action === "delete") {
    handleDelete(nodeId, storedState, refresh);
  } else if (action === "flag") {
    storedState.toggleFlagged(nodeId).then(refresh);
  } else if (action === "use-as-note") {
    storedState.toggleUseAsNote(nodeId).then(refresh);
  } else if (action === "reveal-in-finder") {
    handleRevealInFinder(nodeId, storedState);
  } else if (action === "empty-trash") {
    handleEmptyTrash(storedState, refresh);
  } else if (action === "open-as-stack") {
    handleOpenAsStack(nodeId, storedState, refresh);
  } else if (action === "convert-project-to-doc") {
    handleConvertProjectToDoc(nodeId, storedState, refresh);
  } else if (action === "convert-doc-to-project") {
    handleConvertDocToProject(nodeId, storedState, refresh);
  } else if (action === "split-at-headings") {
    import("./split-at-headings-modal.js").then((m) => m.openSplitAtHeadingsModal(storedState, nodeId));
  } else if (action === "convert-headings-to-tabs") {
    import("./convert-headings-to-tabs-modal.js").then((m) => m.openConvertHeadingsToTabsModal(storedState, nodeId));
  } else if (action === "toggle-numbering") {
    const node = findNode(storedState.fileTree, nodeId);
    if (node) {
      node.showNumbers = !node.showNumbers;
      storedState.saveFileTree();
      storedState.emit("files-changed");
    }
  } else if (action === "set-color") {
    const node = findNode(storedState.fileTree, nodeId);
    if (node) {
      if (opts?.colorKey) node.bgColor = opts.colorKey;
      else delete node.bgColor;
      storedState.saveFileTree();
      refresh();
    }
    return;
  } else if (action === "new-doc-here") {
    storedState.newFile(nodeId).then(refresh);
  } else if (action === "new-notebook-here") {
    showPromptModal({
      title: "New notebook",
      label: "Name",
      placeholder: "New Notebook",
      initialValue: "New Notebook",
      confirmLabel: "Create",
      onConfirm: async (name) => {
        await storedState.createNotebook(name, nodeId);
        refresh();
      },
    });
  } else if (action === "restore") {
    handleRestore(nodeId, storedState, refresh);
  } else if (action === "permanent-delete") {
    handlePermanentDelete(nodeId, storedState, refresh);
  }
}

function onActionClick(e) {
  const actionBtn = e.target.closest("[data-tree-action]");
  if (!actionBtn) return;
  e.stopPropagation();

  const action = actionBtn.dataset.treeAction;
  const actionsEl = actionBtn.closest(".tree-actions");
  const nodeId = actionsEl?.dataset.nodeId;
  if (!nodeId || !storedState) return;

  if (action === "open-menu") {
    const flagOnly = actionBtn.dataset.menuFlagOnly === "1";
    openRowMenu(actionBtn, nodeId, storedState, flagOnly, dispatchRowAction);
    return;
  }
  dispatchRowAction(action, nodeId, { anchor: actionBtn, targetType: actionBtn.dataset.targetType });
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
  // A gutter notebook is stored as `<docName>-gutter` (to avoid same-name
  // collisions) but reads as just "Gutter" beneath its doc.
  const displayName = (item.type === "notebook" && item.gutter) ? "Gutter" : item.name;
  itemRow.innerHTML = `${getIcon(item)}<span class="tree-item-name">${escHtml(displayName)}</span>${button}`;
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
  } else if (item.type === "pdf" && item.fileId) {
    state.openPdf(item.fileId);
    if (!isInset && storedHidePanel) storedHidePanel();
  } else if (item.type === "project") {
    state.openProject(item.id);
    if (!isInset && storedHidePanel) storedHidePanel();
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
  if (item.type === "pdf" && item.fileId) {
    return item.fileId === state.currentPdfFileId;
  }
  if (item.type === "stack" && item.fileId) {
    return item.fileId === state.currentStackFileId;
  }
  if (item.type === "project") return item.id === state.currentProjectId;
  return false;
}

function refreshList(state) {
  if (sortableInstance) {
    reapplyGutterMarkers(state.fileTree);
    const sorted = augmentTreeWithTabs(state, sortFlaggedItems(normalizeProjectChildren(visibleTopLevel(state))));
    numberLabels = computeNumberLabels(sorted, numberSkip, isInboxId);
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

/** Debounced refresh triggered by `doc-content-changed`. Editing a doc
 *  shouldn't repaint the panel on every keystroke, but tab markers
 *  added or renamed mid-session should land in the sidebar without
 *  forcing the user to switch files. 600 ms keeps the cadence calm
 *  while still feeling live. */
let _tabRefreshTimer = null;
function scheduleTabRefresh(state) {
  if (_tabRefreshTimer) clearTimeout(_tabRefreshTimer);
  _tabRefreshTimer = setTimeout(() => {
    _tabRefreshTimer = null;
    refreshList(state);
  }, 600);
}

export function refreshFilesPanel(state) {
  refreshList(state);
  // Re-render the local-sync section too. Prefer the cached reference,
  // falling back to a live DOM query if it got out of sync.
  const cached = getLocalSyncContainer();
  const root = cached?.isConnected ? cached : document.querySelector(".local-sync-root");
  if (root && storedState && storedHidePanel) {
    renderLocalSyncSection(root, storedState, storedHidePanel, refreshFilesPanel);
  }
}

/** Wire one-shot state listeners that keep the synthetic tab-marker
 *  rows in sync with the active editor. Idempotent — calling more
 *  than once is a no-op so the boot path can call it safely. */
let _tabSyncWired = false;
export function initFilesPanelTabSync(state) {
  if (_tabSyncWired) return;
  _tabSyncWired = true;
  state.on("doc-content-changed", () => scheduleTabRefresh(state));
}

async function openImagePreview(filename, name) {
  const { openImagePreviewModal } = await import("../editor/image-preview.js");
  openImagePreviewModal(filename, name);
}

function attachImageTooltipToRow(rowEl, filename, name) {
  import("../editor/image-preview.js").then(({ attachImageHoverTooltip }) => attachImageHoverTooltip(rowEl, filename, name));
}
