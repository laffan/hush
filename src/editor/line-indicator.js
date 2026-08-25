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
            // Align the overlay's bounds with the *text* area, not the
            // cm-content's padding box. In the main editor, cm-scroller
            // carries the gutter padding and cm-content is flush, so
            // border/arrow ::before elements at negative left land in
            // the scroller's padding gap. In stack columns (and any
            // surface where cm-content owns its own inner padding) the
            // scroller is flush to the column edge, so we have to shift
            // the overlay inward by cm-content's padding to leave room
            // for the -13/-18 offsets. Without this the indicators
            // collide with the column edge and get clipped by the
            // column wrapper's overflow:hidden.
            const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
            const contentRect = this.view.contentDOM.getBoundingClientRect();
            const cs = getComputedStyle(this.view.contentDOM);
            const padLeft = parseFloat(cs.paddingLeft) || 0;
            const padRight = parseFloat(cs.paddingRight) || 0;
            return {
              indicator,
              top: coords.top - scrollerRect.top + this.view.scrollDOM.scrollTop,
              height: Math.max(1, coords.bottom - coords.top),
              left: contentRect.left - scrollerRect.left + padLeft + this.view.scrollDOM.scrollLeft,
              width: Math.max(0, contentRect.width - padLeft - padRight),
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
 *  `style-changed` / `settings-changed` so dropdown edits land live.
 *  Returns an unbind function — panes and stack columns are created and
 *  destroyed constantly, and a listener closing over a detached
 *  container keeps the whole surface alive. */
export function bindLineIndicatorToContainer(container, state) {
  if (!container) return () => {};
  const reapply = () => applyLineIndicatorClass(container, state);
  reapply();
  state.on("style-changed", reapply);
  state.on("settings-changed", reapply);
  return () => {
    state.off("style-changed", reapply);
    state.off("settings-changed", reapply);
  };
}
