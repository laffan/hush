/**
 * Caret position tracking for background-layer caret effects.
 *
 * Publishes the main editor's caret position in *viewport* coordinates
 * (layer renderers convert to their own canvas space). Sampling is
 * event-driven — `selectionchange`, any scroll (capture phase, so the
 * editor's scroller is covered without holding a reference to it), and
 * window resize — and rAF-coalesced so a burst of events costs one
 * `coordsAtPos` read per frame.
 *
 * The source is a singleton: layer instances share one tracker, and the
 * tracker only lives while at least one consumer holds it (retain /
 * release counting) so styles without caret effects never pay for the
 * listeners.
 */

let _tracker = null;

export function acquireCaretSource(getView) {
  if (_tracker) { _tracker.refs += 1; return _tracker.source; }

  const pos = { x: 0, y: 0, h: 22, t: 0, valid: false };
  let rafId = 0;

  function sample() {
    rafId = 0;
    const view = getView?.();
    if (!view) { pos.valid = false; return; }
    try {
      const head = view.state.selection.main.head;
      // coordsAtPos returns null for offsets outside the rendered
      // viewport — keep the previous position rather than jumping.
      const c = view.coordsAtPos(head);
      if (!c) return;
      pos.x = c.left;
      pos.y = (c.top + c.bottom) / 2;
      // Caret height feeds the line-anchored presets (underline glow's
      // baseline offset, the flicker bar's band).
      pos.h = Math.max(c.bottom - c.top, 8);
      pos.t = performance.now();
      pos.valid = true;
    } catch (_) { /* mid-update reads can throw; skip the sample */ }
  }

  const schedule = () => { if (!rafId) rafId = requestAnimationFrame(sample); };

  document.addEventListener("selectionchange", schedule);
  document.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  schedule();

  const source = {
    /** Latest caret sample: `{ x, y, h, t, valid }` in viewport px. */
    get: () => pos,
  };

  _tracker = {
    refs: 1,
    source,
    dispose() {
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      if (rafId) cancelAnimationFrame(rafId);
    },
  };
  return source;
}

export function releaseCaretSource() {
  if (!_tracker) return;
  _tracker.refs -= 1;
  if (_tracker.refs <= 0) {
    _tracker.dispose();
    _tracker = null;
  }
}
