/**
 * Sortable list rendering — builds DOM from tree data
 */

import { pathsEqual } from "./utils.js";

export function renderList(items, container, path, ctx) {
  const { config, state, onFoldToggle, onItemMouseEnter, onItemMouseLeave } = ctx;

  container.dataset.path = path.join("/");
  container.classList.add("sl-list");

  items.forEach((item, index) => {
    const itemPath = [...path, index];
    const itemId = config.getId(item);
    const children = config.getChildren(item);
    const hasChildren = children && children.length > 0;
    const isNestable = config.canNest(item);
    const isCollapsed = state.collapsedIds.has(itemId);

    const li = document.createElement("li");
    li.className = "sl-item";
    li.dataset.id = itemId;
    li.dataset.path = itemPath.join("/");
    li.dataset.depth = String(path.length);
    li.dataset.canNest = String(isNestable);
    if (item && typeof item.type === "string") li.dataset.type = item.type;
    // Mark "Use as Note" docs so the project-children CSS can paint
    // them at 50 % opacity alongside notebooks. Persisted on the tree
    // node and read straight off the rendered item.
    if (item && item.useAsNote) li.dataset.useAsNote = "true";

    if (state.selectedPath && pathsEqual(itemPath, state.selectedPath)) {
      li.classList.add("selected");
      if (state.isMoving) li.classList.add("moving");
    }

    const contentWrapper = document.createElement("div");
    contentWrapper.className = "sl-item-content";

    // Fold arrow — all items get consistent spacing; only show arrow when there are children
    const foldArrow = document.createElement("button");
    foldArrow.className = "sl-fold-arrow";
    foldArrow.type = "button";
    if (hasChildren) {
      foldArrow.textContent = isCollapsed ? "\u25B6\uFE0E" : "\u25BC";
      foldArrow.dataset.itemId = itemId;
      foldArrow.setAttribute("aria-label", isCollapsed ? "Expand" : "Collapse");
      foldArrow.addEventListener("click", onFoldToggle);
      li.classList.add("has-children");
      if (isCollapsed) li.classList.add("collapsed");
    } else {
      foldArrow.classList.add("sl-fold-empty");
      foldArrow.tabIndex = -1;
    }
    contentWrapper.appendChild(foldArrow);

    // Render item content via callback. `li` is exposed so callers
    // can attach state-driven classes to the outer row element
    // (e.g. multi-select highlight) without a follow-up query pass.
    const content = config.renderItem(item, {
      depth: path.length,
      isSelected: state.selectedPath && pathsEqual(itemPath, state.selectedPath),
      isMoving: state.isMoving,
      isDragging: false,
      isCollapsed,
      hasChildren,
      li,
    });

    const labelContainer = document.createElement("span");
    labelContainer.className = "sl-item-label";

    const mainLabel = document.createElement("span");
    mainLabel.className = "sl-item-main-label";
    if (typeof content === "string") {
      if (content.includes("<")) {
        mainLabel.innerHTML = content;
      } else {
        mainLabel.textContent = content;
      }
    } else {
      mainLabel.appendChild(content);
    }
    labelContainer.appendChild(mainLabel);

    contentWrapper.appendChild(labelContainer);
    li.appendChild(contentWrapper);

    li.addEventListener("mouseenter", (e) => {
      // Remove sl-hovered from any ancestor sl-items to prevent parent hover leak
      let ancestor = li.parentElement?.closest(".sl-item");
      while (ancestor) {
        ancestor.classList.remove("sl-hovered");
        ancestor = ancestor.parentElement?.closest(".sl-item");
      }
      li.classList.add("sl-hovered");
      onItemMouseEnter(e);
    });
    li.addEventListener("mouseleave", (e) => {
      li.classList.remove("sl-hovered");
      // Re-add sl-hovered to immediate parent sl-item if mouse is still over it
      const parentItem = li.parentElement?.closest(".sl-item");
      if (parentItem) parentItem.classList.add("sl-hovered");
      onItemMouseLeave(e);
    });

    // Render children if not collapsed
    if (hasChildren && !isCollapsed) {
      const childList = document.createElement("ul");
      childList.className = "sl-list";
      renderList(children, childList, itemPath, ctx);
      li.appendChild(childList);
    }

    container.appendChild(li);
  });
}
