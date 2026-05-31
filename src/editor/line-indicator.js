/**
 * Line Indicator — paints the active style's "highlight the current
 * line" affordance (left arrow / double arrow / left border / border /
 * highlight) on the *visual* line carrying the cursor.
 *
 * Each editor (main view, every pane, every stack column) gets its own
 * overlay element inside `view.scrollDOM`. The overlay is positioned
 * by `view.coordsAtPos(head)` so it lines up with the wrapped visual
 * line rather than the whole document line block. The overlay is
 * suppressed unless the editor currently holds focus, so a stack with
 * three docs only paints the indicator on the one you're typing in.
 *
 * The container (editor / pane / preview wrapper) still carries a
 * `line-ind-<variant>` class — CSS targets `.line-ind-X
 * .hush-line-ind` to pick the variant skin.
 */
import { ViewPlugin } from "@codemirror/view";

const VARIANTS = ["left-arrow", "double-arrow", "left-border", "border", "highlight"];

function resolveLineIndicator(state) {
  const styleId = state.settings.activeStyleId;
  if (!styleId) {
    const v = state.settings.lineIndicator;
    return v && v !== "none" ? v : null;
  }
  const style = (state.settings.styles || []).find(s => s.id === styleId);
  if (!style) return null;
  const v = style.lineIndicator;
  return v && v !== "none" ? v : null;
}

/** Build the overlay-driving ViewPlugin. Reads the active style from
 *  the shared `state` reference and the focus state from the view. */
export function createLineIndicatorPlugin(state) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.overlay = document.createElement("div");
        this.overlay.className = "hush-line-ind";
        this.overlay.style.position = "absolute";
        this.overlay.style.pointerEvents = "none";
        this.overlay.style.display = "none";
        // Insert before cm-content so the highlight wash sits beneath
        // the text rather than tinting it from on top.
        view.scrollDOM.insertBefore(this.overlay, view.scrollDOM.firstChild);

        this.onFocusBlur = () => this.schedule();
        view.dom.addEventListener("focusin", this.onFocusBlur);
        view.dom.addEventListener("focusout", this.onFocusBlur);
        // Style toggles from outside the editor (the style modal, the
        // command palette) don't generate CM transactions on their own,
        // so listen for the same events the container class binding does
        // and remeasure when they fire.
        this.onStateChange = () => this.schedule();
        state.on("style-changed", this.onStateChange);
        state.on("settings-changed", this.onStateChange);

        this.schedule();
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
          key: "hushLineIndicator",
          read: () => {
            const indicator = resolveLineIndicator(state);
            if (!indicator || !this.view.hasFocus) return null;
            const head = this.view.state.selection.main.head;
            const coords = this.view.coordsAtPos(head);
            if (!coords) return null;
            // Align the overlay's bounds with the cm-content text area
            // rather than the cm-scroller padding box. Absolute children
            // of scrollDOM otherwise position from the scroller's
            // padding edge (border-inside), so a default left:0 lands
            // at the editor's outer edge — leaving arrow ::before
            // elements at negative left clipped by the scroller's
            // overflow.
            const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
            const contentRect = this.view.contentDOM.getBoundingClientRect();
            return {
              indicator,
              top: coords.top - scrollerRect.top + this.view.scrollDOM.scrollTop,
              height: Math.max(1, coords.bottom - coords.top),
              left: contentRect.left - scrollerRect.left + this.view.scrollDOM.scrollLeft,
              width: contentRect.width,
            };
          },
          write: (data) => {
            if (!data) {
              this.overlay.style.display = "none";
              return;
            }
            for (const v of VARIANTS) this.overlay.classList.remove("hush-line-ind-" + v);
            this.overlay.classList.add("hush-line-ind-" + data.indicator);
            this.overlay.style.display = "block";
            this.overlay.style.top = data.top + "px";
            this.overlay.style.left = data.left + "px";
            this.overlay.style.width = data.width + "px";
            this.overlay.style.height = data.height + "px";
          },
        });
      }

      destroy() {
        this.overlay.remove();
        this.view.dom.removeEventListener("focusin", this.onFocusBlur);
        this.view.dom.removeEventListener("focusout", this.onFocusBlur);
        state.off("style-changed", this.onStateChange);
        state.off("settings-changed", this.onStateChange);
      }
    }
  );
}

/** Toggle the `line-ind-<variant>` class on the given container so the
 *  CSS variant rules light up the overlay. */
export function applyLineIndicatorClass(container, state) {
  if (!container) return;
  const indicator = resolveLineIndicator(state);
  for (const v of VARIANTS) container.classList.toggle("line-ind-" + v, indicator === v);
}

/** Wire a container to re-apply the indicator class on every
 *  `style-changed` / `settings-changed` so dropdown edits land live. */
export function bindLineIndicatorToContainer(container, state) {
  applyLineIndicatorClass(container, state);
  state.on("style-changed", () => applyLineIndicatorClass(container, state));
  state.on("settings-changed", () => applyLineIndicatorClass(container, state));
}
