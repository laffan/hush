/**
 * Stack list view — a simple ordered list of all stack items with
 * reorder handles and close buttons. Toggled via a button beside the
 * floating add button.
 */

import { typeIcons, escHtml } from "../sidebar/files-panel-shared.js";
import { findNodeByFileId } from "../state/tree-helpers.js";

export function createStackListView(stackComponent, state) {
  let visible = false;
  const backdrop = document.createElement("div");
  backdrop.className = "stack-list-backdrop";

  const panel = document.createElement("div");
  panel.className = "stack-list-panel";
  backdrop.appendChild(panel);

  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) hide(); });

  function show() {
    visible = true;
    render();
    document.body.appendChild(backdrop);
    backdrop.addEventListener("keydown", onKey);
  }

  function hide() {
    visible = false;
    backdrop.remove();
    backdrop.removeEventListener("keydown", onKey);
  }

  function toggle() { visible ? hide() : show(); }

  function onKey(e) { if (e.key === "Escape") hide(); }

  function render() {
    const items = stackComponent._items;
    panel.innerHTML = "";

    const header = document.createElement("div");
    header.className = "stack-list-header";
    header.textContent = `Stack items (${items.length})`;
    panel.appendChild(header);

    const list = document.createElement("div");
    list.className = "stack-list-items";

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const row = document.createElement("div");
      row.className = "stack-list-row";
      if (!item.open) row.classList.add("stack-list-row-closed");

      const icon = typeIcons[item.fileType] || typeIcons.document;
      const name = resolveName(item, state);

      row.innerHTML = `
        <span class="stack-list-drag" data-idx="${i}">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/><circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/></svg>
        </span>
        <span class="stack-list-icon">${icon}</span>
        <span class="stack-list-name">${escHtml(name)}</span>
        <span class="stack-list-status">${item.open ? "" : "closed"}</span>
        <button class="stack-list-close" data-idx="${i}">×</button>
      `;
      if (item.spineColor) {
        const iconEl = row.querySelector(".stack-list-icon svg");
        if (iconEl) { iconEl.style.stroke = item.spineColor; iconEl.style.opacity = "1"; }
      }
      list.appendChild(row);
    }

    panel.appendChild(list);

    // Wire close buttons
    list.querySelectorAll(".stack-list-close").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx, 10);
        const item = items[idx];
        if (item) { stackComponent.removeItem(item.id); render(); }
      });
    });

    // Wire drag reorder
    let dragIdx = -1;
    list.querySelectorAll(".stack-list-drag").forEach((handle) => {
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        dragIdx = parseInt(handle.dataset.idx, 10);
        const rows = Array.from(list.querySelectorAll(".stack-list-row"));
        const dragRow = rows[dragIdx];
        if (!dragRow) return;
        dragRow.classList.add("stack-list-row-dragging");

        const onMove = (ev) => {
          let targetIdx = rows.length;
          for (let j = 0; j < rows.length; j++) {
            const rect = rows[j].getBoundingClientRect();
            if (ev.clientY < rect.top + rect.height / 2) { targetIdx = j; break; }
          }
          list.querySelectorAll(".stack-list-drop").forEach((d) => d.remove());
          if (targetIdx !== dragIdx && targetIdx !== dragIdx + 1) {
            const marker = document.createElement("div");
            marker.className = "stack-list-drop";
            const refRow = rows[targetIdx] || null;
            list.insertBefore(marker, refRow);
          }
        };

        const onUp = (ev) => {
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          dragRow.classList.remove("stack-list-row-dragging");
          list.querySelectorAll(".stack-list-drop").forEach((d) => d.remove());

          let targetIdx = rows.length;
          for (let j = 0; j < rows.length; j++) {
            const rect = rows[j].getBoundingClientRect();
            if (ev.clientY < rect.top + rect.height / 2) { targetIdx = j; break; }
          }
          if (targetIdx !== dragIdx && targetIdx !== dragIdx + 1) {
            const [moved] = items.splice(dragIdx, 1);
            const insertAt = targetIdx > dragIdx ? targetIdx - 1 : targetIdx;
            items.splice(insertAt, 0, moved);
            // Sync DOM in the stack
            const cols = stackComponent._columnsEl;
            const colEls = Array.from(cols.querySelectorAll(".stack-column"));
            const dragCol = colEls[dragIdx];
            const refCol = colEls[insertAt] || stackComponent._trailResize;
            if (dragCol) cols.insertBefore(dragCol, refCol);
            render();
          }
        };

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
      });
    });
  }

  return { show, hide, toggle };
}

function resolveName(item, state) {
  if (item.name) return item.name;
  const node = findNodeByFileId(state.fileTree, item.fileId);
  return node?.name || "Untitled";
}
