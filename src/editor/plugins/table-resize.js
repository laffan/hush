/**
 * Column resizing for a rendered table. Every inner column border of the
 * header carries a grip; dragging it moves width between the two
 * columns either side, and letting go writes the widths into the
 * delimiter row (table-model.js — dash counts totalling 100), one undo
 * step. Two presses on a grip in quick succession put the table back on
 * its content-sized widths.
 *
 * The first drag of a content-sized table switches it to set widths
 * starting from the ones on screen; whatever the column has left over
 * goes to the last column, so the border under the pointer doesn't
 * move — the table's right edge goes out to the column's. A column
 * stops at its longest word (styles/editor.css, `.cm-md-table-sized`):
 * past that the border stops following the pointer.
 */
import {
  tableAtLine, parseAligns, formatDelimiter, roundWidths, MIN_COL_PCT,
} from "./table-model.js";

const DOUBLE_PRESS_MS = 350;

/** Show `pct` (percentages, or null for content-sized) on the table. */
export function applyColumnWidths(table, pct) {
  const cols = table.querySelectorAll(":scope > colgroup > col");
  table.classList.toggle("cm-md-table-sized", !!pct);
  cols.forEach((col, i) => { col.style.width = pct ? `${pct[i]}%` : ""; });
}

/** Rewrite the delimiter row of the table `wrap` draws. Returns whether
 *  the document took the change (ratchet refuses it, for one). */
function writeWidths(view, wrap, widths) {
  let pos;
  try { pos = view.posAtDOM(wrap); } catch { return false; }
  const doc = view.state.doc;
  const t = tableAtLine(doc, doc.lineAt(Math.min(pos, doc.length)).number);
  if (!t) return false;
  const aligns = parseAligns(t.delimText);
  // A delimiter row out of step with the header has no width per column.
  if (widths && widths.length !== aligns.length) return false;
  const next = formatDelimiter(aligns, widths, t.delimText);
  if (next === t.delimText) return true;
  const to = t.delimFrom + t.delimText.length;
  view.dispatch({
    changes: { from: t.delimFrom, to, insert: next },
    userEvent: "input.table",
  });
  return view.state.doc.sliceString(t.delimFrom, t.delimFrom + next.length) === next;
}

/**
 * Wire the grips of one rendered table. `widths` is what the markdown
 * says now (null when content-sized) — the state a refused write puts
 * back on screen.
 */
export function attachColumnResize(view, wrap, table, widths) {
  let lastPress = { col: -1, t: 0 };

  // The grips hang from the header cells; this is how far down they
  // reach. Measured on the way in, so a table nobody points at costs
  // nothing.
  wrap.addEventListener("pointerenter", () => {
    table.style.setProperty("--cm-md-table-h", `${table.offsetHeight}px`);
  });

  wrap.addEventListener("pointerdown", (e) => {
    const grip = e.target.closest?.(".cm-md-table-resizer");
    if (!grip || e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    const col = +grip.dataset.col;

    const now = Date.now();
    if (lastPress.col === col && now - lastPress.t < DOUBLE_PRESS_MS) {
      lastPress = { col: -1, t: 0 };
      if (widths && !writeWidths(view, wrap, null)) applyColumnWidths(table, widths);
      return;
    }
    lastPress = { col, t: now };

    const avail = wrap.clientWidth;
    if (!avail) return;
    const cells = [...table.tHead.rows[0].cells];
    let pct = cells.map((c) => (c.getBoundingClientRect().width / avail) * 100);
    const sum = pct.reduce((a, b) => a + b, 0);
    if (sum > 100) pct = pct.map((p) => (p * 100) / sum);
    else pct[pct.length - 1] += 100 - sum;
    applyColumnWidths(table, pct);

    const startX = e.clientX;
    const a = pct[col];
    const b = pct[col + 1];
    let moved = false;
    wrap.classList.add("cm-md-table-resizing");
    grip.classList.add("active");
    try { grip.setPointerCapture(e.pointerId); } catch { /* already released */ }

    const onMove = (ev) => {
      let d = ((ev.clientX - startX) / avail) * 100;
      d = Math.max(MIN_COL_PCT - a, Math.min(b - MIN_COL_PCT, d));
      if (Math.abs(ev.clientX - startX) > 2) moved = true;
      pct[col] = a + d;
      pct[col + 1] = b - d;
      applyColumnWidths(table, pct);
    };
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      wrap.classList.remove("cm-md-table-resizing");
      grip.classList.remove("active");
      // A press that didn't move leaves the markdown alone — it may be
      // the first half of the double press that resets.
      if (!moved) { applyColumnWidths(table, widths); return; }
      lastPress = { col: -1, t: 0 };
      // What is on screen, not what the pointer asked for: a column held
      // at its longest word is wider than its share of the drag.
      const drawn = cells.map((c) => c.getBoundingClientRect().width);
      if (!writeWidths(view, wrap, roundWidths(drawn))) applyColumnWidths(table, widths);
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  });
}
