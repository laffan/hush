/**
 * "Loading Notebook…" overlay helpers — extracted from
 * notebook-bridge.js to keep that file under the 700-line cap.
 * One overlay at a time (module-level ref), matching the single main
 * notebook mount the bridge manages.
 */

/** Element ref for the active "Loading Notebook…" overlay, if any. */
let _loadingOverlayEl = null;

/** Shape count above which a notebook is treated as "large" enough to
 *  warrant the loading overlay. Below this, `loadShapes` finishes in a
 *  frame or two and showing the overlay would just flash. */
export const LARGE_NOTEBOOK_SHAPE_COUNT = 60;

/** Mount the "Loading Notebook…" overlay into the notebook container.
 *  Idempotent. Painted at full opacity so it's visible on the very next
 *  frame — the caller yields a frame (`nextPaint`) before kicking off the
 *  synchronous `loadShapes` work, which would otherwise block the event
 *  loop (and any paint) until it finished. */
export function mountLoadingOverlay(container) {
  if (_loadingOverlayEl) return;
  const overlay = document.createElement("div");
  overlay.className = "notebook-loading-overlay";
  const label = document.createElement("div");
  label.className = "notebook-loading-label";
  label.textContent = "Loading Notebook…";
  const bar = document.createElement("div");
  bar.className = "notebook-loading-bar";
  overlay.appendChild(label);
  overlay.appendChild(bar);
  container.appendChild(overlay);
  _loadingOverlayEl = overlay;
}

export function unmountLoadingOverlay() {
  if (_loadingOverlayEl && _loadingOverlayEl.parentNode) {
    _loadingOverlayEl.parentNode.removeChild(_loadingOverlayEl);
  }
  _loadingOverlayEl = null;
}

/** Resolve after the browser has had a chance to paint (two rAFs: the
 *  first runs before the next paint, the second after it). Used to
 *  guarantee the loading overlay actually renders before the blocking
 *  `loadShapes` pass starts. */
export function nextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
