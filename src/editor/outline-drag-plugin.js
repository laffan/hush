/**
 * Dragging items in an in-flow Doc outline.
 *
 * Hovering an outline line shows a grip just left of its checkbox — in
 * the margin the list indent leaves there. Dragging the grip lifts the
 * item together with everything nested under it, a marker shows where
 * it will land and at what depth (horizontal travel sets the depth), and
 * the drop moves the lines in one transaction (`outline-move.js`).
 *
 * The grip is one element floating over the editor rather than a widget
 * in each line: a widget is something the caret walks through, and the
 * lines are CodeMirror's to redraw. The lines being dragged are faded by
 * a line decoration for the same reason — a class stamped on CodeMirror's
 * DOM would be gone at its next redraw.
 */

import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import { applyOutlineMove, startOutlineDrag, unitEnd, GRIP_ICON } from "./outline-move.js";

/** Lines being dragged — `{ from, to }` line numbers, or null. */
const setDragLines = StateEffect.define();

const dragSourceDeco = Decoration.line({ class: "cm-outline-drag-src" });

const dragLinesField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setDragLines)) continue;
      if (!e.value) return Decoration.none;
      const ranges = [];
      for (let n = e.value.from; n <= e.value.to && n <= tr.state.doc.lines; n++) {
        ranges.push(dragSourceDeco.range(tr.state.doc.line(n).from));
      }
      return Decoration.set(ranges);
    }
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The block holding 1-based document line `n`, and the item's index. */
function findItem(blocks, n) {
  for (const block of blocks || []) {
    if (n < block.fromLine || n > block.toLine) continue;
    const i = block.items.findIndex((it) => it.line === n);
    return i < 0 ? null : { block, index: i };
  }
  return null;
}

/** The rendered `.cm-line` for document line `n`, or null when it isn't
 *  drawn (outside the viewport, or folded away as a hidden done item). */
function lineElement(view, n) {
  const line = view.state.doc.line(n);
  let dom;
  try { dom = view.domAtPos(line.from).node; } catch { return null; }
  const el = dom?.nodeType === 1 ? dom.closest?.(".cm-line") : dom?.parentElement?.closest(".cm-line");
  if (!el || !el.classList.contains("cm-outline-line")) return null;
  try {
    if (view.state.doc.lineAt(view.posAtDOM(el)).number !== n) return null;
  } catch { return null; }
  return el;
}

/** Left edge of a line's checkbox, or of its text box when the box isn't
 *  drawn (a caret parked inside `[ ]` shows it as text). */
function boxLeft(el) {
  const box = el.querySelector(".cm-task-checkbox");
  return (box || el).getBoundingClientRect().left;
}

/** Width of one nesting level, read off two drawn items of different
 *  depth; 30 px (heading-indent.js's LIST_LEFT_INDENT_PX) otherwise. */
function indentWidth(rows) {
  for (let a = 0; a < rows.length; a++) {
    for (let b = a + 1; b < rows.length; b++) {
      const dd = rows[b].depth - rows[a].depth;
      if (dd) return Math.abs((rows[b].left - rows[a].left) / dd) || 30;
    }
  }
  return 30;
}

export function makeOutlineDragPlugin(field) {
  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.line = 0;      // document line the grip is showing for
        this.dragging = false;
        this.handle = document.createElement("div");
        this.handle.className = "cm-outline-handle";
        this.handle.hidden = true;
        this.handle.innerHTML = GRIP_ICON;
        this.handle.setAttribute("aria-hidden", "true");
        this.handle.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        this.handle.addEventListener("pointerdown", (e) => this.onPress(e));
        view.dom.appendChild(this.handle);

        this.onMove = (e) => this.hover(e);
        this.onLeave = (e) => {
          if (this.dragging || this.handle.contains(e.relatedTarget)) return;
          this.hide();
        };
        this.onScroll = () => { if (!this.dragging) this.hide(); };
        view.dom.addEventListener("pointermove", this.onMove);
        view.dom.addEventListener("pointerleave", this.onLeave);
        view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
      }

      update(update) {
        if (!this.dragging && (update.docChanged || update.viewportChanged || update.geometryChanged)) this.hide();
      }

      destroy() {
        this.view.dom.removeEventListener("pointermove", this.onMove);
        this.view.dom.removeEventListener("pointerleave", this.onLeave);
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
        this.handle.remove();
      }

      hide() {
        this.handle.hidden = true;
        this.line = 0;
      }

      hover(e) {
        if (this.dragging || e.pointerType === "touch") return;
        if (this.handle.contains(e.target)) return;
        const el = e.target?.closest?.(".cm-outline-line");
        if (!el || !this.view.contentDOM.contains(el) || !this.view.state.facet(EditorView.editable)) {
          this.hide();
          return;
        }
        let n;
        try { n = this.view.state.doc.lineAt(this.view.posAtDOM(el)).number; } catch { this.hide(); return; }
        if (n === this.line && !this.handle.hidden) return;
        this.line = n;
        this.place(el);
      }

      /** Seat the grip just left of the line's checkbox, centred on it. */
      place(el) {
        const host = this.view.dom.getBoundingClientRect();
        const box = el.querySelector(".cm-task-checkbox");
        const r = (box || el).getBoundingClientRect();
        const left = (box ? r.left : r.left + 8) - host.left - 16;
        const top = r.top + r.height / 2 - host.top - 9;
        this.handle.style.left = `${Math.round(left)}px`;
        this.handle.style.top = `${Math.round(top)}px`;
        this.handle.hidden = false;
      }

      onPress(e) {
        if (e.button !== 0 || !this.line) return;
        e.preventDefault();
        e.stopPropagation();
        const view = this.view;
        const value = view.state.field(field, false);
        const found = findItem(value?.blocks, this.line);
        if (!found) return;
        const { block, index } = found;
        const items = block.items;
        const srcLine = items[index].line;
        const srcEndLine = items[unitEnd(items, index)].line;

        // Every drawn item of the block, measured once for the gesture.
        const drawn = [];
        items.forEach((it, i) => {
          const el = lineElement(view, it.line);
          if (!el) return;
          const r = el.getBoundingClientRect();
          drawn.push({ index: i, depth: it.depth, top: r.top, bottom: r.bottom, left: boxLeft(el), right: r.right });
        });
        const src = drawn.find((d) => d.index === index);
        if (!src) return;

        startOutlineDrag(e, {
          items,
          src: index,
          measure: () => drawn,
          indentPx: indentWidth(drawn),
          srcLeft: src.left,
          markerHost: view.dom,
          markerRight: src.right - 8,
          onStart: () => {
            this.dragging = true;
            this.handle.classList.add("dragging");
            view.dispatch({ effects: setDragLines.of({ from: srcLine, to: srcEndLine }) });
          },
          onEnd: () => {
            this.dragging = false;
            this.handle.classList.remove("dragging");
            this.hide();
            view.dispatch({ effects: setDragLines.of(null) });
          },
          onDrop: (at, depth) => {
            // Re-read the block: the drop is applied against the document
            // as it is now, and only if it is still the outline the drag
            // measured.
            const now = findItem(view.state.field(field, false)?.blocks, srcLine);
            if (!now || now.index !== index || now.block.items.length !== items.length) return;
            applyOutlineMove(view, now.block.items, index, at, depth);
          },
        });
      }
    },
  );
  return [dragLinesField, plugin];
}
