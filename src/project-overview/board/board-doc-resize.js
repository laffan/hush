/**
 * The border between the Overview Doc's column and the list of
 * documents, drag-resizable — a hairline barely there until the pointer
 * finds it (project-overview-board.css `.po-doc-resizer`), as the Desk
 * Dashboard's borders are drawn and dragged (sidebar/desk-dashboard-resize.js).
 *
 * The list keeps to the right of the window, exactly as wide as its
 * stack column and its outline column; the Doc takes the rest, so it is
 * the Doc that grows and shrinks with the window. The border therefore
 * sizes the **outline column**: dragged left the outline widens (and the
 * Doc narrows), dragged right it narrows. The width is written to
 * settings when the drag ends (`overviewOutlineWidth`, `Option<u32>` on
 * the Rust side), so every project's Overview opens with it, in later
 * sessions too, and with the Doc put away the outline keeps it. A
 * double-click puts the default back (null — the stylesheet's
 * `--po-outline-w`). The stored number is what the user dragged to; the
 * room it gets is the window's: CSS caps the list so the Doc keeps
 * DOC_MIN, and the drag clamps to the same room. The border doesn't drag
 * while the Doc is put away, or stacked over the list in a narrow window.
 */

/** The outline column's narrowest: a heading's first words. */
const OUTLINE_MIN = 160;
/** What the Doc keeps beside the list (the stylesheet's `min-width`). */
const DOC_MIN = 220;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const px = (el, name) => parseFloat(getComputedStyle(el).getPropertyValue(name)) || 0;

/** Wire `bar` (between `col`, the Doc's column, and `list`, the rows)
 *  to size the outline column on `host`. Returns `{ destroy }`. */
export function wireDocResize(state, { host, body, col, list, bar }) {
  let dragging = false;

  /** The stored width pins the outline; null leaves the stylesheet's. */
  function apply() {
    if (dragging) return;
    const w = state.settings?.overviewOutlineWidth;
    if (Number.isFinite(w)) host.style.setProperty("--po-outline-w", `${w}px`);
    else host.style.removeProperty("--po-outline-w");
  }

  const inactive = () => getComputedStyle(body).flexDirection === "column"
    || getComputedStyle(col).display === "none";

  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || inactive()) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add("dragging");
    body.classList.add("po-resizing");
    // Everything in the list's width but the outline column: its margins,
    // the stack's column and the gap between the two.
    const cs = getComputedStyle(list);
    const fixed = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
      + px(host, "--board-stack-col") + px(host, "--board-gap");
    const from = e.clientX;
    const base = list.getBoundingClientRect().width - fixed;
    const max = Math.max(OUTLINE_MIN, body.clientWidth - DOC_MIN - fixed);
    let kept = base;
    const onMove = (me) => {
      // The border is the list's left edge: leftward widens the outline.
      kept = clamp(base - (me.clientX - from), OUTLINE_MIN, max);
      host.style.setProperty("--po-outline-w", `${kept}px`);
    };
    const onUp = () => {
      bar.removeEventListener("pointermove", onMove);
      bar.removeEventListener("pointerup", onUp);
      bar.removeEventListener("pointercancel", onUp);
      if (bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId);
      bar.classList.remove("dragging");
      body.classList.remove("po-resizing");
      dragging = false;
      if (Math.round(kept) === Math.round(base)) { apply(); return; }
      state.updateSettings({ overviewOutlineWidth: Math.round(kept) })
        .catch((err) => console.warn("Save overviewOutlineWidth failed:", err));
    };
    bar.addEventListener("pointermove", onMove);
    bar.addEventListener("pointerup", onUp);
    bar.addEventListener("pointercancel", onUp);
  });

  // Back to the default width.
  bar.addEventListener("dblclick", () => {
    if (inactive()) return;
    state.updateSettings({ overviewOutlineWidth: null })
      .catch((err) => console.warn("Reset overviewOutlineWidth failed:", err));
  });

  // A width set in another window, or reset by a double-click here.
  state.on("settings-changed", apply);
  apply();

  return { destroy() { state.off("settings-changed", apply); } };
}
