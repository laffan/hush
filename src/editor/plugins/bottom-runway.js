/**
 * Bottom runway — empty space below a document's last line, so the
 * last words can be scrolled up to the middle of whatever is showing
 * the document instead of being written at the bottom edge of it.
 *
 * Space, not text: the runway is `padding-bottom` on `.cm-content`,
 * which CodeMirror measures and counts into its height map (the same
 * mechanism as its own `scrollPastEnd()`), so nothing is added to the
 * buffer and nothing reaches the file.
 *
 * "The middle" is the middle of this surface's scroller — the window
 * for the main editor, the pane for a pane, the column for a stack
 * column — less any chrome docked over its edges (`getInsets`). The
 * amount isn't derived from a formula but measured and corrected:
 * where the last line would sit at full scroll is read off the live
 * geometry and the padding moved by the difference. That makes it
 * indifferent to which of the scroller's own paddings a given engine
 * counts as scrollable overflow (WebKit leaves a scroll container's
 * bottom padding out; Chromium counts it) — the gap the static `50vh`
 * this replaces could never close, along with not being half of a
 * pane at all.
 *
 * Typewriter mode owns the bottom of the scroll geometry wherever it is
 * on, so the runway stands aside for it: it clears only the padding it
 * wrote itself and leaves the typewriter's alone.
 */

import { ViewPlugin } from "@codemirror/view";

const TOLERANCE_PX = 2;

// view → plugin instance, for `refreshBottomRunway`.
const instances = new WeakMap();

/**
 * @param {object} [opts]
 * @param {() => boolean} [opts.isTypewriter]  typewriter mode is on for this surface
 * @param {() => {top:number,bottom:number}} [opts.getInsets]  chrome docked over the scroller's edges
 * @param {(cb: () => void) => (() => void)} [opts.watch]  extra re-measure trigger; returns an unsubscribe
 */
export function createBottomRunway(opts = {}) {
  const isTypewriter = opts.isTypewriter || (() => false);
  const getInsets = opts.getInsets || (() => ({ top: 0, bottom: 0 }));

  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.padding = null; // px this plugin last wrote, null = none
      this.measureReq = {
        key: this,
        read: (v) => this.read(v),
        write: (m, v) => this.write(m, v),
      };
      instances.set(view, this);
      this.unwatch = opts.watch ? opts.watch(() => this.schedule()) : null;
      this.schedule();
    }

    update(u) {
      if (u.docChanged || u.geometryChanged || u.heightChanged || u.viewportChanged
          || u.transactions.length) this.schedule();
    }

    schedule() {
      try { this.view.requestMeasure(this.measureReq); } catch (_) { /* destroyed */ }
    }

    read(view) {
      if (isTypewriter()) return { typewriter: true };
      const scroller = view.scrollDOM;
      const clientH = scroller.clientHeight;
      if (!clientH) return null;
      const insets = getInsets() || {};
      const top = Math.max(0, insets.top || 0);
      const bottom = Math.max(0, insets.bottom || 0);
      const visible = Math.max(0, clientH - top - bottom);
      const rect = scroller.getBoundingClientRect();
      const target = rect.top + scroller.clientTop + top + visible / 2;
      // Where the last line's middle would be with the scroller run all
      // the way down. Scrolling to the end moves the page up by however
      // far the scroller is from its end.
      const doc = view.state.doc;
      const last = view.lineBlockAt(doc.length);
      const lastMid = view.documentTop + (last.top + last.bottom) / 2;
      const toEnd = Math.max(0, scroller.scrollHeight - clientH - scroller.scrollTop);
      const atEnd = lastMid - toEnd;
      const current = this.padding ?? (parseFloat(getComputedStyle(view.contentDOM).paddingBottom) || 0);
      let next = current + (atEnd - target);
      // Below the end of the scroll range the measurement says nothing
      // (a page too short to scroll can't move at all), so never take
      // back more than the error asks for, and never go under the least
      // any engine could need: half the visible height, less a line and
      // less the scroller's own bottom padding (which some count).
      const ownPad = parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
      next = Math.max(next, visible / 2 - (last.bottom - last.top) - ownPad);
      return { padding: Math.max(0, Math.round(next)) };
    }

    write(m, view) {
      if (!m) return;
      const style = view.contentDOM.style;
      if (m.typewriter) {
        // Clear only a value that is still ours: a pane's typewriter
        // writes its own runway to the same property, and may well have
        // done so between this measure being asked for and running.
        if (this.padding != null && style.paddingBottom === this.padding + "px") style.paddingBottom = "";
        this.padding = null;
        return;
      }
      if (this.padding != null && Math.abs(m.padding - this.padding) <= TOLERANCE_PX) return;
      this.padding = m.padding;
      style.paddingBottom = m.padding + "px";
    }

    destroy() {
      instances.delete(this.view);
      if (this.unwatch) this.unwatch();
      if (this.padding != null) {
        try { this.view.contentDOM.style.paddingBottom = ""; } catch (_) {}
      }
    }
  });
}

/** Re-run the runway's measurement — for code that has just rewritten
 *  `.cm-content`'s bottom padding behind its back (a pane's typewriter
 *  turning off). */
export function refreshBottomRunway(view) {
  const inst = view && instances.get(view);
  if (!inst) return;
  inst.padding = null;
  inst.schedule();
}

/** The main editor's runway: its typewriter flag is the global one, and
 *  panes docked to the top or bottom of the window sit over its
 *  scroller, so "the middle" is the middle of what they leave. */
export function createMainEditorRunway(state) {
  return createBottomRunway({
    isTypewriter: () => !!state.typewriterMode,
    getInsets: () => ({
      top: state.runtime?.dockedTopHeight || 0,
      bottom: state.runtime?.dockedBottomHeight || 0,
    }),
    watch: (cb) => {
      state.on("mode-changed", cb);
      document.addEventListener("pane-dock-changed", cb);
      return () => {
        state.off("mode-changed", cb);
        document.removeEventListener("pane-dock-changed", cb);
      };
    },
  });
}
