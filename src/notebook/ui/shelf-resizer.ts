import type { ShelfPanelEl } from "./shelf-panel";

const SHELF_WIDTH_MIN = 200;
const SHELF_WIDTH_MAX_FRAC = 0.6;

/** Floating draggable handle for the notebook shelf's left edge. Mirrors
 *  the sidebar's panel-resizer pattern (invisible until hovered). The
 *  panel itself is right-anchored, so dragging the handle LEFT grows the
 *  shelf, dragging RIGHT shrinks it. */
export function createShelfResizer(
  panel: ShelfPanelEl,
  opts: { onCommit: (w: number) => void; onResize?: () => void },
): HTMLElement {
  const el = document.createElement("div");
  el.className = "notebook-shelf-resizer";
  Object.assign(el.style, {
    position: "fixed", width: "10px", zIndex: "152",
    cursor: "ew-resize", background: "transparent",
    transition: "background 120ms ease", display: "none",
  } as Partial<CSSStyleDeclaration>);

  let hideTimeout: ReturnType<typeof setTimeout> | null = null;
  const showHover = () => {
    if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
    el.style.background = "rgba(127,127,127,0.28)";
  };
  const hideHover = () => {
    hideTimeout = setTimeout(() => { el.style.background = "transparent"; }, 200);
  };
  el.addEventListener("mouseenter", showHover);
  el.addEventListener("mouseleave", hideHover);

  function clamp(w: number): number {
    return Math.max(SHELF_WIDTH_MIN, Math.min(window.innerWidth * SHELF_WIDTH_MAX_FRAC, w));
  }

  function sync() {
    const isOpen = panel.__isShelfOpen ? panel.__isShelfOpen() : false;
    if (!isOpen) { el.style.display = "none"; return; }
    const rect = panel.getBoundingClientRect();
    if (rect.width <= 0) { el.style.display = "none"; return; }
    el.style.display = "block";
    el.style.left = `${rect.left - 5}px`;
    el.style.top = `${rect.top}px`;
    el.style.height = `${rect.height}px`;
  }

  // rAF-coalesced sync: layout-reads + position writes happen at most once
  // per frame, so high-frequency triggers (mousemove, MutationObserver,
  // window resize) don't pile up redundant layout flushes.
  let pendingFrame = 0;
  function syncRaf() {
    if (pendingFrame) return;
    pendingFrame = requestAnimationFrame(() => { pendingFrame = 0; sync(); });
  }

  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.__getShelfWidth ? panel.__getShelfWidth() : 280;
    // The shelf has a `transition: width 0.2s` for the open/close animation;
    // during a drag that smoothing makes the panel chase the cursor. Disable
    // it for the duration of the drag, restore on release.
    const prevTransition = panel.style.transition;
    panel.style.transition = "none";
    showHover();
    const onMove = (me: MouseEvent) => {
      const next = clamp(startW - (me.clientX - startX));
      if (panel.__setShelfWidth) panel.__setShelfWidth(next);
      syncRaf();
      opts.onResize?.();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      panel.style.transition = prevTransition;
      hideHover();
      const finalW = panel.__getShelfWidth ? panel.__getShelfWidth() : startW;
      opts.onCommit(finalW);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // Track open/closed + width changes via panel attribute mutations.
  const obs = new MutationObserver(syncRaf);
  obs.observe(panel, { attributes: true, attributeFilter: ["style", "class"] });
  window.addEventListener("resize", syncRaf);
  // Initial position once the panel is in the DOM.
  queueMicrotask(sync);

  return el;
}
