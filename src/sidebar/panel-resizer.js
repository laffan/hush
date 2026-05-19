// ── Sidebar panel width ────────────────────────────────────────────────

const PANEL_WIDTH_MIN = 220;
const PANEL_WIDTH_MAX_FRAC = 0.5; // never take more than half the viewport

export function applyPanelWidth(px) {
  const clamped = Math.max(PANEL_WIDTH_MIN, Math.min(window.innerWidth * PANEL_WIDTH_MAX_FRAC, px));
  document.documentElement.style.setProperty("--panel-width", clamped + "px");
}

/**
 * Wire pointer-drag resize onto the grip's narrow right-edge strip. The
 * strip lives inside the grip itself so the geometry stays correct as
 * the panel opens / closes / the viewport resizes — no separate fixed
 * element to keep in sync.
 *
 * @param state  AppState (for persisting sidebarPanelWidth)
 * @param resizeEl  the `.sidebar-grip-resize` child element
 * @param panelOverlay  `#panel-overlay`
 */
export function attachGripResize(state, resizeEl, panelOverlay) {
  resizeEl.addEventListener("pointerdown", (e) => {
    // Resize is only meaningful while the body is visible. If the panel
    // is collapsed, ignore — the toggle button handles open/close.
    if (panelOverlay.classList.contains("hidden")) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = panelOverlay.getBoundingClientRect().width;
    resizeEl.classList.add("dragging");
    // Suppress the `width` transition on #panel-overlay so the drag
    // tracks the cursor instead of interpolating 200 ms behind every
    // mousemove. Editor column recentring is also throttled to one
    // frame per rAF; without this, applyColumnLayout fires on every
    // pointermove and stacks up reflows.
    panelOverlay.classList.add("resizing");
    try { resizeEl.setPointerCapture(e.pointerId); } catch (_) {}

    let rafPending = false;
    let latestX = startX;
    const flush = () => {
      rafPending = false;
      const next = startWidth + (latestX - startX);
      applyPanelWidth(next);
      if (state.runtime.columnResizeHandler) state.runtime.columnResizeHandler();
    };
    const onMove = (me) => {
      latestX = me.clientX;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(flush);
    };
    const onUp = () => {
      resizeEl.classList.remove("dragging");
      panelOverlay.classList.remove("resizing");
      resizeEl.removeEventListener("pointermove", onMove);
      resizeEl.removeEventListener("pointerup", onUp);
      resizeEl.removeEventListener("pointercancel", onUp);
      const computed = getComputedStyle(document.documentElement).getPropertyValue("--panel-width").trim();
      const n = parseInt(computed, 10);
      if (Number.isFinite(n) && n > 0) state.updateSettings({ sidebarPanelWidth: n });
    };
    resizeEl.addEventListener("pointermove", onMove);
    resizeEl.addEventListener("pointerup", onUp);
    resizeEl.addEventListener("pointercancel", onUp);
  });

  // Re-clamp the persisted width against the new viewport on resize so
  // the panel never overflows after the user shrinks the window.
  window.addEventListener("resize", () => {
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--panel-width"), 10) || 300;
    applyPanelWidth(current);
  });
}
