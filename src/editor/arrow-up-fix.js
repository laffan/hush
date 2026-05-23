/**
 * Explicit one-visual-line-up ArrowUp.
 *
 * CodeMirror 6's default `cursorLineUp` uses visual-y math sized to
 * the *current* line's height to find the previous line. When the
 * adjacent block has a wildly different height (a tall heading next
 * to body text, a tab-marker pill, a project-view separator widget)
 * the heuristic overshoots and the cursor jumps OVER one or more
 * blocks. Plain paragraph navigation is reserved for `Mod+ArrowUp`
 * (the `jumpPrevParagraph` shortcut), so plain ArrowUp must step
 * exactly one visual line at a time.
 *
 * Strategy:
 *   - Inside a wrapped block, move to the previous visual line using
 *     `coordsAtPos(head).top - small` so we stay within the block's
 *     own uniform line heights.
 *   - When the target y crosses the block's top edge, jump explicitly
 *     to the *last* visual line of the previous block. The previous
 *     block is found via `lineBlockAt(block.from - 1)`, which doesn't
 *     depend on any height math.
 *   - Goal column rides through both branches so successive ArrowUps
 *     land in the same visual column even when intermediate lines are
 *     shorter.
 */
import { Prec, EditorSelection } from "@codemirror/state";
import { keymap } from "@codemirror/view";

function arrowUpOneLine(view) {
  const sel = view.state.selection.main;
  if (!sel.empty) return false; // selection extension uses default path
  const head = sel.head;
  const coords = view.coordsAtPos(head);
  if (!coords) return false;
  const block = view.lineBlockAt(head);
  // CM6's SelectionRange uses -1 as the "no goal" sentinel (not undefined),
  // so an `?? coords.left` fallback wouldn't catch it.
  const goalX = (typeof sel.goalColumn === "number" && sel.goalColumn >= 0)
    ? sel.goalColumn
    : coords.left;

  // Try one visual line up *inside the current block* first — keeps
  // wrapped-paragraph navigation working without any height heuristics.
  const targetYIn = coords.top - 2;
  if (targetYIn >= block.top) {
    const pos = view.posAtCoords({ x: goalX, y: targetYIn });
    if (pos != null && pos >= block.from && pos <= block.to && pos !== head) {
      view.dispatch({
        selection: EditorSelection.cursor(pos, undefined, undefined, goalX),
        scrollIntoView: true,
        userEvent: "select",
      });
      return true;
    }
  }

  // Out of the block — step to the *last* visual line of the previous
  // block. If we're already at the very top, consume the key so we
  // don't fall back into CM's heuristic.
  if (block.from === 0) return true;
  const prevBlock = view.lineBlockAt(block.from - 1);
  const targetY = prevBlock.bottom - 2;
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
  keymap.of([{ key: "ArrowUp", run: arrowUpOneLine }])
);
