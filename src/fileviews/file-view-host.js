/**
 * File view host — mounts whichever canvas view a desk is set to into the
 * sidebar's panel body, and owns the pieces both views share: the chip
 * that cycles List → Desktop → Drone (so a canvas view is never a dead
 * end for someone who hasn't found the command palette entries) and the
 * repaint when the active style or theme changes underneath it.
 *
 * The views are read-only representations. Renaming, flagging, deleting,
 * reordering and every other row action still belongs to the list view —
 * the row menu is a list-view affordance, and moving a node in the tree
 * from a canvas would re-open the drag-commit hazard the files panel
 * documents in `commitRenderedChildren`.
 */

import { FILE_VIEW_LABELS, nextFileViewMode, setDeskFileView } from "./file-view-mode.js";

/**
 * @param {HTMLElement} container  the panel body to fill
 * @param {"desktop"|"drone"} mode
 * @returns {{ refresh(): void, destroy(): void }}
 */
export function mountFileView(container, state, mode, hidePanel) {
  container.innerHTML = "";
  let view = null;
  let destroyed = false;

  const boot = mode === "drone"
    ? import("./file-view-drone.js").then((m) => m.createDroneFileView(container, state, hidePanel))
    : import("./file-view-desktop.js").then((m) => m.createDesktopFileView(container, state, hidePanel));

  boot.then((v) => {
    if (destroyed) { v.destroy(); return; }
    view = v;
    mountChip(v.chrome, state, mode);
  }).catch((e) => {
    console.warn("File view failed to mount:", e);
    container.textContent = "";
  });

  const repaint = () => { if (view) view.repaint(); };
  const refresh = () => { if (view) view.refresh(); };
  state.on("theme-changed", repaint);
  state.on("style-changed", repaint);

  return {
    refresh,
    destroy() {
      destroyed = true;
      state.off("theme-changed", repaint);
      state.off("style-changed", repaint);
      if (view) view.destroy();
      view = null;
    },
  };
}

function mountChip(chrome, state, mode) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "file-view-chip";
  const next = nextFileViewMode(mode);
  chip.textContent = FILE_VIEW_LABELS[mode];
  chip.title = `Switch to ${FILE_VIEW_LABELS[next]} view`;
  chip.setAttribute("aria-label", chip.title);
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    setDeskFileView(state, next).catch(() => {});
  });
  chrome.appendChild(chip);
}
