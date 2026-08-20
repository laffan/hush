/**
 * Drag-to-resize for the document's right-hand bars (the outline and,
 * when a doc carries Google-Docs comments, the comments list).
 *
 * Each bar's width is a CSS custom property on `<html>` so the panel,
 * the bars stacked inboard of it, and the editor column all read one
 * value; the drag writes the property live and persists the final px
 * to settings on release. It mirrors `sidebar/panel-resizer.js` (the
 * left panel) — the difference is which way the cursor moves the edge:
 * these bars are pinned to the right, so dragging left widens them.
 *
 * The grab strip is its own fixed element rather than a child of the
 * panel: the panels scroll their contents, and a strip inside would
 * scroll away with them. It mirrors the panel's visibility by watching
 * the panel's `class` attribute, so callers wire nothing.
 */

const MAX_FRAC = 0.5; // never take more than half the viewport

/**
 * @param state       AppState (persists `settingKey`)
 * @param panel       the panel element (`#right-panel-overlay`, `#comments-panel`)
 * @param opts.cssVar        custom property carrying the width, e.g. `--right-panel-width`
 * @param opts.settingKey    AppSettings key the width persists to
 * @param opts.defaultWidth  px fallback when nothing is stored
 * @param opts.min           minimum px width
 * @param opts.rightOffset   CSS length expression for the strip's `right`:
 *                           everything between the viewport edge and this
 *                           panel's own left edge, this panel included
 */
export function attachSidePanelResize(state, panel, opts) {
  const { cssVar, settingKey, defaultWidth, min, rightOffset } = opts;

  const applyWidth = (px) => {
    const max = Math.max(min, window.innerWidth * MAX_FRAC);
    const clamped = Math.max(min, Math.min(max, px));
    document.documentElement.style.setProperty(cssVar, clamped + "px");
    return clamped;
  };

  const readWidth = () => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : defaultWidth;
  };

  applyWidth(Number(state.settings?.[settingKey]) || defaultWidth);

  const strip = document.createElement("div");
  strip.className = "side-panel-resize";
  strip.style.right = rightOffset;
  strip.setAttribute("role", "separator");
  strip.setAttribute("aria-orientation", "vertical");
  (document.getElementById("app") || document.body).appendChild(strip);

  // The panels announce themselves with a `hidden` class; the strip has
  // no business being grabbable when the bar it resizes isn't on screen.
  const syncVisible = () => {
    strip.classList.toggle("hidden", panel.classList.contains("hidden"));
  };
  syncVisible();
  new MutationObserver(syncVisible).observe(panel, {
    attributes: true, attributeFilter: ["class"],
  });

  // The outline closes on an outside `mousedown` while it overlays the
  // text, and the strip is technically outside it — without this the
  // first press of a drag shuts the panel being resized. WebKit
  // delivers the compatibility `mousedown` separately from
  // `pointerdown`, so stopping the pointer event is not enough.
  strip.addEventListener("mousedown", (e) => e.stopPropagation());

  strip.addEventListener("pointerdown", (e) => {
    if (panel.classList.contains("hidden")) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    strip.classList.add("dragging");
    // Kill the panel's width transition for the duration or the edge
    // interpolates 200 ms behind the cursor.
    panel.classList.add("resizing");
    try { strip.setPointerCapture(e.pointerId); } catch (_) {}

    let rafPending = false;
    let latestX = startX;
    const flush = () => {
      rafPending = false;
      // Right-pinned: leftward drag (negative delta) makes it wider.
      applyWidth(startWidth - (latestX - startX));
      state.runtime?.columnResizeHandler?.();
    };
    const onMove = (me) => {
      latestX = me.clientX;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(flush);
    };
    const onUp = () => {
      strip.classList.remove("dragging");
      panel.classList.remove("resizing");
      strip.removeEventListener("pointermove", onMove);
      strip.removeEventListener("pointerup", onUp);
      strip.removeEventListener("pointercancel", onUp);
      state.updateSettings({ [settingKey]: readWidth() });
    };
    strip.addEventListener("pointermove", onMove);
    strip.addEventListener("pointerup", onUp);
    strip.addEventListener("pointercancel", onUp);
  });

  // Re-clamp against a shrunken viewport, exactly as the left panel does.
  window.addEventListener("resize", () => applyWidth(readWidth()));

  return { applyWidth, readWidth };
}

/** Current px width of a right-hand bar, for layout maths that has to
 *  carve the space out (the editor column, pane docking). Falls back to
 *  the stock width when the property hasn't been written yet. */
export function sidePanelWidthPx(cssVar, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
