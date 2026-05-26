/**
 * Fuzzy file picker for adding items to a stack. Reuses the command
 * palette's file-collecting infrastructure but renders its own modal
 * scoped to docs, notebooks, PDFs, and stacks.
 */

import { findNode } from "../state/tree-helpers.js";
import { typeIcons, escHtml } from "../sidebar/files-panel-shared.js";

const ELIGIBLE_TYPES = new Set(["document", "notebook", "pdf"]);

export function openStackFilePicker(state, onPick) {
  // Collect eligible files from the active desk
  const leaves = [];
  const deskId = state.settings?.activeDeskId;
  const deskNode = deskId ? findNode(state.fileTree, deskId) : null;
  const root = deskNode ? deskNode.children : state.fileTree;

  function walk(nodes, breadcrumb) {
    for (const node of nodes) {
      if (node.id?.startsWith("__trash__") || node.id?.startsWith("__images__")) continue;
      if (ELIGIBLE_TYPES.has(node.type) && node.fileId) {
        leaves.push({
          fileId: node.fileId,
          type: node.type,
          name: node.name,
          breadcrumb,
        });
      }
      if (node.children?.length) {
        const skipInbox = node.id?.startsWith("__inbox__");
        walk(node.children, skipInbox ? breadcrumb : (breadcrumb ? breadcrumb + " / " + node.name : node.name));
      }
    }
  }
  walk(root, "");

  // Build modal
  const backdrop = document.createElement("div");
  backdrop.className = "stack-picker-backdrop";

  const modal = document.createElement("div");
  modal.className = "stack-picker-modal";

  const input = document.createElement("input");
  input.className = "stack-picker-input";
  input.type = "text";
  input.placeholder = "Search files to add...";
  modal.appendChild(input);

  const list = document.createElement("div");
  list.className = "stack-picker-list";
  modal.appendChild(list);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  let activeIdx = 0;
  let filtered = leaves.slice();

  function renderList() {
    const q = input.value.toLowerCase().trim();
    filtered = q
      ? leaves.filter((l) => l.name.toLowerCase().includes(q) || l.breadcrumb.toLowerCase().includes(q))
      : leaves.slice();

    list.innerHTML = "";
    if (filtered.length === 0) {
      list.innerHTML = `<div class="stack-picker-empty">No files found</div>`;
      return;
    }
    activeIdx = Math.min(activeIdx, filtered.length - 1);

    for (let i = 0; i < filtered.length; i++) {
      const item = filtered[i];
      const row = document.createElement("div");
      row.className = "stack-picker-row" + (i === activeIdx ? " active" : "");
      const icon = typeIcons[item.type] || typeIcons.document;
      const crumb = item.breadcrumb ? `<span class="stack-picker-crumb">${escHtml(item.breadcrumb)} / </span>` : "";
      row.innerHTML = `${icon}${crumb}<span class="stack-picker-name">${escHtml(item.name)}</span>`;
      row.addEventListener("click", () => pick(item));
      row.addEventListener("pointerenter", () => {
        activeIdx = i;
        updateActive();
      });
      list.appendChild(row);
    }
  }

  function updateActive() {
    const rows = list.querySelectorAll(".stack-picker-row");
    rows.forEach((r, i) => r.classList.toggle("active", i === activeIdx));
  }

  function pick(item) {
    close();
    onPick(item.fileId, item.type, item.name);
  }

  function close() {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  }

  function onKey(e) {
    if (e.key === "Escape") { close(); e.stopPropagation(); }
    else if (e.key === "ArrowDown") { activeIdx = Math.min(activeIdx + 1, filtered.length - 1); updateActive(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { activeIdx = Math.max(activeIdx - 1, 0); updateActive(); e.preventDefault(); }
    else if (e.key === "Enter" && filtered.length > 0) { pick(filtered[activeIdx]); e.preventDefault(); }
  }

  input.addEventListener("input", () => { activeIdx = 0; renderList(); });
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  renderList();
  input.focus();
}
