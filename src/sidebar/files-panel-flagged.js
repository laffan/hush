/**
 * The sidebar's virtual Flagged folder — a synthetic section above the
 * main tree listing every flagged item in the visible desk(s), with the
 * YOU ARE HERE marker row(s) pinned above it. Split out of
 * files-panel.js for the 700-line cap.
 *
 * `renderFlaggedSection(state, refs)` re-renders the whole section into
 * `refs.container`; internal interactions (fold arrows, folder toggles)
 * re-render with the refs stored from the last top-level call, matching
 * how files-panel.js itself stashes state/hidePanel.
 */
import { collectFlaggedItems, findAncestorIds } from "../state/tree-helpers.js";
import { typeIcons, escHtml, attachLeafHoverHandlers } from "./files-panel-shared.js";
import { visibleTopLevel, getIcon, flagOnlyButton } from "./files-panel-rows.js";
import { rowColorRgba } from "./files-panel-row-menu.js";
import { renderYouAreHereRows } from "./files-panel-you-are-here.js";

let flaggedCollapsed = false;
// Per-node collapse state for nested entries inside the Flagged section.
// Keyed by the real tree node id — not stored cross-session, matching
// how the main tree's SortableList handles collapse.
const flaggedNodeCollapsed = new Set();

// Refs from the last top-level render: { container, hidePanel, getSortable }.
let _refs = null;

export function renderFlaggedSection(state, refs) {
  if (refs) _refs = refs;
  const container = _refs?.container;
  if (!container) return;
  container.innerHTML = "";

  // YOU ARE HERE — one red marker row per visible desk, pinned above
  // the Flagged list (rendered before the flagged early-return so a
  // desk with no flags still shows its marker).
  renderYouAreHereRows(state, container, _refs.hidePanel);

  // Scope to the visible desk(s) so flagged items stay desk-specific.
  const flaggedItems = collectFlaggedItems(visibleTopLevel(state));
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
  foldArrow.textContent = flaggedCollapsed ? "▶︎" : "▼";
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

  container.appendChild(folderLi);
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
  // Keep the row's highlight tint on its flagged copy (mirrors the main tree).
  const bgRgba = rowColorRgba(item?.bgColor);
  if (bgRgba) li.style.setProperty("--item-bg", bgRgba);

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
    foldBtn.textContent = isCollapsed ? "▶︎" : "▼";
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
  const sortable = _refs?.getSortable?.();
  const ancestors = findAncestorIds(state.fileTree, item.id);
  if (ancestors && sortable) {
    for (const aid of ancestors) {
      sortable.state.collapsedIds.delete(aid);
    }
    sortable.render();
    renderFlaggedSection(state);
  }

  // Open the item
  const hidePanel = _refs?.hidePanel;
  const isInset = document.querySelector("#panel-overlay")?.classList.contains("panel-inset");
  if (item.type === "document" && item.fileId) {
    state.openFile(item.fileId);
    if (!isInset && hidePanel) hidePanel();
  } else if (item.type === "notebook" && item.fileId) {
    state.openNotebook(item.fileId);
    if (!isInset && hidePanel) hidePanel();
  } else if (item.type === "pdf" && item.fileId) {
    state.openPdf(item.fileId);
    if (!isInset && hidePanel) hidePanel();
  } else if (item.type === "project") {
    state.openProject(item.id);
    if (!isInset && hidePanel) hidePanel();
  }
}
