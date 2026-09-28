/**
 * Focus follows the pointer between floating panes and the main surface.
 *
 * Moving a mouse (or trackpad) pointer onto a pane makes it the active
 * pane — editable, focused, the target of the next keystroke and, since
 * an inactive pane's content is `pointer-events: none`, of the next
 * wheel too. Moving it back onto the main surface hands focus back to
 * the main editor. Nothing is raised: stacking order still only changes
 * on a click, so grazing the visible edge of a buried pane doesn't
 * shuffle the pile.
 *
 * It only ever acts on movement. A resting pointer never takes focus,
 * so a caret placed by clicking stays put however long the mouse sits
 * over a pane beside it. Touch and Pencil are ignored — a tap is already
 * a click, and a hovering Pencil isn't a statement about where the next
 * key goes.
 */
import { panes, activePaneId, appState } from "./pane-state.js";

/** A field of the app's own (palette, find bar, a rename input) has the
 *  keyboard — the pointer wandering across the window must not take it.
 *  Only an editing surface's focus is ours to move. */
function focusIsOnAField() {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  if (el.closest?.(".cm-content")) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

function suspended(e) {
  if (e.pointerType !== "mouse") return true;
  // A held button is a drag, a selection or a resize in flight — the
  // gesture already owns its surface.
  if (e.buttons !== 0) return true;
  const body = document.body.classList;
  if (body.contains("zen-focus-active") || body.contains("text-drag-active")) return true;
  if (appState?.ratchetMode) return true;
  return focusIsOnAField();
}

/** The main surface under the pointer, or null for anything else
 *  (sidebars, stickies, the clock, modals). */
function overMainSurface(target) {
  return !!target.closest?.("#editor-container, #notebook-container, #pdf-container, #stack-container");
}

export function installPaneHoverFocus({ focusPane, deactivateAllPanes, saveAllPanes }) {
  let lastPaneId = undefined;
  window.addEventListener("pointermove", (e) => {
    if (suspended(e)) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const paneEl = target.closest(".floating-pane");
    if (paneEl) {
      const id = paneEl.dataset.paneId
        || [...panes.values()].find((p) => p.el === paneEl)?.id;
      if (!id || id === lastPaneId) return;
      lastPaneId = id;
      if (id !== activePaneId) focusPane(id, { hover: true });
      return;
    }
    if (!overMainSurface(target)) return;
    if (lastPaneId === null) return;
    lastPaneId = null;
    if (!activePaneId) return;
    saveAllPanes();
    deactivateAllPanes();
    // Canvas, PDF and stack surfaces read the keyboard off "no pane is
    // active"; only the doc editor wants the DOM focus back.
    const view = appState?.editor?.view;
    if (view && target.closest("#editor-container")) view.focus();
  }, { passive: true });
  // A click decides on its own; resync so the next move starts from it.
  window.addEventListener("pointerdown", () => { lastPaneId = undefined; }, true);
}
