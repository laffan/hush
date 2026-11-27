/**
 * The border between the Overview Doc's column and the list of
 * documents, drag-resizable — out of sight until the pointer finds it
 * (project-overview-board.css `.po-doc-resizer`), as the Desk
 * Dashboard's borders are drawn and dragged (sidebar/desk-dashboard-resize.js).
 *
 * A drag sets the column's width, written to settings when it ends
 * (`overviewDocWidth`, `Option<u32>` on the Rust side), so every
 * project's Overview opens at that width, in later sessions too. A
 * double-click puts the default back (null — the stylesheet's
 * `--po-doc-w`). The stored number is what the user dragged to; the
 * room it gets is the window's: CSS caps the column live (its
 * `max-width` leaves the list LIST_MIN), so a smaller window narrows it
 * without rewriting the setting, and the drag clamps to the same room.
 * The border doesn't drag while the column is put away, or stacked over
 * the list in a narrow window.
 */

/** The column's narrowest: a few words a line still. */
const DOC_MIN = 220;
/** What the list keeps beside it: a page stack (360) and its margins. */
const LIST_MIN = 420;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Wire `bar` to size `col` inside `body`. Returns `{ destroy }`. */
export function wireDocResize(state, { body, col, bar }) {
  let dragging = false;

  /** The stored width pins the column; null leaves the stylesheet's. */
  function apply() {
    if (dragging) return;
    const w = state.settings?.overviewDocWidth;
    col.style.width = Number.isFinite(w) ? `${w}px` : "";
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
    const from = e.clientX;
    const base = col.getBoundingClientRect().width;
    let kept = base;
    const onMove = (me) => {
      kept = clamp(base + me.clientX - from, DOC_MIN, Math.max(DOC_MIN, body.clientWidth - LIST_MIN));
      col.style.width = `${kept}px`;
    };
    const onUp = () => {
      bar.removeEventListener("pointermove", onMove);
      bar.removeEventListener("pointerup", onUp);
      bar.removeEventListener("pointercancel", onUp);
      if (bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId);
      bar.classList.remove("dragging");
      body.classList.remove("po-resizing");
      dragging = false;
      if (Math.round(kept) === Math.round(base)) return;
      state.updateSettings({ overviewDocWidth: Math.round(kept) })
        .catch((err) => console.warn("Save overviewDocWidth failed:", err));
    };
    bar.addEventListener("pointermove", onMove);
    bar.addEventListener("pointerup", onUp);
    bar.addEventListener("pointercancel", onUp);
  });

  // Back to the default width.
  bar.addEventListener("dblclick", () => {
    if (inactive()) return;
    state.updateSettings({ overviewDocWidth: null })
      .catch((err) => console.warn("Reset overviewDocWidth failed:", err));
  });

  // A width set in another window, or reset by a double-click here.
  state.on("settings-changed", apply);
  apply();

  return { destroy() { state.off("settings-changed", apply); } };
}
