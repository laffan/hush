/**
 * Sticky Headers Plugin
 *
 * When enabled, shows the heading hierarchy for the current scroll position
 * pinned to the top of the editor. Clicking a header scrolls to that heading.
 */
import { ViewPlugin } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";

let containerEl = null;
let layoutHandler = null;

export function createStickyHeadersPlugin(stateRef) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.scrollHandler = null;
        this.lastHtml = "";
        this.setupIfNeeded();
      }

      update(update) {
        this.refresh();
      }

      setupIfNeeded() {
        if (!stateRef.settings.stickyHeaders) {
          this.teardown();
          return;
        }
        if (!containerEl) {
          containerEl = document.createElement("div");
          containerEl.className = "sticky-headers";
          const editorContainer = document.getElementById("editor-container");
          if (editorContainer) {
            editorContainer.insertBefore(containerEl, editorContainer.firstChild);
          }
          // Click handler: scroll to the heading
          containerEl.addEventListener("click", (e) => {
            const headerEl = e.target.closest(".sticky-header");
            if (!headerEl) return;
            const from = parseInt(headerEl.dataset.from, 10);
            if (isNaN(from)) return;
            this.view.dispatch({
              selection: EditorSelection.cursor(from),
              effects: [],
            });
            this.view.focus();
            // Scroll the heading to the top of the viewport
            const coords = this.view.coordsAtPos(from);
            if (coords) {
              const scroller = this.view.scrollDOM;
              const scrollerRect = scroller.getBoundingClientRect();
              scroller.scrollBy({ top: coords.top - scrollerRect.top - 10, behavior: "smooth" });
            }
          });
        }
        if (!this.scrollHandler) {
          const scroller = this.view.scrollDOM;
          this.scrollHandler = () => this.refresh();
          scroller.addEventListener("scroll", this.scrollHandler, {
            passive: true,
          });
        }
        if (!layoutHandler) {
          layoutHandler = () => this.syncPadding();
          stateRef.on("layout-changed", layoutHandler);
        }
        this.syncPadding();
        this.refresh();
      }

      syncPadding() {
        if (!containerEl) return;
        const scroller = document.querySelector(
          "#editor-container .cm-scroller"
        );
        if (scroller) {
          containerEl.style.paddingLeft = scroller.style.paddingLeft || "";
          containerEl.style.paddingRight = scroller.style.paddingRight || "";
        }
      }

      refresh() {
        if (!stateRef.settings.stickyHeaders) {
          this.teardown();
          return;
        }
        if (!containerEl) {
          this.setupIfNeeded();
          return;
        }

        const view = this.view;
        const doc = view.state.doc;
        const topPos = view.viewport.from;

        const stack = [];
        for (let i = 1; i <= doc.lines; i++) {
          const line = doc.line(i);
          if (line.from > topPos) break;
          const match = line.text.match(/^(#{1,6})\s+(.+)/);
          if (match) {
            const h = {
              level: match[1].length,
              text: match[2].trim(),
              from: line.from,
            };
            while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
              stack.pop();
            }
            stack.push(h);
          }
        }

        if (stack.length === 0) {
          if (this.lastHtml !== "") {
            containerEl.innerHTML = "";
            this.lastHtml = "";
          }
          return;
        }

        const html = stack
          .map(
            (h) =>
              `<div class="sticky-header sticky-header-h${h.level}" data-from="${h.from}">${escapeHtml(h.text)}</div>`
          )
          .join("");
        if (html !== this.lastHtml) {
          containerEl.innerHTML = html;
          this.lastHtml = html;
        }
      }

      teardown() {
        if (this.scrollHandler && this.view) {
          this.view.scrollDOM.removeEventListener("scroll", this.scrollHandler);
          this.scrollHandler = null;
        }
        if (layoutHandler) {
          stateRef.off("layout-changed", layoutHandler);
          layoutHandler = null;
        }
        if (containerEl) {
          containerEl.remove();
          containerEl = null;
        }
        this.lastHtml = "";
      }

      destroy() {
        this.teardown();
      }
    }
  );
}

export function updateStickyHeaders(view, state) {
  if (view) view.dispatch({ effects: [] });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
