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
        if (update.docChanged || update.viewportChanged) {
          this.refresh();
        }
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
          if (editorContainer) editorContainer.appendChild(containerEl);
        }
        if (!this.scrollHandler) {
          const scroller = this.view.scrollDOM;
          this.scrollHandler = () => this.refresh();
          scroller.addEventListener("scroll", this.scrollHandler, { passive: true });
        }
        // Listen for layout changes to sync padding
        if (!layoutHandler) {
          layoutHandler = () => this.syncPadding();
          stateRef.on("layout-changed", layoutHandler);
        }
        this.syncPadding();
        this.refresh();
      }

      syncPadding() {
        if (!containerEl) return;
        const scroller = document.querySelector("#editor-container .cm-scroller");
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

        const scroller = this.view.scrollDOM;
        const doc = this.view.state.doc;
        const editorRect = scroller.getBoundingClientRect();

        // Find the top-most visible line position (below the sticky header area)
        const stickyHeight = containerEl.offsetHeight || 0;
        const topPos = this.view.posAtCoords({
          x: editorRect.left + editorRect.width / 2,
          y: editorRect.top + stickyHeight + 5,
        });
        if (topPos === null) {
          if (this.lastHtml !== "") { containerEl.innerHTML = ""; this.lastHtml = ""; }
          return;
        }

        // Collect all headings in the document
        const headings = [];
        for (let i = 1; i <= doc.lines; i++) {
          const line = doc.line(i);
          const match = line.text.match(/^(#{1,6})\s+(.+)/);
          if (match) {
            headings.push({
              level: match[1].length,
              text: match[2].trim(),
              from: line.from,
            });
          }
        }

        if (headings.length === 0) {
          if (this.lastHtml !== "") { containerEl.innerHTML = ""; this.lastHtml = ""; }
          return;
        }

        // Find the heading hierarchy above the current scroll position.
        const stack = [];
        for (const h of headings) {
          if (h.from > topPos) break;
          // Pop any headings at the same level or deeper
          while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
            stack.pop();
          }
          stack.push(h);
        }

        if (stack.length === 0) {
          if (this.lastHtml !== "") { containerEl.innerHTML = ""; this.lastHtml = ""; }
          return;
        }

        // Only update DOM if content changed (avoid thrashing during scroll)
        const html = stack
          .map(h => `<div class="sticky-header sticky-header-h${h.level}">${escapeHtml(h.text)}</div>`)
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

/**
 * Call this when the stickyHeaders setting changes to toggle the feature.
 */
export function updateStickyHeaders(view, state) {
  // Force the plugin to re-evaluate by dispatching an empty transaction
  if (view) view.dispatch({ effects: [] });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
