/**
 * Undo across surfaces, for a card that leaves a canvas for a Doc.
 *
 * Insert-at-cursor on a canvas card, or a canvas card carried into a Doc
 * (as a card, or as text with ⌘ held), is two edits on two histories:
 * the words land in the Doc's text, and the card comes off the canvas.
 * ⌘Z goes to whichever has the keyboard — the Doc, where the words just
 * went — and it took the words out while the card stayed gone, so undo
 * seemed to do nothing useful. The two are linked here: when an undo in
 * the Doc takes the landed text back out, the card goes back on its
 * canvas, where it was; a redo that puts the text back takes the card
 * off again.
 *
 * A link is the range the landing wrote, followed through every later
 * change, and `back` — `restore()` / `take()` for the source. Within one
 * card's move the canvas side (`canvasReturn`) puts back the very shapes
 * that left, ids and all, while that canvas is still on screen; with its
 * pane closed in the meantime, the card goes back into the notebook's
 * file instead (card-transfer.js), in the middle of its view.
 */
import { EditorView } from "@codemirror/view";

/** Links per view, oldest first; a view keeps only the latest few. */
const links = new WeakMap();
const MAX_LINKS = 20;

/** Tie the text a landing wrote at [from, to) in `view` to `back`. */
export function linkReturn(view, from, to, back) {
  if (!view || !back || to <= from) return;
  const list = links.get(view) || [];
  list.push({ from, to, text: view.state.sliceDoc(from, to), live: true, back });
  if (list.length > MAX_LINKS) list.shift();
  links.set(view, list);
}

/** Follows each link through the view's changes; an undo that empties
 *  one restores its card, a redo that writes its text back takes it. */
export const cardReturnWatcher = EditorView.updateListener.of((u) => {
  const list = links.get(u.view);
  if (!list || !u.docChanged) return;
  const undo = u.transactions.some((tr) => tr.isUserEvent("undo"));
  const redo = u.transactions.some((tr) => tr.isUserEvent("redo"));
  for (const r of list) {
    if (r.live) {
      const from = u.changes.mapPos(r.from, 1);
      const to = u.changes.mapPos(r.to, -1);
      if (undo && to <= from) {
        r.live = false;
        r.from = r.to = from;
        queueMicrotask(() => r.back.restore());
      } else {
        r.from = from;
        r.to = Math.max(from, to);
      }
      continue;
    }
    const at = u.changes.mapPos(r.from, -1);
    r.from = r.to = at;
    if (redo && u.state.sliceDoc(at, at + r.text.length) === r.text) {
      r.live = true;
      r.to = at + r.text.length;
      queueMicrotask(() => r.back.take());
    }
  }
});

/**
 * The way back to canvas `nbState` for its card shapes `ids`, as they
 * are now — call it before they are taken off.
 */
export function canvasReturn(nbState, ids) {
  const want = new Set(ids);
  const shapes = (nbState?.shapes || []).filter((s) => want.has(s.id));
  if (!shapes.length) return null;
  const fileId = nbState.hostFileId || null;
  return {
    restore() {
      if (nbState.canvasEl?.isConnected) {
        const have = new Set(nbState.shapes.map((s) => s.id));
        const add = shapes.filter((s) => !have.has(s.id));
        if (!add.length) return;
        nbState.shapes = [...nbState.shapes, ...add];
        nbState.selectedIds = new Set(add.map((s) => s.id));
        nbState.recordHistory();
        nbState.notify("shapes");
        nbState.notify("selectedIds");
        return;
      }
      const appState = window.__hushState__;
      if (!fileId || !appState) return;
      void import("./card-transfer.js").then(async ({ deliverCardToFile }) => {
        for (const s of shapes) await deliverCardToFile(appState, fileId, s.text, s.cardMeta || {});
      }).catch((e) => console.error("Card return failed:", e));
    },
    take() {
      if (!nbState.canvasEl?.isConnected) return;
      void import("../notebook/card-shape.ts").then(({ removeCardShapes }) => removeCardShapes(nbState, shapes.map((s) => s.id)));
    },
  };
}
