/**
 * Stack spine — the 50px-wide vertical sidebar on each stack column.
 * Top: type icon (click for color picker), centered: filename (vertical).
 * Bottom: drag (reorder), duplicate, pop-out (as pane), close (X).
 * Clicking the spine body (outside buttons) toggles the column open/closed.
 * Left edge is a resize affordance for the item to the left.
 */

import { findNodeByFileId } from "../state/tree-helpers.js";
import { typeIcons } from "../sidebar/files-panel-shared.js";

export function createSpine(item, { onToggle, onToggleAll, onOpenAll, onClose, onColorChange, onDragStart, onResizeStart, onPopOut, onDuplicate }) {
  const spine = document.createElement("div");
  spine.className = "stack-spine";

  // Track whether a resize drag happened so we can suppress the click
  let didResize = false;

  // Left-edge resize zone (6px strip)
  spine.addEventListener("pointerdown", (e) => {
    if (e.offsetX > 6) return;
    e.stopPropagation();
    e.preventDefault();
    didResize = true;
    onResizeStart(e);
  });

  // Click the spine body to toggle open/close
  spine.addEventListener("click", (e) => {
    if (didResize) { didResize = false; return; }
    if (e.target.closest(".stack-spine-btn")) return;
    if (e.target.closest(".stack-spine-icon")) return;
    if (e.metaKey || e.ctrlKey) {
      if (e.shiftKey) { onOpenAll(); } else { onToggleAll(); }
      return;
    }
    onToggle();
  });
  spine.style.cursor = "pointer";

  // Icon at top — click opens color picker
  const iconEl = document.createElement("div");
  iconEl.className = "stack-spine-icon";
  iconEl.innerHTML = typeIcons[item.fileType] || typeIcons.document;
  if (item.spineColor) applyIconColor(iconEl, item.spineColor);
  iconEl.style.cursor = "pointer";
  iconEl.addEventListener("click", (e) => {
    e.stopPropagation();
    openColorPicker(iconEl, item.spineColor, (color) => {
      onColorChange(color);
      applyIconColor(iconEl, color);
    });
  });
  spine.appendChild(iconEl);

  // Centered label
  const label = document.createElement("div");
  label.className = "stack-spine-label";
  const labelTitle = document.createElement("span");
  labelTitle.textContent = resolveItemName(item);
  label.appendChild(labelTitle);
  const author = resolveItemAuthor(item);
  if (author) {
    const labelAuthor = document.createElement("span");
    labelAuthor.className = "stack-spine-label-author";
    labelAuthor.textContent = author;
    label.appendChild(labelAuthor);
  }
  spine.appendChild(label);

  // Bottom button cluster
  const buttons = document.createElement("div");
  buttons.className = "stack-spine-buttons";

  // 1. Drag handle (reorder)
  const dragBtn = makeBtn("stack-spine-drag-btn",
    `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/><circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/></svg>`);
  dragBtn.addEventListener("pointerdown", (e) => { e.stopPropagation(); onDragStart(e); });
  buttons.appendChild(dragBtn);

  // 2. Duplicate
  const dupeBtn = makeBtn("stack-spine-dupe-btn",
    `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="8" height="8" rx="1"/><path d="M6 4V3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1"/></svg>`);
  dupeBtn.title = "Duplicate";
  dupeBtn.addEventListener("click", (e) => { e.stopPropagation(); onDuplicate(item); });
  buttons.appendChild(dupeBtn);

  // 3. Pop out as pane
  const popOutBtn = makeBtn("stack-spine-popout-btn",
    `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 19L19 6M19 6V18.48M19 6H6.52"/></svg>`);
  popOutBtn.title = "Open as pane";
  popOutBtn.addEventListener("click", (e) => { e.stopPropagation(); onPopOut(item); });
  buttons.appendChild(popOutBtn);

  // 4. Close (remove from stack)
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

function applyIconColor(iconEl, color) {
  const svg = iconEl.querySelector("svg");
  if (color) {
    iconEl.classList.add("stack-spine-icon-colored");
    iconEl.style.setProperty("--spine-icon-color", color);
    if (svg) svg.style.stroke = "#fff";
  } else {
    iconEl.classList.remove("stack-spine-icon-colored");
    iconEl.style.removeProperty("--spine-icon-color");
    if (svg) svg.style.stroke = "";
  }
}

function resolveItemName(item) {
  if (item.fileType === "pdf") {
    try {
      const meta = _getPdfMeta(item.fileId);
      if (meta) return meta.title || item.name || "Untitled";
    } catch {}
  }
  if (item.name) return item.name;
  const state = window.__hushState__;
  if (state) {
    const node = findNodeByFileId(state.fileTree, item.fileId);
    if (node) return node.name;
  }
  return "Untitled";
}

function resolveItemAuthor(item) {
  if (item.fileType !== "pdf") return "";
  try {
    const meta = _getPdfMeta(item.fileId);
    if (meta?.firstAuthor) return meta.firstAuthor;
  } catch {}
  return "";
}

let _pdfSyncMod = null;
function _getPdfMeta(fileId) {
  if (!_pdfSyncMod) {
    try { _pdfSyncMod = import("../sync/pdf-sync.js"); } catch { return null; }
  }
  if (_pdfSyncMod?.then) {
    _pdfSyncMod.then(m => { _pdfSyncMod = m; });
    return null;
  }
  return _pdfSyncMod.getPdfMeta?.(fileId) || null;
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
  picker.style.left = (rect.left + rect.width / 2 - picker.offsetWidth / 2) + "px";
  picker.style.top = (rect.bottom + 6) + "px";
  const cleanup = () => { document.removeEventListener("pointerdown", onOut); document.removeEventListener("keydown", onEsc); };
  const onOut = (e) => { if (!picker.contains(e.target) && !anchorEl.contains(e.target)) { picker.remove(); cleanup(); } };
  const onEsc = (e) => { if (e.key === "Escape") { picker.remove(); cleanup(); } };
  setTimeout(() => { document.addEventListener("pointerdown", onOut); document.addEventListener("keydown", onEsc); }, 0);
}
