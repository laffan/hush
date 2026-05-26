/**
 * Stack spine — the 50px-wide vertical sidebar on each stack column.
 * Top: type icon + filename (vertical). Bottom: buttons for color,
 * resize (resizes item to the LEFT), drag (reorder), toggle.
 */

import { findNodeByFileId } from "../state/tree-helpers.js";
import { typeIcons } from "../sidebar/files-panel-shared.js";

export function createSpine(item, { onToggle, onColorChange, onDragStart, onResizeStart }) {
  const spine = document.createElement("div");
  spine.className = "stack-spine";
  if (item.spineColor) spine.style.backgroundColor = item.spineColor;

  // Top section: type icon + vertical filename
  const header = document.createElement("div");
  header.className = "stack-spine-header";

  const iconEl = document.createElement("div");
  iconEl.className = "stack-spine-icon";
  iconEl.innerHTML = typeIcons[item.fileType] || typeIcons.document;
  header.appendChild(iconEl);

  const label = document.createElement("div");
  label.className = "stack-spine-label";
  label.textContent = resolveItemName(item);
  header.appendChild(label);

  spine.appendChild(header);

  // Bottom button cluster
  const buttons = document.createElement("div");
  buttons.className = "stack-spine-buttons";

  // Color picker
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

  // Resize handle (resizes item to the LEFT of this spine)
  const resizeBtn = makeBtn("stack-spine-resize-btn",
    `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="8" x2="14" y2="8"/><polyline points="4,5.5 2,8 4,10.5"/><polyline points="12,5.5 14,8 12,10.5"/></svg>`);
  resizeBtn.addEventListener("pointerdown", (e) => { e.stopPropagation(); onResizeStart(e); });
  buttons.appendChild(resizeBtn);

  // Drag handle (reorder)
  const dragBtn = makeBtn("stack-spine-drag-btn",
    `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/><circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/></svg>`);
  dragBtn.addEventListener("pointerdown", (e) => { e.stopPropagation(); onDragStart(e); });
  buttons.appendChild(dragBtn);

  // Toggle open/close
  const toggleBtn = makeBtn("stack-spine-toggle-btn", toggleSvg(item.open));
  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onToggle();
    toggleBtn.innerHTML = toggleSvg(item.open);
  });
  buttons.appendChild(toggleBtn);

  spine.appendChild(buttons);
  return spine;
}

function makeBtn(cls, html) {
  const b = document.createElement("button");
  b.className = "stack-spine-btn " + cls;
  b.innerHTML = html;
  return b;
}

function toggleSvg(open) {
  return open
    ? `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="10 3 5 8 10 13"/></svg>`
    : `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 3 11 8 6 13"/></svg>`;
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

// --- Color picker popup ---

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
    if (color) {
      swatch.style.backgroundColor = color;
    } else {
      swatch.classList.add("stack-color-swatch-none");
      swatch.innerHTML = "×";
    }
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
