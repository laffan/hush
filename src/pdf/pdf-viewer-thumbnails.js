const THUMB_WIDTH = 180;

/**
 * @param {HTMLElement} root       The pdf-viewer root element
 * @param {HTMLElement} scrollArea The scroll container (for goToPage context)
 * @param {object} viewerState     { getPages, getPdfDoc, isDestroyed, getAnnotations, goToPage }
 */
export function createThumbnailManager(root, viewerState) {
  let thumbPanel = null;
  let thumbVisible = false;
  let thumbObserver = null;

  function toggle() {
    thumbVisible = !thumbVisible;
    if (thumbVisible) show();
    else hide();
    return thumbVisible;
  }

  function show() {
    const pages = viewerState.getPages();
    if (thumbPanel) { thumbPanel.style.display = ""; setupObserver(); return; }
    thumbPanel = document.createElement("div");
    thumbPanel.className = "pdf-thumbnail-overlay";

    const thumbScroll = document.createElement("div");
    thumbScroll.className = "pdf-thumbnail-scroll";
    thumbPanel.appendChild(thumbScroll);

    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const vp = p.viewport;
      const aspect = vp.height / vp.width;
      const thumbH = Math.round(THUMB_WIDTH * aspect);

      const cell = document.createElement("div");
      cell.className = "pdf-thumb-cell";
      cell.dataset.thumbIdx = i;
      cell.style.width = THUMB_WIDTH + "px";
      cell.style.height = thumbH + "px";

      const placeholder = document.createElement("div");
      placeholder.className = "pdf-thumb-placeholder";
      cell.appendChild(placeholder);

      const label = document.createElement("div");
      label.className = "pdf-thumb-label";
      label.textContent = i + 1;
      cell.appendChild(label);

      cell.addEventListener("click", () => {
        viewerState.goToPage(i + 1);
        toggle();
      });

      thumbScroll.appendChild(cell);
    }

    root.appendChild(thumbPanel);
    setupObserver();
  }

  function setupObserver() {
    if (thumbObserver) thumbObserver.disconnect();
    const thumbScroll = thumbPanel?.querySelector(".pdf-thumbnail-scroll");
    if (!thumbScroll) return;
    thumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const idx = parseInt(entry.target.dataset.thumbIdx, 10);
        if (!isNaN(idx)) renderThumb(idx);
      }
    }, { root: thumbScroll, rootMargin: "300px" });
    for (const cell of thumbScroll.children) thumbObserver.observe(cell);
  }

  function hide() {
    if (!thumbPanel) return;
    thumbPanel.style.display = "none";
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
  }

  function parseAnnotPos(annot) {
    try {
      const raw = annot._raw?.data?.annotationPosition;
      if (typeof raw === "string") return JSON.parse(raw);
      if (raw && typeof raw === "object") return raw;
    } catch (_) {}
    return null;
  }

  async function renderThumb(idx) {
    const pages = viewerState.getPages();
    const pdfDoc = viewerState.getPdfDoc();
    if (!pdfDoc || viewerState.isDestroyed() || idx < 0 || idx >= pages.length) return;
    const cell = thumbPanel?.querySelector(`[data-thumb-idx="${idx}"]`);
    if (!cell || cell.dataset.thumbRendered) return;
    cell.dataset.thumbRendered = "1";

    try {
      const page = await pdfDoc.getPage(idx + 1);
      if (viewerState.isDestroyed()) return;
      const vp = page.getViewport({ scale: 1 });
      const scale = THUMB_WIDTH / vp.width;
      const svp = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(svp.width);
      canvas.height = Math.round(svp.height);
      canvas.className = "pdf-thumb-canvas";

      await page.render({ canvas, viewport: svp, background: "#ffffff" }).promise;
      if (viewerState.isDestroyed()) return;

      const allAnnots = viewerState.getAnnotations();
      if (allAnnots.length) {
        const ctx = canvas.getContext("2d");
        for (const ann of allAnnots) {
          const pos = parseAnnotPos(ann);
          if (!pos || pos.pageIndex !== idx) continue;

          // svp (the scaled viewport) maps PDF user space → canvas px,
          // honouring crop-box origins / rotation — a bare
          // `pageHeight − y` flip drifts on pages whose crop box
          // doesn't start at (0,0).
          if (pos.rects?.length && ann.type !== "ink") {
            const color = ann.color || "#ffff00";
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.3;
            for (const rect of pos.rects) {
              const [x1, y1, x2, y2] = rect;
              const [ax, ay] = svp.convertToViewportPoint(x1, y1);
              const [bx, by] = svp.convertToViewportPoint(x2, y2);
              ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
            }
            ctx.globalAlpha = 1.0;
          }

          if (ann.type === "ink" && pos.paths?.length) {
            ctx.strokeStyle = ann.color || "#ff0000";
            ctx.lineWidth = Math.max(0.5, scale * 0.8);
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            for (const pathPoints of pos.paths) {
              if (!pathPoints || pathPoints.length < 2) continue;
              ctx.beginPath();
              for (let pi = 0; pi < pathPoints.length; pi += 2) {
                const [px, py] = svp.convertToViewportPoint(pathPoints[pi], pathPoints[pi + 1]);
                if (pi === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
              }
              ctx.stroke();
            }
          }
        }
      }

      const ph = cell.querySelector(".pdf-thumb-placeholder");
      if (ph) ph.remove();
      cell.insertBefore(canvas, cell.firstChild);
    } catch (e) {
      console.error(`Failed to render thumbnail ${idx + 1}:`, e);
    }
  }

  function destroy() {
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    if (thumbPanel) { thumbPanel.remove(); thumbPanel = null; }
    thumbVisible = false;
  }

  return {
    toggle,
    show,
    hide,
    destroy,
    get visible() { return thumbVisible; },
  };
}
