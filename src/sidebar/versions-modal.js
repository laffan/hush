/**
 * Versions modal — encapsulates the legacy versions sidebar panel inside
 * a centered modal. Snapshot list on the left, hover/click preview on
 * the right, restore bar at the bottom of the preview pane.
 *
 * Reuses createVersionsPanel + cleanupVersionsPanel from versions-panel.js;
 * the only addition is the modal chrome and a positioned preview host so
 * the .version-preview-overlay scopes inside the modal rather than
 * overlaying the viewport.
 */

import { createVersionsPanel, cleanupVersionsPanel } from "./versions-panel.js";

let openModal = null;

export function openVersionsModal(state) {
  if (openModal) { closeVersionsModal(); return; }

  const backdrop = document.createElement("div");
  backdrop.className = "versions-modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "versions-modal";

  const closeBtn = document.createElement("button");
  closeBtn.className = "versions-modal-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";

  const body = document.createElement("div");
  body.className = "versions-modal-body";

  const list = document.createElement("div");
  list.className = "versions-modal-list";

  const previewHost = document.createElement("div");
  previewHost.className = "versions-modal-preview-host";

  body.appendChild(list);
  body.appendChild(previewHost);
  modal.appendChild(closeBtn);
  modal.appendChild(body);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  openModal = backdrop;

  function close() { closeVersionsModal(); }
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  const escHandler = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", escHandler);
  backdrop._escHandler = escHandler;

  // Mount the existing panel logic, but route its preview into our host.
  createVersionsPanel(list, state, close, { previewHost });
}

export function closeVersionsModal() {
  if (!openModal) return;
  cleanupVersionsPanel();
  if (openModal._escHandler) {
    document.removeEventListener("keydown", openModal._escHandler);
  }
  openModal.remove();
  openModal = null;
}
