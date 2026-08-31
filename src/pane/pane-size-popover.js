/**
 * Per-pane font-size override + popover. Drives the "A" affordance in
 * the pane titlebar; live updates a CSS custom property on the pane
 * root that CodeMirror's hushTheme reads. Pulled out of pane-manager.js
 * so the lifecycle file stays focused on create/close/focus.
 */
import { panes } from "./pane-state.js";
import { applyTooltip } from "../tooltips.js";

export const FP_SIZE_MIN = 10;
export const FP_SIZE_MAX = 48;
export const FP_SIZE_STEP = 2;

/** Read the live --font-size CSS var as a fallback when a pane has no
 *  override yet — that way the first +/- click increments from the
 *  user's actual current size, not a hardcoded default. */
export function effectivePaneFontSize(pane) {
  if (typeof pane.fontSize === "number" && Number.isFinite(pane.fontSize)) return pane.fontSize;
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--font-size"));
  return Number.isFinite(v) ? v : 20;
}

/** Apply the font-size override to the pane's root element via a CSS
 *  variable. CodeMirror's hushTheme reads `var(--font-size)`, so setting
 *  it on the pane element cascades down without needing a CM
 *  reconfigure. Pass null to clear and inherit the document default. */
export function applyPaneFontSize(pane) {
  if (!pane.el) return;
  if (typeof pane.fontSize === "number" && Number.isFinite(pane.fontSize)) {
    pane.el.style.setProperty("--font-size", pane.fontSize + "px");
  } else {
    pane.el.style.removeProperty("--font-size");
  }
}

function bumpOnePaneFontSize(pane, delta) {
  const next = Math.max(FP_SIZE_MIN, Math.min(FP_SIZE_MAX, effectivePaneFontSize(pane) + delta));
  pane.fontSize = next;
  applyPaneFontSize(pane);
}

/** Step a pane's font size by `delta` (px). When `allPanes` is true the
 *  same delta is applied to every open pane — Cmd-click in the popover
 *  routes through here. */
export function bumpPaneFontSize(pane, delta, allPanes, schedulePersist) {
  if (allPanes) {
    // Skip notebook panes — their content is a canvas, not flowed text,
    // so a font-size change wouldn't do anything useful.
    for (const [, p] of panes) {
      if (p.fileType !== "notebook") bumpOnePaneFontSize(p, delta);
    }
  } else {
    bumpOnePaneFontSize(pane, delta);
  }
  if (schedulePersist) schedulePersist();
}

export function togglePaneSizePopover(pane, anchorBtn, schedulePersist) {
  // Toggle: clicking the A button while the popover is open just closes it.
  const existing = pane.el.querySelector(".fp-size-popover");
  if (existing) { existing.remove(); return; }

  const popover = document.createElement("div");
  popover.className = "fp-size-popover";

  const minus = document.createElement("button");
  minus.className = "fp-size-step";
  minus.type = "button";
  minus.textContent = "−"; // minus sign
  applyTooltip(minus, "Smaller (⌘ to apply to all panes)");

  const label = document.createElement("span");
  label.className = "fp-size-label";

  const plus = document.createElement("button");
  plus.className = "fp-size-step";
  plus.type = "button";
  plus.textContent = "+";
  applyTooltip(plus, "Larger (⌘ to apply to all panes)");

  function refreshLabel() { label.textContent = Math.round(effectivePaneFontSize(pane)) + "px"; }
  refreshLabel();

  minus.addEventListener("click", (e) => {
    e.stopPropagation();
    bumpPaneFontSize(pane, -FP_SIZE_STEP, e.metaKey || e.ctrlKey, schedulePersist);
    refreshLabel();
  });
  plus.addEventListener("click", (e) => {
    e.stopPropagation();
    bumpPaneFontSize(pane, FP_SIZE_STEP, e.metaKey || e.ctrlKey, schedulePersist);
    refreshLabel();
  });

  popover.appendChild(minus);
  popover.appendChild(label);
  popover.appendChild(plus);
  popover.addEventListener("pointerdown", (e) => e.stopPropagation());
  pane.el.appendChild(popover);
  positionPopover(pane, popover, anchorBtn);

  // Close when the user taps anywhere outside the popover or its anchor.
  setTimeout(() => {
    const off = (e) => {
      if (popover.contains(e.target)) return;
      if (e.target === anchorBtn || anchorBtn.contains(e.target)) return;
      popover.remove();
      document.removeEventListener("pointerdown", off, true);
    };
    document.addEventListener("pointerdown", off, true);
  }, 0);
}

/**
 * Park the popover under the button that opened it.
 *
 * The CSS used to pin it to the pane's own top-right corner, which is
 * only where the "A" button is while the title bar runs the full width
 * of the pane. A docked pane on iPad floats its title bar as a centred
 * pill (see the `.docked-*` rules in floating-pane.css), so the button
 * moves and the popover stayed behind — anchored to a header that isn't
 * there any more. Measuring the button covers both forms, and any
 * future one, for the cost of two rects.
 *
 * Coordinates are pane-relative because the popover is a child of the
 * pane (which clips with `overflow: hidden`), so the horizontal clamp
 * keeps it inside the pane's box rather than the viewport's.
 */
function positionPopover(pane, popover, anchorBtn) {
  const paneRect = pane.el.getBoundingClientRect();
  const btnRect = anchorBtn.getBoundingClientRect();
  if (!paneRect.width || !btnRect.width) return;
  // A canvas-attached pane is drawn through `transform: scale(zoom)`, so
  // its client rects are in screen px while `style.top` is in the pane's
  // own layout px. Divide the measured offsets back out by that scale.
  const scale = pane.el.offsetWidth ? paneRect.width / pane.el.offsetWidth : 1;
  const paneW = pane.el.offsetWidth || paneRect.width;
  const paneH = pane.el.offsetHeight || paneRect.height;
  const w = popover.offsetWidth || 0;
  const h = popover.offsetHeight || 0;
  const margin = 6;
  // Right-align to the button, then clamp both edges into the pane.
  let left = (btnRect.right - paneRect.left) / scale - w;
  left = Math.max(margin, Math.min(left, paneW - w - margin));
  // Below the button, unless that would run past the pane's bottom edge
  // (a short pane, or a title bar docked at the bottom) — then above.
  let top = (btnRect.bottom - paneRect.top) / scale + margin;
  if (top + h > paneH - margin) {
    top = Math.max(margin, (btnRect.top - paneRect.top) / scale - h - margin);
  }
  popover.style.top = top + "px";
  popover.style.left = left + "px";
  popover.style.right = "auto";
}
