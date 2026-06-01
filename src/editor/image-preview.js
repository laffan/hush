/**
 * Image hover tooltip + click-to-preview modal for doc images.
 *
 * Usage:
 *   attachImageHoverTooltip(el, filename, name) — show the image as a
 *     tooltip while the pointer is over `el`.
 *   openImagePreviewModal(filename, name) — open a full-screen modal
 *     showing the image.
 */

import { getImageDataUrl } from "../state/state-images.js";

let tooltipEl = null;
let tooltipToken = 0;
let currentHoverEl = null;
let hoverTimer = null;
let connectivityWatch = null;

function cancelConnectivityWatch() {
  if (connectivityWatch) {
    clearTimeout(connectivityWatch);
    connectivityWatch = null;
  }
}

/** Hide the tooltip the moment its source element leaves the DOM.
 *  Polls on a coarse timer rather than a 60 fps rAF — this only needs to
 *  notice the source row being removed, which is fine to catch within a
 *  fraction of a second, and a tooltip can be open for a while on hover. */
function startConnectivityWatch(el) {
  cancelConnectivityWatch();
  const tick = () => {
    connectivityWatch = null;
    if (!el || !el.isConnected) { hideImageTooltip(); return; }
    connectivityWatch = setTimeout(tick, 200);
  };
  connectivityWatch = setTimeout(tick, 200);
}

function ensureTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement("div");
  tooltipEl.className = "hush-image-tooltip hidden";
  tooltipEl.innerHTML = `<img alt="" /><div class="hush-image-tooltip-name"></div>`;
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

function positionTooltip(x, y) {
  if (!tooltipEl) return;
  const pad = 14;
  const rect = tooltipEl.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + rect.width > window.innerWidth - 8) left = Math.max(8, x - pad - rect.width);
  if (top + rect.height > window.innerHeight - 8) top = Math.max(8, y - pad - rect.height);
  tooltipEl.style.left = left + "px";
  tooltipEl.style.top = top + "px";
}

export function hideImageTooltip() {
  clearTimeout(hoverTimer);
  currentHoverEl = null;
  tooltipToken++;
  cancelConnectivityWatch();
  if (tooltipEl) tooltipEl.classList.add("hidden");
}

async function showImageTooltip(source, filename, name, x, y, context) {
  const el = ensureTooltip();
  const token = ++tooltipToken;
  const img = el.querySelector("img");
  const label = el.querySelector(".hush-image-tooltip-name");
  label.textContent = name || "";
  const dataUrl = await getImageDataUrl(filename, context);
  if (token !== tooltipToken) return; // superseded
  if (!dataUrl) return;
  // Source element may have been removed between the hover delay and the
  // data-URL resolving (e.g. the user deleted the image).
  if (source && !source.isConnected) return;
  img.src = dataUrl;
  el.classList.remove("hidden");
  requestAnimationFrame(() => positionTooltip(x, y));
  startConnectivityWatch(source);
}

/**
 * Attach hover behaviour to an arbitrary DOM element. The element receives
 * a tooltip showing the image after a short hover delay. Pass `context`
 * for Local Sync sibling resolution.
 */
export function attachImageHoverTooltip(el, filename, name, context) {
  if (!el || !filename) return () => {};
  let lastX = 0, lastY = 0;
  const onEnter = (e) => {
    currentHoverEl = el;
    lastX = e.clientX; lastY = e.clientY;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (currentHoverEl === el && el.isConnected) {
        showImageTooltip(el, filename, name, lastX, lastY, context);
      }
    }, 220);
  };
  const onMove = (e) => {
    lastX = e.clientX; lastY = e.clientY;
    if (tooltipEl && !tooltipEl.classList.contains("hidden")) {
      positionTooltip(lastX, lastY);
    }
  };
  const onLeave = () => { hideImageTooltip(); };
  el.addEventListener("mouseenter", onEnter);
  el.addEventListener("mousemove", onMove);
  el.addEventListener("mouseleave", onLeave);
  return () => {
    el.removeEventListener("mouseenter", onEnter);
    el.removeEventListener("mousemove", onMove);
    el.removeEventListener("mouseleave", onLeave);
  };
}

/** Open a centered modal showing the image at full size. Pass `context`
 *  for Local Sync sibling resolution. */
export async function openImagePreviewModal(filename, name, context) {
  hideImageTooltip();
  const existing = document.querySelector(".hush-image-modal-backdrop");
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.className = "hush-image-modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "hush-image-modal";
  modal.innerHTML = `
    <button class="hush-image-modal-close" aria-label="Close">\u00d7</button>
    <div class="hush-image-modal-body"><img alt="" /></div>
    <div class="hush-image-modal-name"></div>
  `;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  modal.querySelector(".hush-image-modal-name").textContent = name || "";
  const img = modal.querySelector("img");
  const dataUrl = await getImageDataUrl(filename, context);
  if (dataUrl) img.src = dataUrl;

  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  modal.querySelector(".hush-image-modal-close").addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", onKey);
}
