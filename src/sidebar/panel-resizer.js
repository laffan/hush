// ── Sidebar panel width ────────────────────────────────────────────────

const PANEL_WIDTH_MIN = 220;
const PANEL_WIDTH_MAX_FRAC = 0.5; // never take more than half the viewport

export function applyPanelWidth(px) {
  const clamped = Math.max(PANEL_WIDTH_MIN, Math.min(window.innerWidth * PANEL_WIDTH_MAX_FRAC, px));
  document.documentElement.style.setProperty("--panel-width", clamped + "px");
}

export function positionPanelResizer(el, panelOverlay) {
  const isOpen = !panelOverlay.classList.contains("hidden");
  if (!isOpen) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const rect = panelOverlay.getBoundingClientRect();
  // Center the 40-px hit zone on the panel's right edge.
  el.style.left = rect.right + "px";
}

export function createPanelResizer(state, panelOverlay) {
  const el = document.createElement("div");
  el.className = "sidebar-panel-resizer hidden";

  let hideTimeout = null;
  const show = () => { clearTimeout(hideTimeout); el.classList.add("hover"); };
  const hide = () => {
    hideTimeout = setTimeout(() => el.classList.remove("hover"), 200);
  };
  el.addEventListener("mouseenter", show);
  el.addEventListener("mouseleave", hide);

  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelOverlay.getBoundingClientRect().width;
    el.classList.add("dragging");
    show();

    const onMove = (me) => {
      const next = startWidth + (me.clientX - startX);
      applyPanelWidth(next);
      positionPanelResizer(el, panelOverlay);
      // Editor column layout re-centers when the panel is inset
      if (state.runtime.columnResizeHandler) state.runtime.columnResizeHandler();
    };
    const onUp = () => {
      el.classList.remove("dragging");
      hide();
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      // Persist the final width (read back from the CSS var — clamped)
      const computed = getComputedStyle(document.documentElement).getPropertyValue("--panel-width").trim();
      const n = parseInt(computed, 10);
      if (Number.isFinite(n) && n > 0) state.updateSettings({ sidebarPanelWidth: n });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // Keep the resizer glued to the panel's right edge when the panel opens,
  // closes, or the viewport resizes.
  const sync = () => positionPanelResizer(el, panelOverlay);
  new MutationObserver(sync).observe(panelOverlay, { attributes: true, attributeFilter: ["class", "style"] });
  window.addEventListener("resize", () => {
    // Re-clamp against new viewport width
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--panel-width"), 10) || 300;
    applyPanelWidth(current);
    sync();
  });

  return el;
}
