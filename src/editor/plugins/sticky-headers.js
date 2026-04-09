/**
 * Sticky Headers Plugin
 *
 * When enabled, shows the heading hierarchy for the current scroll position
 * pinned to the top of the editor, similar to sticky table headers on the web.
 */
import { ViewPlugin } from "@codemirror/view";

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
        // Always re-check: refresh() is cheap (caches HTML, early-returns
        // when disabled) and must run on settings-toggle transactions.
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
            // Insert as first child so it's on top of .cm-editor
            editorContainer.insertBefore(containerEl, editorContainer.firstChild);
          }
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

        // Determine the document position at the top of the visible area.
        // Use the viewport start (reliable) instead of posAtCoords (which
        // returns null when the probe lands in the scroller's padding).
        const topPos = view.viewport.from;

        // Collect all headings in the document up to the viewport start
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
            while (
              stack.length > 0 &&
              stack[stack.length - 1].level >= h.level
            ) {
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
              `<div class="sticky-header sticky-header-h${h.level}">${escapeHtml(h.text)}</div>`
          )
          .join("");
        if (html !== this.lastHtml) {
          containerEl.innerHTML = html;
          this.lastHtml = html;
        }
      }

      teardown() {
        if (this.scrollHandler && this.view) {
          this.view.scrollDOM.removeEventListener(
            "scroll",
            this.scrollHandler
          );
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

/**
 * Call when the stickyHeaders setting changes to toggle the feature.
 */
export function updateStickyHeaders(view, state) {
  if (view) view.dispatch({ effects: [] });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
