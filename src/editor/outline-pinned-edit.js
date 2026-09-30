/**
 * Editing a pinned outline from its panel.
 *
 * A pinned outline has left the text — its block is collapsed out of the
 * document and redrawn by the panel docked to the bottom of the frame —
 * so the panel is the only place it can be worked on. Its rows therefore
 * take the edits an in-flow outline gets from CodeMirror: typing into an
 * item, Enter for a new item, Backspace on an empty one to remove it,
 * Tab / Shift-Tab to indent and outdent, the arrows to move between
 * items, ⌘Z / ⌘⇧Z, and the grip to drag an item (children and all) to
 * another place in the outline.
 *
 * Every one of them is a transaction on the editor's own document,
 * addressed by line number — the panel holds no copy of the outline, it
 * only redraws what the document says.
 */

import { undo, redo } from "@codemirror/commands";
import { parseOutlineLine } from "../outline/outline-model.ts";
import { applyOutlineMove, outlineMoveChanges, startOutlineDrag, unitEnd } from "./outline-move.js";
import { caretOffset, focusRowText } from "./outline-dom.js";

/** One level of indent in the panel, in px (`.outline-row` in outline.css). */
const PANEL_INDENT_PX = 18;

/** Document line `n`, split into its checklist head (`  - [ ] `, always
 *  ending in one space) and its text; null when it has stopped being an
 *  outline item since the panel was drawn. */
function itemLine(view, n) {
  const doc = view.state.doc;
  if (n < 1 || n > doc.lines) return null;
  const line = doc.line(n);
  const parsed = parseOutlineLine(line.text, n);
  if (!parsed) return null;
  const head = line.text.slice(0, line.text.length - parsed.text.length).replace(/[ \t]?$/, " ");
  return { line, parsed, head };
}

/**
 * @param {import("@codemirror/view").EditorView} view
 * @param {() => ({ items: object[] } | null)} currentBlock
 *   The pinned block as the document stands now.
 * @param {(req: { line: number, offset: number } | null) => void} focusAfter
 *   Where the caret goes once the rows are rebuilt by the edit (null
 *   withdraws a request whose edit turned out to change nothing).
 */
export function pinnedRowHandlers(view, currentBlock, focusAfter) {
  const indexOf = (items, line) => items.findIndex((it) => it.line === line);

  /** A keystroke in a row. Dispatched as just the span that changed —
   *  the text between the common head and tail of old and new — marked
   *  as typing, so CodeMirror's history groups a run of it into one undo
   *  step the way it does typing in the document. Rewriting the whole
   *  line each time made every character its own step. */
  const onEdit = (item, text) => {
    const at = itemLine(view, item.line);
    if (!at) return;
    const old = at.parsed.text;
    if (old === text) return;
    let a = 0;
    while (a < old.length && a < text.length && old[a] === text[a]) a++;
    let b = 0;
    while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++;
    const base = at.line.to - old.length;
    view.dispatch({
      changes: { from: base + a, to: at.line.to - b, insert: text.slice(a, text.length - b) },
      userEvent: text.length < old.length ? "delete.backward" : "input.type",
    });
  };

  /** Enter: split the item at the caret. The new item is the next
   *  sibling — or, when the item has children, its first child, so the
   *  children don't end up under the new item instead. */
  const split = (item, label) => {
    const block = currentBlock();
    const at = itemLine(view, item.line);
    if (!block || !at) return;
    const i = indexOf(block.items, item.line);
    const text = label.textContent || "";
    const offset = Math.min(caretOffset(label), text.length);
    const lead = at.line.text.match(/^\s*/)[0];
    const bullet = at.line.text.slice(lead.length, lead.length + 1);
    const hasKids = i >= 0 && i + 1 < block.items.length && block.items[i + 1].depth > block.items[i].depth;
    const newLead = hasKids ? `${lead}  ` : lead;
    focusAfter({ line: item.line + 1, offset: 0 });
    view.dispatch({
      changes: {
        from: at.line.from,
        to: at.line.to,
        insert: `${at.head}${text.slice(0, offset)}\n${newLead}${bullet} [ ] ${text.slice(offset)}`,
      },
      userEvent: "input.outline",
    });
  };

  /** Backspace in an empty item takes the item away and puts the caret
   *  at the end of the one above. The last item of an outline stays —
   *  removing it would take the whole pinned outline with it. */
  const removeEmpty = (item) => {
    const block = currentBlock();
    const at = itemLine(view, item.line);
    if (!block || !at || block.items.length < 2) return;
    const doc = view.state.doc;
    const from = at.line.from > 0 ? at.line.from - 1 : at.line.from;
    const to = at.line.from > 0 ? at.line.to : Math.min(doc.length, at.line.to + 1);
    const i = indexOf(block.items, item.line);
    focusAfter(i > 0 ? { line: item.line - 1, offset: Infinity } : { line: item.line, offset: 0 });
    view.dispatch({ changes: { from, to }, userEvent: "delete.outline" });
  };

  /** Tab / Shift-Tab: one level in or out, children and all. In goes no
   *  deeper than one under the item above; out stops at the margin. */
  const indent = (item, dir, label) => {
    const block = currentBlock();
    if (!block) return;
    const items = block.items;
    const i = indexOf(items, item.line);
    if (i < 0) return;
    const base = items.reduce((m, it) => Math.min(m, it.depth), Infinity);
    const depth = items[i].depth + dir;
    if (dir > 0 && (i === 0 || depth > items[i - 1].depth + 1)) return;
    if (dir < 0 && depth < base) return;
    const plan = outlineMoveChanges(view.state.doc, items, i, i, depth);
    if (!plan) return;
    focusAfter({ line: item.line, offset: caretOffset(label) });
    view.dispatch({ changes: plan.changes, userEvent: "move.outline" });
  };

  /** Up / Down: to the item above or below — the end of the one above,
   *  the start of the one below. */
  const step = (label, dir) => {
    const list = label.closest(".outline-rows");
    if (!list) return false;
    const labels = [...list.querySelectorAll(".outline-row-text")];
    const k = labels.indexOf(label);
    const to = labels[k + dir];
    if (!to) return false;
    const block = currentBlock();
    const it = block?.items.find((x) => x.line === Number(to.dataset.line));
    if (!it) return false;
    return focusRowText(list, it.line, dir < 0 ? it.text.length : 0, it.text);
  };

  const onKey = (item, e, label) => {
    if (e.isComposing) return false;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;
    if (key === "Enter" && !e.shiftKey && !mod) { split(item, label); return true; }
    if (key === "Backspace" && !mod && !(label.textContent || "").length) { removeEmpty(item); return true; }
    if (key === "Tab") { indent(item, e.shiftKey ? -1 : 1, label); return true; }
    if (key === "Escape") { label.blur(); return true; }
    if ((key === "ArrowUp" || key === "ArrowDown") && !mod && !e.shiftKey && !e.altKey) {
      return step(label, key === "ArrowUp" ? -1 : 1);
    }
    if (mod && (key === "z" || key === "Z" || key === "y")) {
      // Set before the command: its dispatch rebuilds the rows at once.
      focusAfter({ line: item.line, offset: caretOffset(label) });
      const done = key === "y" || e.shiftKey ? redo(view) : undo(view);
      if (!done) focusAfter(null);
      return true;
    }
    return false;
  };

  const onDragStart = (index, e, row) => {
    const block = currentBlock();
    const list = row.closest(".outline-rows");
    if (!block || !list) return;
    const items = block.items;
    const last = unitEnd(items, index);
    const rows = [...list.querySelectorAll(".outline-row")];
    const measured = rows.map((el) => {
      const r = el.getBoundingClientRect();
      const box = el.querySelector(".outline-row-box");
      return {
        el,
        index: Number(el.dataset.index),
        top: r.top,
        bottom: r.bottom,
        left: (box || el).getBoundingClientRect().left,
      };
    });
    const src = measured.find((m) => m.index === index);
    if (!src) return;
    const moving = measured.filter((m) => m.index >= index && m.index <= last);
    startOutlineDrag(e, {
      items,
      src: index,
      measure: () => measured,
      indentPx: PANEL_INDENT_PX,
      srcLeft: src.left,
      markerHost: list,
      markerRight: list.getBoundingClientRect().right - 10,
      onStart: () => moving.forEach((m) => m.el.classList.add("outline-dragging")),
      onEnd: () => moving.forEach((m) => m.el.classList.remove("outline-dragging")),
      onDrop: (at, depth) => {
        const now = currentBlock();
        if (!now || now.items.length !== items.length) return;
        applyOutlineMove(view, now.items, index, at, depth);
      },
    });
  };

  return { onEdit, onKey, onDragStart };
}
