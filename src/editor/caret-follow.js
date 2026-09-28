/**
 * Keep the caret on screen when a keyboard shortcut moves it.
 *
 * CodeMirror's own motion commands ask to be scrolled into view; most
 * of Hush's don't — sentence jumps and selects, paragraph moves, the
 * parenthetical ⌘L, heading hops — so the caret could walk right off
 * the bottom of the window while the page stayed where it was. Rather
 * than chase every dispatch (and every one added later), this watches
 * for the pattern itself: a selection set in response to a keystroke,
 * by a transaction that didn't ask to scroll, and follows it with a
 * "nearest" scroll — a no-op while the caret is already visible.
 *
 * Rides both extension lists (the main editor builds its own), so
 * panes, stack columns and the overlays follow too.
 */
import { EditorView, ViewPlugin } from "@codemirror/view";
import { programmaticChange } from "./base-extensions.js";

/** A selection landing this soon after a keydown counts as its doing.
 *  Commands dispatch synchronously from the handler; the slack is for
 *  the ones that await a lazy module first. */
const KEY_WINDOW_MS = 400;

let lastKeyAt = -Infinity;
if (typeof window !== "undefined") {
  // Capture on window: the window-level shortcut fallback runs commands
  // against an editor that doesn't hold focus, so the view's own
  // keydown never sees those keys.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift" || e.key === "Meta" || e.key === "Control" || e.key === "Alt") return;
    lastKeyAt = performance.now();
  }, true);
}

function wantsFollow(update) {
  if (!update.selectionSet) return false;
  if (performance.now() - lastKeyAt > KEY_WINDOW_MS) return false;
  for (const tr of update.transactions) {
    if (tr.scrollIntoView) return false;
    if (tr.annotation(programmaticChange)) return false;
    if (tr.isUserEvent("select.pointer")) return false;
  }
  return true;
}

export const caretFollowPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.view = view; this.pending = false; }
  update(update) {
    if (this.pending || !wantsFollow(update)) return;
    this.pending = true;
    // No dispatch inside an update.
    queueMicrotask(() => {
      this.pending = false;
      const view = this.view;
      if (!view.dom.isConnected) return;
      const head = view.state.selection.main.head;
      view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "nearest", yMargin: 24 }) });
    });
  }
});
