/**
 * How much of a canvas host's box is covered at each edge, measured from
 * what is actually on screen rather than added up from widths.
 *
 * The toolbar used to centre on `parent width − (sidebar + left dock) −
 * shelf`, which is right only when the host starts at the window's left
 * edge and the docks sit inside it. A host that already starts past the
 * sidebar, or a dock the shelf's inset already includes, counted twice,
 * and the bar sat off-centre (usually to the left). Here every cover is
 * an edge in viewport coordinates — the sidebar's right edge
 * (`state.leftInset`, measured from the window's left), each docked
 * pane's own rect, the shelf's left edge (`state.rightInset`, measured
 * from the host's right) — and the inset is how far the furthest one
 * reaches into the host. Nothing is counted twice.
 *
 * A pane-hosted or gutter canvas has interior edges: only its own
 * `hostTopInset` (a floating title pill) applies.
 */
import type { DrawingState } from "../state";

export interface Insets { left: number; right: number; top: number; bottom: number }

export function visibleInsets(state: DrawingState, parentEl: HTMLElement | null): Insets {
  const hostTop = state.hostTopInset || 0;
  if (!parentEl || state.paneHosted || state.gutterScrollDOM) {
    return { left: state.leftInset || 0, right: state.rightInset || 0, top: hostTop, bottom: 0 };
  }
  const pr = parentEl.getBoundingClientRect();
  if (!pr.width || !pr.height) {
    return {
      left: (state.leftInset || 0) + (state.dockedLeftWidth || 0),
      right: state.rightInset || 0,
      top: (state.dockedTopHeight || 0) + hostTop,
      bottom: state.dockedBottomHeight || 0,
    };
  }
  // The sidebar runs from the window's left edge; the shelf's inset is
  // already measured from the host's right (and moves aside for a right
  // dock).
  let left = Math.max(pr.left, state.leftInset || 0);
  let right = pr.right - (state.rightInset || 0);
  let top = pr.top;
  let bottom = pr.bottom;
  for (const el of document.querySelectorAll<HTMLElement>(".docked-left, .docked-right, .docked-top, .docked-bottom")) {
    if (el.contains(parentEl)) continue; // the host is this pane
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue; // hidden
    if (el.classList.contains("docked-left")) left = Math.max(left, r.right);
    else if (el.classList.contains("docked-right")) right = Math.min(right, r.left);
    else if (el.classList.contains("docked-top")) top = Math.max(top, r.bottom);
    else bottom = Math.min(bottom, r.top);
  }
  return {
    left: Math.max(0, left - pr.left),
    right: Math.max(0, pr.right - right),
    top: Math.max(0, top - pr.top) + hostTop,
    bottom: Math.max(0, pr.bottom - bottom),
  };
}
