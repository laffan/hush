/**
 * Fold arrow — the in-margin affordance that mirrors a code-fold gutter.
 *
 * A single arrow element lives inside each editor's `scrollDOM` (so the
 * main view, every pane, stack column, and the zen editor each get their
 * own).  It surfaces just inside the left margin:
 *
 *   - beside a heading line while the mouse hovers it (and the section
 *     isn't already folded), or
 *   - beside the first line of any non-empty selection.
 *
 * Clicking it folds the relevant range. Positioning mirrors the line
 * indicator overlay so the arrow lands in the same left-margin gutter
 * regardless of the surface's own padding.
 */
import { ViewPlugin } from "@codemirror/view";
import {
  foldRangeForHeading, isRangeFolded, applyFolds,
} from "./folding.js";

const ARROW_SVG =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4 L6 8 L9.5 4" /></svg>';

export function createFoldArrowPlugin() {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.hoverLineNum = null;
        this.target = null;

        this.arrow = document.createElement("div");
        this.arrow.className = "hush-fold-arrow";
        this.arrow.style.display = "none";
        this.arrow.innerHTML = ARROW_SVG;
        view.scrollDOM.appendChild(this.arrow);

        this.onMove = (e) => this.handleMove(e);
        this.onLeave = () => {
          if (this.hoverLineNum != null) {
            this.hoverLineNum = null;
            this.schedule();
          }
        };
        view.scrollDOM.addEventListener("mousemove", this.onMove);
        view.scrollDOM.addEventListener("mouseleave", this.onLeave);

        // Keep the editor from clearing the selection / moving the caret
        // when the arrow is pressed, then fold on the click.
        this.arrow.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        this.arrow.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.activate();
        });

        this.schedule();
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

      read() {
        const view = this.view;
        const sel = view.state.selection.main;
        let target = null;

        if (!sel.empty) {
          // Selection fold — arrow beside the selection's first line.
          target = {
            kind: "selection",
            from: sel.from,
            to: sel.to,
            anchorPos: view.state.doc.lineAt(sel.from).from,
          };
        } else if (this.hoverLineNum != null) {
          const line = view.state.doc.line(this.hoverLineNum);
          const range = foldRangeForHeading(view.state, line);
          if (range && !isRangeFolded(view.state, range)) {
            target = { kind: "header", from: range.from, to: range.to, anchorPos: line.from };
          }
        }

        if (!target) return null;
        const coords = view.coordsAtPos(target.anchorPos);
        if (!coords) return null;

        const scrollerRect = view.scrollDOM.getBoundingClientRect();
        const contentRect = view.contentDOM.getBoundingClientRect();
        const cs = getComputedStyle(view.contentDOM);
        const padLeft = parseFloat(cs.paddingLeft) || 0;
        return {
          target,
          top: coords.top - scrollerRect.top + view.scrollDOM.scrollTop,
          height: Math.max(1, coords.bottom - coords.top),
          left: contentRect.left - scrollerRect.left + padLeft + view.scrollDOM.scrollLeft,
        };
      }

      write(data) {
        if (!data) {
          this.arrow.style.display = "none";
          this.target = null;
          return;
        }
        this.target = data.target;
        this.arrow.style.display = "flex";
        this.arrow.style.top = data.top + "px";
        this.arrow.style.left = data.left + "px";
        this.arrow.style.height = data.height + "px";
      }

      activate() {
        const t = this.target;
        if (!t) return;
        applyFolds(this.view, [{ from: t.from, to: t.to }]);
        this.hoverLineNum = null;
        this.schedule();
        this.view.focus();
      }

      destroy() {
        this.arrow.remove();
        this.view.scrollDOM.removeEventListener("mousemove", this.onMove);
        this.view.scrollDOM.removeEventListener("mouseleave", this.onLeave);
      }
    }
  );
}
