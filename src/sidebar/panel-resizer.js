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
    try { resizeEl.setPointerCapture(e.pointerId); } catch (_) {}

    const onMove = (me) => {
      const next = startWidth + (me.clientX - startX);
      applyPanelWidth(next);
      if (state.runtime.columnResizeHandler) state.runtime.columnResizeHandler();
    };
    const onUp = () => {
      resizeEl.classList.remove("dragging");
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
