/**
 * Stack spine — the 50px-wide vertical sidebar on each stack column.
 * Top: type icon, centered: filename (vertical). Bottom: color, drag
 * (reorder), close (X). Clicking the spine body (outside buttons)
 * toggles the column open/closed. Left edge is a resize affordance
 * for the item to the left.
 */

import { findNodeByFileId } from "../state/tree-helpers.js";
import { typeIcons } from "../sidebar/files-panel-shared.js";

export function createSpine(item, { onToggle, onClose, onColorChange, onDragStart, onResizeStart }) {
  const spine = document.createElement("div");
  spine.className = "stack-spine";
  if (item.spineColor) spine.style.backgroundColor = item.spineColor;

  // Left-edge resize zone
  spine.addEventListener("pointerdown", (e) => {
    if (e.offsetX > 6) return;
    e.stopPropagation();
    onResizeStart(e);
  });

  // Click the spine body to toggle open/close
  spine.addEventListener("click", (e) => {
    if (e.target.closest(".stack-spine-btn")) return;
    onToggle();
  });
  spine.style.cursor = "pointer";

  // Icon at top
  const iconEl = document.createElement("div");
  iconEl.className = "stack-spine-icon";
  iconEl.innerHTML = typeIcons[item.fileType] || typeIcons.document;
  spine.appendChild(iconEl);

  // Centered label
  const label = document.createElement("div");
  label.className = "stack-spine-label";
  label.textContent = resolveItemName(item);
  spine.appendChild(label);

  // Bottom button cluster
  const buttons = document.createElement("div");
  buttons.className = "stack-spine-buttons";

  const colorBtn = makeBtn("stack-spine-color-btn",
    `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5"/></svg>`);
  colorBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openColorPicker(colorBtn, item.spineColor, (color) => {
      onColorChange(color);
      const c = colorBtn.querySelector("circle");
      if (c) c.setAttribute("fill", color || "none");
    });
  });
  buttons.appendChild(colorBtn);

  const dragBtn = makeBtn("stack-spine-drag-btn",
    `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/><circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/></svg>`);
  dragBtn.addEventListener("pointerdown", (e) => { e.stopPropagation(); onDragStart(e); });
  buttons.appendChild(dragBtn);

  const closeBtn = makeBtn("stack-spine-close-btn",
    `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`);
  closeBtn.addEventListener("click", (e) => { e.stopPropagation(); onClose(); });
  buttons.appendChild(closeBtn);

  spine.appendChild(buttons);
  return spine;
}

function makeBtn(cls, html) {
  const b = document.createElement("button");
  b.className = "stack-spine-btn " + cls;
  b.innerHTML = html;
  return b;
}

function resolveItemName(item) {
  if (item.name) return item.name;
  const state = window.__hushState__;
  if (state) {
    const node = findNodeByFileId(state.fileTree, item.fileId);
    if (node) return node.name;
  }
  return "Untitled";
}

const PRESET_COLORS = [
  null, "#ef4444", "#f97316", "#eab308",
  "#22c55e", "#3b82f6", "#8b5cf6",
  "#ec4899", "#6b7280", "#1e293b",
];

function openColorPicker(anchorEl, currentColor, onPick) {
  document.querySelectorAll(".stack-color-picker").forEach((el) => el.remove());
  const picker = document.createElement("div");
  picker.className = "stack-color-picker";
  for (const color of PRESET_COLORS) {
    const swatch = document.createElement("button");
    swatch.className = "stack-color-swatch";
    if (color) swatch.style.backgroundColor = color;
    else { swatch.classList.add("stack-color-swatch-none"); swatch.innerHTML = "×"; }
    if (color === currentColor || (!color && !currentColor)) swatch.classList.add("stack-color-swatch-active");
    swatch.addEventListener("click", () => { onPick(color); picker.remove(); cleanup(); });
    picker.appendChild(swatch);
  }
  document.body.appendChild(picker);
  const rect = anchorEl.getBoundingClientRect();
  picker.style.left = (rect.right + 8) + "px";
  picker.style.top = (rect.top - picker.offsetHeight / 2 + rect.height / 2) + "px";
  const cleanup = () => { document.removeEventListener("pointerdown", onOut); document.removeEventListener("keydown", onEsc); };
  const onOut = (e) => { if (!picker.contains(e.target) && !anchorEl.contains(e.target)) { picker.remove(); cleanup(); } };
  const onEsc = (e) => { if (e.key === "Escape") { picker.remove(); cleanup(); } };
  setTimeout(() => { document.addEventListener("pointerdown", onOut); document.addEventListener("keydown", onEsc); }, 0);
}
