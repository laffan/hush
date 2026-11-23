/**
 * The Desk Dashboard's two borders, drag-resizable: the one between the
 * sidebar and the desks sets the sidebar's width, the one between Recent
 * and the To-do list sets Recent's height. Each drag is written to
 * settings when it ends (`deskDashSideWidth`, `deskDashRecentsHeight`,
 * `Option<u32>` on the Rust side), so the dashboard opens at that size
 * next time and in the next session. A double-click on a border puts its
 * default back (null): 340 px, and Recent sized to its rows.
 *
 * The stored numbers are what the user dragged to; the room they get is
 * the window's. CSS caps both live (the sidebar's `max-width`, Recent's
 * `max-height`) so a smaller window shrinks them without rewriting the
 * setting, and the drag clamps to the same room. In the narrow, stacked
 * layout neither border drags (desk-dashboard.css).
 */

/** The sidebar's narrowest: the To-do list's tools still beside a title. */
const SIDE_MIN = 240;
/** What the desks keep beside the sidebar: one card column (260) and padding. */
const MAIN_MIN = 300;
/** Recent's least: its heading and a row. */
const RECENTS_MIN = 56;
/** What the To-do list keeps under Recent: its search and a few rows. */
const TODO_MIN = 160;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Wire the borders of the dashboard in `root`. Returns `{ destroy }`.
 */
export function wireDashboardResize(state, root) {
  const dash = root.querySelector(".desk-dash");
  const side = root.querySelector(".desk-dash-side");
  const recents = root.querySelector(".desk-dash-recents");
  const colBar = root.querySelector(".desk-dash-col-resizer");
  const rowBar = root.querySelector(".desk-dash-row-resizer");
  let dragging = false;

  /** Size both from settings: a stored number pins it, null leaves CSS's default. */
  function apply() {
    if (dragging) return;
    const w = state.settings?.deskDashSideWidth;
    const h = state.settings?.deskDashRecentsHeight;
    side.style.width = Number.isFinite(w) ? `${w}px` : "";
    recents.style.height = Number.isFinite(h) ? `${h}px` : "";
    recents.classList.toggle("sized", Number.isFinite(h));
  }

  const stacked = () => getComputedStyle(dash).flexDirection === "column";

  /** One drag on `bar`: `size(delta)` sizes the element from the pointer's
   *  travel along its axis and returns the px to keep, `key` names the
   *  setting it is written to. */
  function drag(bar, axis, key, start, size) {
    bar.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || stacked()) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      bar.setPointerCapture(e.pointerId);
      bar.classList.add("dragging");
      dash.classList.add(`resizing-${axis}`);
      const from = axis === "col" ? e.clientX : e.clientY;
      const base = start();
      let kept = base;
      const onMove = (me) => { kept = size(base + (axis === "col" ? me.clientX : me.clientY) - from); };
      const onUp = () => {
        bar.removeEventListener("pointermove", onMove);
        bar.removeEventListener("pointerup", onUp);
        bar.removeEventListener("pointercancel", onUp);
        if (bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId);
        bar.classList.remove("dragging");
        dash.classList.remove(`resizing-${axis}`);
        dragging = false;
        if (Math.round(kept) === Math.round(base)) return;
        state.updateSettings({ [key]: Math.round(kept) })
          .catch((err) => console.warn(`Save ${key} failed:`, err));
      };
      bar.addEventListener("pointermove", onMove);
      bar.addEventListener("pointerup", onUp);
      bar.addEventListener("pointercancel", onUp);
    });
    // Back to the default size.
    bar.addEventListener("dblclick", () => {
      if (stacked()) return;
      state.updateSettings({ [key]: null })
        .catch((err) => console.warn(`Reset ${key} failed:`, err));
    });
  }

  drag(colBar, "col", "deskDashSideWidth",
    () => side.getBoundingClientRect().width,
    (w) => {
      const v = clamp(w, SIDE_MIN, Math.max(SIDE_MIN, dash.clientWidth - MAIN_MIN));
      side.style.width = `${v}px`;
      return v;
    });
  drag(rowBar, "row", "deskDashRecentsHeight",
    () => recents.getBoundingClientRect().height,
    (h) => {
      const v = clamp(h, RECENTS_MIN, Math.max(RECENTS_MIN, side.clientHeight - TODO_MIN));
      recents.style.height = `${v}px`;
      recents.classList.add("sized");
      return v;
    });

  // A size set in another window, or reset by a double-click here.
  state.on("settings-changed", apply);
  apply();

  return { destroy() { state.off("settings-changed", apply); } };
}
