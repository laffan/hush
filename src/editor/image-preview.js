/**
 * Image hover tooltip + click-to-preview modal for doc images.
 *
 * Usage:
 *   attachImageHoverTooltip(el, fileId, name) — show the image as a
 *     tooltip while the pointer is over `el`.
 *   openImagePreviewModal(fileId, name) — open a full-screen modal
 *     showing the image.
 */

import { getImageDataUrl } from "../state/state-images.js";

let tooltipEl = null;
let tooltipToken = 0;
let currentHoverEl = null;
let hoverTimer = null;

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
  if (tooltipEl) tooltipEl.classList.add("hidden");
}

async function showImageTooltip(fileId, name, x, y) {
  const el = ensureTooltip();
  const token = ++tooltipToken;
  const img = el.querySelector("img");
  const label = el.querySelector(".hush-image-tooltip-name");
  label.textContent = name || "";
  const dataUrl = await getImageDataUrl(fileId);
  if (token !== tooltipToken) return; // superseded
  if (!dataUrl) return;
  img.src = dataUrl;
  el.classList.remove("hidden");
  // Wait for layout so we can size properly.
  requestAnimationFrame(() => positionTooltip(x, y));
}

/**
 * Attach hover behaviour to an arbitrary DOM element. The element receives
 * a tooltip showing the image after a short hover delay.
 */
export function attachImageHoverTooltip(el, fileId, name) {
  if (!el || !fileId) return () => {};
  let lastX = 0, lastY = 0;
  const onEnter = (e) => {
    currentHoverEl = el;
    lastX = e.clientX; lastY = e.clientY;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (currentHoverEl === el) showImageTooltip(fileId, name, lastX, lastY);
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

/** Open a centered modal showing the image at full size. */
export async function openImagePreviewModal(fileId, name) {
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
  const dataUrl = await getImageDataUrl(fileId);
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
