/**
 * Suspend / resume / view-restore for the PDF viewer.
 *
 * Extracted from pdf-viewer.js to keep each module under 700 lines.
 * Suspend swaps the live pdfjs document for a JPEG snapshot so inactive
 * panes don't hold pdfjs instances in memory; resume reloads from the
 * cached bytes and re-asserts the pre-suspend viewport.
 *
 * The bytes needed for resume are pulled back from the pdf.js worker
 * (`env.getData` → `pdfDoc.getData()`) at suspend time, right before
 * the document is torn down — the viewer no longer keeps a standing
 * copy of the whole binary alive on the off-chance it might suspend
 * (which stack columns and the main viewer never do).
 *
 * @param {HTMLElement} scrollArea  The viewer's scroll container
 * @param {object}      env         Callbacks into the viewer factory
 * @param {function}    env.isDestroyed      () => boolean
 * @param {function}    env.hasDoc           () => boolean
 * @param {function}    env.getData          () => Promise<Uint8Array> — bytes from the worker
 * @param {function}    env.getZoom          () => number (encoded zoom mode)
 * @param {function}    env.setZoom          (level) => void
 * @param {function}    env.relayoutPages    () => void
 * @param {function}    env.drawSnapshot     (ctx, w, h) => void — paint current view
 * @param {function}    env.onSuspendStart   () => void — detach observers/listeners
 * @param {function}    env.teardownContent  () => void — drop pages + pdfjs doc
 * @param {function}    env.onResumeStart    () => void — reattach observers/listeners
 * @param {function}    env.reload           (data) => Promise — loadPdf + re-set annotations
 */
export function createPdfSuspendManager(scrollArea, env) {
  let suspended = false;
  let resuming = false;
  let suspendImg = null;
  let _suspendScrollTop = 0;
  let _suspendScrollLeft = 0;
  let _suspendZoomLevel = null;
  let cachedPdfData = null;
  let suspendInFlight = null;

  /** Restore zoom mode + scroll. Fit-mode page heights derive from the
   *  container's measured size, often unsettled at mount/resume — a single
   *  scrollTop then clamps to 0. Re-flex + re-assert until it sticks. */
  function restoreView(zoomLevel, scrollTop, scrollLeft) {
    if (typeof zoomLevel === "number") { try { env.setZoom(zoomLevel); } catch (_) {} }
    const top = scrollTop || 0;
    const left = scrollLeft || 0;
    if (top <= 0 && left <= 0) return;
    let attempts = 0;
    resuming = true;
    const tick = () => {
      if (env.isDestroyed() || suspended) { resuming = false; return; }
      env.relayoutPages(); // re-flex so scrollHeight reflects the real layout
      scrollArea.scrollTop = top;
      scrollArea.scrollLeft = left;
      const okTop = top <= 0 || Math.abs(scrollArea.scrollTop - top) <= 2;
      const okLeft = left <= 0 || Math.abs(scrollArea.scrollLeft - left) <= 2;
      if ((okTop && okLeft) || attempts >= 12) { resuming = false; return; }
      attempts++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  async function suspend() {
    if (suspended || env.isDestroyed() || !env.hasDoc()) return;
    _suspendScrollTop = scrollArea.scrollTop;
    _suspendScrollLeft = scrollArea.scrollLeft;
    try { _suspendZoomLevel = env.getZoom(); } catch (_) { _suspendZoomLevel = null; }
    suspended = true;
    env.onSuspendStart();

    try {
      const snapshot = document.createElement("canvas");
      const w = scrollArea.clientWidth;
      const h = scrollArea.clientHeight;
      if (w > 0 && h > 0) {
        snapshot.width = w;
        snapshot.height = h;
        const ctx = snapshot.getContext("2d");
        ctx.fillStyle = "#f5f5f5";
        ctx.fillRect(0, 0, w, h);
        env.drawSnapshot(ctx, w, h);
        suspendImg = document.createElement("img");
        suspendImg.className = "pdf-suspend-snapshot";
        suspendImg.src = snapshot.toDataURL("image/jpeg", 0.85);
        suspendImg.style.width = w + "px";
        suspendImg.style.height = h + "px";
      }
    } catch (_) {}

    // Pull the raw bytes back from the worker before the doc dies —
    // the only copy the viewer holds, and only while suspended.
    suspendInFlight = (async () => {
      if (!cachedPdfData) {
        try { cachedPdfData = await env.getData(); } catch (_) {}
      }
    })();
    await suspendInFlight;
    suspendInFlight = null;
    if (env.isDestroyed()) return;

    env.teardownContent();

    if (suspendImg) {
      scrollArea.appendChild(suspendImg);
      scrollArea.classList.add("pdf-suspended");
    }

    scrollArea.scrollTop = _suspendScrollTop;
    scrollArea.scrollLeft = _suspendScrollLeft;
  }

  async function resume() {
    if (!suspended || env.isDestroyed()) return;
    // A rapid suspend → resume can interleave with the byte pull above;
    // wait it out so reload has data to work with.
    if (suspendInFlight) { try { await suspendInFlight; } catch (_) {} }
    suspended = false;
    resuming = true;
    scrollArea.classList.remove("pdf-suspended");
    if (suspendImg) { suspendImg.remove(); suspendImg = null; }

    env.onResumeStart();

    // pdf.js's getDocument takes ownership of (neuters) the TypedArray
    // it's handed, so hand the cache over outright and drop our
    // reference — a resumed viewer holds no standing copy, and the
    // *next* suspend pulls fresh bytes back from the worker.
    if (cachedPdfData) {
      const data = cachedPdfData;
      cachedPdfData = null;
      await env.reload(data);
    }

    // restoreView re-applies zoom (a horizontal layout clamps scrollTop to
    // 0 and vice versa, so the mode must match first) then re-asserts the
    // scroll across frames so a not-yet-settled container size can't clamp
    // the position to the top.
    restoreView(_suspendZoomLevel, _suspendScrollTop, _suspendScrollLeft);
    if (_suspendScrollTop <= 0 && _suspendScrollLeft <= 0) resuming = false;
  }

  return {
    suspend,
    resume,
    restoreView,
    isSuspended: () => suspended,
    isResuming: () => resuming,
  };
}
