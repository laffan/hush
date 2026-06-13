/**
 * Fold arrow — the in-margin affordance that mirrors a code-fold gutter.
 *
 * Each editor (main view, every pane, stack column, zen overlay) gets
 * its own pool of arrow elements inside `scrollDOM`. Arrows surface just
 * inside the left margin in three situations:
 *
 *   - beside a heading line while the mouse hovers it (down chevron —
 *     click to fold the section), when it isn't already folded;
 *   - beside the first line of any non-empty selection (down chevron —
 *     click to fold the selection); and
 *   - persistently beside every folded heading section (right chevron,
 *     painted red — click to unfold), so a folded section can be
 *     toggled from the arrow as well as from the unwrap pill.
 *
 * Positioning mirrors the line-indicator overlay so the arrow lands in
 * the same left-margin gutter regardless of the surface's own padding.
 */
import { ViewPlugin } from "@codemirror/view";
import { foldedRanges, unfoldEffect } from "@codemirror/language";
import {
  foldRangeForHeading, isRangeFolded, applyFolds, headingLevel,
} from "./folding.js";

const ARROW_SVG =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4 L6 8 L9.5 4" /></svg>';

export function createFoldArrowPlugin() {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.hoverLineNum = null;
        this.arrows = []; // pooled arrow elements

        this.onMove = (e) => this.handleMove(e);
        this.onLeave = () => {
          if (this.hoverLineNum != null) {
            this.hoverLineNum = null;
            this.schedule();
          }
        };
        view.scrollDOM.addEventListener("mousemove", this.onMove);
        view.scrollDOM.addEventListener("mouseleave", this.onLeave);

        this.schedule();
      }

      makeArrow() {
        const el = document.createElement("div");
        el.className = "hush-fold-arrow";
        el.innerHTML = ARROW_SVG;
        // Keep the editor from clearing the selection / moving the caret
        // when the arrow is pressed, then act on the click.
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        el.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.activate(el);
        });
        this.view.scrollDOM.appendChild(el);
        this.arrows.push(el);
        return el;
      }

      handleMove(e) {
        const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) {
          if (this.hoverLineNum != null) {
            this.hoverLineNum = null;
            this.schedule();
          }
          return;
        }
        const lineNum = this.view.state.doc.lineAt(pos).number;
        if (lineNum !== this.hoverLineNum) {
          this.hoverLineNum = lineNum;
          this.schedule();
        }
      }

      update(update) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.geometryChanged ||
          update.focusChanged
        ) {
          this.schedule();
        }
      }

      schedule() {
        this.view.requestMeasure({
          key: "hushFoldArrow",
          read: () => this.read(),
          write: (data) => this.write(data),
        });
      }

      /** Collect the arrows that should be visible right now (persistent
       *  unfold arrows for folded headers, plus the transient
       *  hover / selection fold arrow) and resolve their positions. */
      read() {
        const view = this.view;
        const state = view.state;
        const specs = [];

        // Persistent unfold arrows: one per folded heading section.
        const cur = foldedRanges(state).iter();
        while (cur.value) {
          const from = cur.from;
          const to = cur.to;
          const line = state.doc.lineAt(from);
          if (line.to === from && headingLevel(line.text)) {
            specs.push({ action: "unfold", from, to, anchorPos: line.from, folded: true });
          }
          cur.next();
        }

        // Transient fold arrow: selection wins over hover.
        const sel = state.selection.main;
        if (!sel.empty) {
          specs.push({ action: "fold", from: sel.from, to: sel.to, anchorPos: sel.from, folded: false });
        } else if (this.hoverLineNum != null && this.hoverLineNum <= state.doc.lines) {
          const line = state.doc.line(this.hoverLineNum);
          const range = foldRangeForHeading(state, line);
          // A folded header already shows its persistent unfold arrow.
          if (range && !isRangeFolded(state, range)) {
            specs.push({ action: "fold", from: range.from, to: range.to, anchorPos: line.from, folded: false });
          }
        }

        if (!specs.length) return [];

        const scrollerRect = view.scrollDOM.getBoundingClientRect();
        const contentRect = view.contentDOM.getBoundingClientRect();
        const cs = getComputedStyle(view.contentDOM);
        const padLeft = parseFloat(cs.paddingLeft) || 0;
        const left = contentRect.left - scrollerRect.left + padLeft + view.scrollDOM.scrollLeft;

        const out = [];
        for (const s of specs) {
          const coords = view.coordsAtPos(s.anchorPos);
          if (!coords) continue; // hidden inside another fold
          out.push({
            ...s,
            left,
            top: coords.top - scrollerRect.top + view.scrollDOM.scrollTop,
            height: Math.max(1, coords.bottom - coords.top),
          });
        }
        return out;
      }

      write(list) {
        list = list || [];
        while (this.arrows.length < list.length) this.makeArrow();
        for (let i = 0; i < this.arrows.length; i++) {
          const el = this.arrows[i];
          const spec = list[i];
          if (!spec) {
            el.style.display = "none";
            el._foldTarget = null;
            continue;
          }
          el._foldTarget = spec;
          el.classList.toggle("hush-fold-arrow-folded", !!spec.folded);
          el.style.display = "flex";
          el.style.top = spec.top + "px";
          el.style.left = spec.left + "px";
          el.style.height = spec.height + "px";
        }
      }

      activate(el) {
        const t = el?._foldTarget;
        if (!t) return;
        if (t.action === "unfold") {
          this.view.dispatch({ effects: unfoldEffect.of({ from: t.from, to: t.to }) });
        } else {
          applyFolds(this.view, [{ from: t.from, to: t.to }]);
        }
        this.hoverLineNum = null;
        this.schedule();
        this.view.focus();
      }

      destroy() {
        for (const el of this.arrows) el.remove();
        this.arrows = [];
        this.view.scrollDOM.removeEventListener("mousemove", this.onMove);
        this.view.scrollDOM.removeEventListener("mouseleave", this.onLeave);
      }
    }
  );
}
