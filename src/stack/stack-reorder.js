const SPINE_WIDTH = 50;
const SPINE_HEIGHT = 40;
const DEFAULT_COLUMN_WIDTH = 800;
const DEFAULT_COLUMN_HEIGHT = 600;

export function startReorder(stack, itemId, e) {
  e.preventDefault();
  const idx = stack._items.findIndex((i) => i.id === itemId);
  if (idx < 0) return;
  const item = stack._items[idx];
  const dragCol = stack._columnsEl.querySelector(`[data-item-id="${itemId}"]`);
  if (!dragCol) return;

  const savedStates = stack._items.map((it) => ({ id: it.id, open: it.open }));
  const dragRect = dragCol.getBoundingClientRect();
  const scrollRect = stack._scrollArea.getBoundingClientRect();
  const isVert = stack._isVertical;

  stack._columnsEl.classList.add("stack-reordering");

  for (const it of stack._items) {
    const col = stack._columnsEl.querySelector(`[data-item-id="${it.id}"]`);
    if (!col) continue;
    if (it.id === itemId) {
      col.style.display = "none";
    } else {
      col.classList.add("stack-column-closed");
      if (isVert) {
        col.style.height = SPINE_HEIGHT + "px";
      } else {
        col.style.width = SPINE_WIDTH + "px";
      }
      const contentEl = col.querySelector(".stack-column-content");
      if (contentEl) contentEl.style.display = "none";
    }
  }

  const spacer = document.createElement("div");
  spacer.className = "stack-reorder-spacer";
  if (isVert) {
    const viewportCenter = dragRect.top - scrollRect.top + dragRect.height / 2;
    const aboveSpinesHeight = idx * SPINE_HEIGHT;
    const spacerHeight = Math.max(0, viewportCenter - aboveSpinesHeight - SPINE_HEIGHT / 2);
    spacer.style.height = spacerHeight + "px";
  } else {
    const viewportCenter = dragRect.left - scrollRect.left + dragRect.width / 2;
    const leftSpinesWidth = idx * SPINE_WIDTH;
    const spacerWidth = Math.max(0, viewportCenter - leftSpinesWidth - SPINE_WIDTH / 2);
    spacer.style.width = spacerWidth + "px";
  }
  spacer.style.flexShrink = "0";
  stack._columnsEl.insertBefore(spacer, stack._columnsEl.firstChild);
  if (isVert) { stack._scrollArea.scrollTop = 0; } else { stack._scrollArea.scrollLeft = 0; }

  const ghost = document.createElement("div");
  ghost.className = "stack-reorder-ghost";
  if (isVert) ghost.classList.add("stack-reorder-ghost-vertical");
  const spineEl = dragCol.querySelector(".stack-spine");
  if (spineEl) ghost.innerHTML = spineEl.innerHTML;
  if (isVert) {
    ghost.style.width = stack._scrollArea.clientWidth + "px";
    ghost.style.height = SPINE_HEIGHT + "px";
    ghost.style.left = scrollRect.left + "px";
    ghost.style.top = (e.clientY - SPINE_HEIGHT / 2) + "px";
  } else {
    ghost.style.height = stack._scrollArea.clientHeight + "px";
    ghost.style.left = (e.clientX - SPINE_WIDTH / 2) + "px";
    ghost.style.top = scrollRect.top + "px";
  }
  document.body.appendChild(ghost);

  let insertIdx = idx;

  const onMove = (ev) => {
    if (isVert) {
      ghost.style.top = (ev.clientY - SPINE_HEIGHT / 2) + "px";
    } else {
      ghost.style.left = (ev.clientX - SPINE_WIDTH / 2) + "px";
    }

    const allCols = Array.from(stack._columnsEl.querySelectorAll(".stack-column"));
    const otherCols = allCols.filter((c) => c !== dragCol);
    let newIdx = otherCols.length;
    for (let i = 0; i < otherCols.length; i++) {
      const rect = otherCols[i].getBoundingClientRect();
      if (isVert) {
        if (ev.clientY < rect.top + rect.height / 2) { newIdx = i; break; }
      } else {
        if (ev.clientX < rect.left + rect.width / 2) { newIdx = i; break; }
      }
    }
    if (newIdx !== insertIdx) {
      insertIdx = newIdx;
      stack._columnsEl.querySelectorAll(".stack-drop-indicator").forEach((el) => el.remove());
      const indicator = document.createElement("div");
      indicator.className = "stack-drop-indicator";
      const refCol = otherCols[insertIdx] || stack._trailResize;
      stack._columnsEl.insertBefore(indicator, refCol);
    }
  };

  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    ghost.remove();
    spacer.remove();
    stack._columnsEl.querySelectorAll(".stack-drop-indicator").forEach((el) => el.remove());

    stack._columnsEl.classList.remove("stack-reordering");
    dragCol.style.display = "";
    if (isVert) {
      dragCol.style.minHeight = SPINE_HEIGHT + "px";
    } else {
      dragCol.style.minWidth = SPINE_WIDTH + "px";
    }

    const currentIdx = stack._items.findIndex((i) => i.id === itemId);
    stack._items.splice(currentIdx, 1);
    stack._items.splice(insertIdx, 0, item);
    const otherCols = Array.from(stack._columnsEl.querySelectorAll(".stack-column")).filter((c) => c !== dragCol);
    const refNode = otherCols[insertIdx] || stack._trailResize;
    stack._columnsEl.insertBefore(dragCol, refNode);

    for (const saved of savedStates) {
      const it = stack._items.find((i) => i.id === saved.id);
      if (!it) continue;
      it.open = saved.open;
      const col = stack._columnsEl.querySelector(`[data-item-id="${saved.id}"]`);
      if (!col) continue;
      if (it.open) {
        col.classList.remove("stack-column-closed");
        if (isVert) {
          col.style.height = (SPINE_HEIGHT + (it.height || DEFAULT_COLUMN_HEIGHT)) + "px";
        } else {
          col.style.width = (SPINE_WIDTH + (it.width || DEFAULT_COLUMN_WIDTH)) + "px";
        }
        const contentEl = col.querySelector(".stack-column-content");
        if (contentEl) contentEl.style.display = "block";
      } else {
        col.classList.add("stack-column-closed");
        if (isVert) {
          col.style.height = SPINE_HEIGHT + "px";
        } else {
          col.style.width = SPINE_WIDTH + "px";
        }
      }
    }
    stack._updateVisibility();
  };
  if (!isVert) ghost.style.top = stack._scrollArea.getBoundingClientRect().top + "px";

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}
