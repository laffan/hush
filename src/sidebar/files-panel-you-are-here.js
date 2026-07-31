/**
 * The sidebar's YOU ARE HERE rows — one red `YOU ARE HERE : <filename>`
 * chip per visible desk holding a YOUAREHERE marker, pinned above the
 * Flagged list. Clicking jumps to the file AND to the marker's position
 * inside it (doc scroll / notebook pan). Split out of files-panel.js
 * for the 700-line cap.
 */
import { escHtml } from "./files-panel-shared.js";
import { isAllDesksMode } from "./files-panel-rows.js";
import { youAreHereEntriesFor, jumpToYouAreHere } from "../you-are-here.js";

/** Append the marker rows (if any) to `containerEl`. `hidePanel` is the
 *  files panel's overlay-dismiss callback (null when inset). */
export function renderYouAreHereRows(state, containerEl, hidePanel) {
  let entries = [];
  try {
    const deskIds = isAllDesksMode(state)
      ? (state.settings?.desks || []).map((d) => d.id)
      : [state.getActiveDesk?.()?.id].filter(Boolean);
    entries = youAreHereEntriesFor(state, deskIds);
  } catch (_) { return; }
  for (const entry of entries) {
    const li = document.createElement("li");
    li.className = "sl-item yah-row";
    const content = document.createElement("div");
    content.className = "sl-item-content";
    const spacer = document.createElement("button");
    spacer.className = "sl-fold-arrow sl-fold-empty";
    spacer.type = "button";
    spacer.tabIndex = -1;
    content.appendChild(spacer);
    const label = document.createElement("span");
    label.className = "sl-item-label";
    const main = document.createElement("span");
    main.className = "sl-item-main-label";
    const row = document.createElement("span");
    row.className = "tree-item-row";
    row.innerHTML = `<span class="yah-badge">YOU ARE HERE : ${escHtml(entry.fileName)}</span>`;
    main.appendChild(row);
    label.appendChild(main);
    content.appendChild(label);
    li.appendChild(content);
    content.addEventListener("click", () => {
      void jumpToYouAreHere(state, entry);
      const isInset = document.querySelector("#panel-overlay")?.classList.contains("panel-inset");
      if (!isInset && hidePanel) hidePanel();
    });
    containerEl.appendChild(li);
  }
}
