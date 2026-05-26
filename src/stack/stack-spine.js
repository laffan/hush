/**
 * Stack spine — the 50px-wide vertical sidebar on each stack column.
 * Shows the filename vertically, plus toggle, drag handle, and color
 * picker buttons at the bottom.
 */

import { findNodeByFileId } from "../state/tree-helpers.js";

const SPINE_WIDTH = 50;

export function createSpine(item, { onToggle, onColorChange, onDragStart }) {
  const spine = document.createElement("div");
  spine.className = "stack-spine";
  if (item.spineColor) spine.style.backgroundColor = item.spineColor;

  // Vertical filename label at the top
  const label = document.createElement("div");
  label.className = "stack-spine-label";
  label.textContent = resolveItemName(item);
  spine.appendChild(label);

  // Bottom button cluster
  const buttons = document.createElement("div");
  buttons.className = "stack-spine-buttons";

  // Color picker button
  const colorBtn = document.createElement("button");
  colorBtn.className = "stack-spine-btn stack-spine-color-btn";
  colorBtn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5"/></svg>`;
  colorBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openColorPicker(colorBtn, item.spineColor, (color) => {
      onColorChange(color);
      // Update the circle fill to show the chosen color
      const circle = colorBtn.querySelector("circle");
      if (circle) circle.setAttribute("fill", color || "none");
    });
  });
  buttons.appendChild(colorBtn);

  // Drag handle
  const dragBtn = document.createElement("button");
  dragBtn.className = "stack-spine-btn stack-spine-drag-btn";
  dragBtn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/><circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/></svg>`;
  dragBtn.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    onDragStart(e);
  });
  buttons.appendChild(dragBtn);

  // Toggle open/close
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "stack-spine-btn stack-spine-toggle-btn";
  toggleBtn.innerHTML = item.open
    ? `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="10 3 5 8 10 13"/></svg>`
    : `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 3 11 8 6 13"/></svg>`;
  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onToggle();
    // Flip the chevron
    toggleBtn.innerHTML = item.open
      ? `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 3 11 8 6 13"/></svg>`
      : `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="10 3 5 8 10 13"/></svg>`;
  });
  buttons.appendChild(toggleBtn);

  spine.appendChild(buttons);
  return spine;
}

function resolveItemName(item) {
  // The name might be stored on the item or we need to look it up
  if (item.name) return item.name;
  // Fallback: try window state
  const state = window.__hushState__;
  if (state) {
    const node = findNodeByFileId(state.fileTree, item.fileId);
    if (node) return node.name;
  }
  return "Untitled";
}

// --- Color picker popup ---

const PRESET_COLORS = [
  null, // "no color" / default
  "#ef4444", "#f97316", "#eab308",
  "#22c55e", "#3b82f6", "#8b5cf6",
  "#ec4899", "#6b7280", "#1e293b",
];

function openColorPicker(anchorEl, currentColor, onPick) {
  // Remove any existing picker
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
    if (color === currentColor || (!color && !currentColor)) {
      swatch.classList.add("stack-color-swatch-active");
    }
    swatch.addEventListener("click", () => {
      onPick(color);
      picker.remove();
      cleanup();
    });
    picker.appendChild(swatch);
  }

  document.body.appendChild(picker);

  // Position above the anchor
  const rect = anchorEl.getBoundingClientRect();
  picker.style.left = (rect.right + 8) + "px";
  picker.style.top = (rect.top - picker.offsetHeight / 2 + rect.height / 2) + "px";

  const cleanup = () => {
    document.removeEventListener("pointerdown", onOutside);
    document.removeEventListener("keydown", onEsc);
  };
  const onOutside = (e) => {
    if (!picker.contains(e.target) && !anchorEl.contains(e.target)) {
      picker.remove();
      cleanup();
    }
  };
  const onEsc = (e) => {
    if (e.key === "Escape") { picker.remove(); cleanup(); }
  };
  setTimeout(() => {
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("keydown", onEsc);
  }, 0);
}
