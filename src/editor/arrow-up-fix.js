/**
 * One-block-up ArrowUp.
 *
 * CodeMirror 6's default `cursorLineUp` uses visual-y math to decide
 * where the previous line is, which works when every line in the
 * viewport is the same height. The moment lines have wildly different
 * heights (a tall heading next to body text, a bold line on its own,
 * a tab-marker pill, a project-view separator widget) the heuristic
 * overshoots and the cursor jumps OVER the adjacent line, landing two
 * blocks up.
 *
 * This keymap pre-empts ArrowUp and, when the cursor sits on the
 * first visual line of its block, navigates explicitly to the previous
 * block — preserving the column via `goalColumn`. When the cursor sits
 * on a wrapped continuation line inside the same block, we yield to
 * CodeMirror's default so within-block visual navigation still works.
 */
import { Prec } from "@codemirror/state";
import { EditorSelection } from "@codemirror/state";
import { keymap } from "@codemirror/view";

function arrowUpOneBlock(view) {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const head = sel.head;
  const coords = view.coordsAtPos(head);
  if (!coords) return false;
  const block = view.lineBlockAt(head);
  // Only override when the cursor is on the first visual line of the
  // current block — otherwise let CodeMirror handle in-block wrap.
  if (coords.top - block.top > 4) return false;
  if (block.from === 0) return false;

  const prevBlock = view.lineBlockAt(block.from - 1);
  // CM6's SelectionRange uses -1 as the "no goal" sentinel rather than
  // undefined, so an `?? coords.left` fallback wouldn't catch it.
  const goalX = (typeof sel.goalColumn === "number" && sel.goalColumn >= 0)
    ? sel.goalColumn
    : coords.left;
  // Land in the LAST visual line of the previous block (one pixel
  // inside its bottom edge), preserving the cursor's x.
  const targetY = prevBlock.bottom - 1;
  let pos = view.posAtCoords({ x: goalX, y: targetY });
  if (pos == null) pos = prevBlock.to;
  pos = Math.max(prevBlock.from, Math.min(prevBlock.to, pos));

  view.dispatch({
    selection: EditorSelection.cursor(pos, undefined, undefined, goalX),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

export const arrowUpFix = Prec.high(
  keymap.of([{ key: "ArrowUp", run: arrowUpOneBlock }])
);
