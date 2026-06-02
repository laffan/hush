/**
 * Typewriter Mode — boundary line and scroll-locking.
 *
 * On short docs the scroll lock can't slide the cursor up to the boundary
 * because there simply isn't enough content below to scroll. The fix is to
 * append blank lines at the end of the document while typewriter mode is
 * active — same effect as the user pressing Enter a bunch of times — and
 * remove them when the mode turns off. The runway is invisible to autosave
 * (annotated dispatches bypass dirty tracking) and to getContent (which
 * trims our trailing newlines while the mode is on), so the persisted file
 * never carries the padding lines.
 */

import { Annotation } from "@codemirror/state";

export const typewriterRunwayAnnotation = Annotation.define();

let typewriterBoundary = null;

export function getTypewriterBoundary() {
  return typewriterBoundary;
}

export function setupTypewriterBoundary(view, state) {
  if (typewriterBoundary) return;

  typewriterBoundary = document.createElement("div");
  typewriterBoundary.className = "typewriter-boundary visible";
  typewriterBoundary.style.opacity = state.settings.typewriterLineOpacity ?? 0.08;
  document.body.appendChild(typewriterBoundary);
  typewriterBoundary.style.top = state.typewriterPosition * window.innerHeight + "px";

  applyTypewriterPadding(view, state);
  ensureTypewriterRunway(view, state);

  // Drag to reposition (mouse)
  typewriterBoundary.addEventListener("mousedown", (e) => {
    e.preventDefault();
    typewriterBoundary.classList.add("dragging");

    function onMove(e2) {
      const newY = Math.max(50, Math.min(window.innerHeight - 50, e2.clientY));
      typewriterBoundary.style.top = newY + "px";
      state.typewriterPosition = newY / window.innerHeight;
      applyTypewriterPadding(view, state);
      scrollCursorToTypewriterLine(view, state);
    }

    function onUp() {
      typewriterBoundary.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // Drag to reposition (touch — iPad/iOS)
  typewriterBoundary.addEventListener("touchstart", (e) => {
    e.preventDefault();
    typewriterBoundary.classList.add("dragging");

    function onTouchMove(e2) {
      const touch = e2.touches[0];
      const newY = Math.max(50, Math.min(window.innerHeight - 50, touch.clientY));
      typewriterBoundary.style.top = newY + "px";
      state.typewriterPosition = newY / window.innerHeight;
      applyTypewriterPadding(view, state);
      scrollCursorToTypewriterLine(view, state);
    }

    function onTouchEnd() {
      typewriterBoundary.classList.remove("dragging");
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
    }

    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd);
  }, { passive: false });

  // Initial scroll — use escalating delays for iPad where layout may not
  // be settled when typewriter mode is first enabled.
  scrollCursorToTypewriterLine(view, state);
  requestAnimationFrame(() => scrollCursorToTypewriterLine(view, state));
  setTimeout(() => scrollCursorToTypewriterLine(view, state), 100);
  setTimeout(() => scrollCursorToTypewriterLine(view, state), 300);
}

export function applyTypewriterPadding(view, state) {
  const targetY = state.typewriterPosition * window.innerHeight;
  // On iPad, safe-area insets (padding on html.ios) reduce the editor's
  // actual visible height below window.innerHeight. We must add extra
  // bottom padding so the very last line can still scroll up to the boundary.
  const htmlEl = document.documentElement;
  const safeAreaExtra = (parseInt(getComputedStyle(htmlEl).paddingTop) || 0)
                      + (parseInt(getComputedStyle(htmlEl).paddingBottom) || 0);
  view.scrollDOM.style.paddingTop = targetY + "px";
  view.scrollDOM.style.paddingBottom = (window.innerHeight - targetY + safeAreaExtra) + "px";
}

/**
 * Add or top-up blank lines at the end of the document so it always
 * has enough real content for the scroll lock to keep the cursor at
 * the typewriter line. This is what the user would otherwise do by
 * pressing Enter a bunch of times — we do it for them, and tag the
 * dispatch with `typewriterRunwayAnnotation` so the rest of the app
 * (dirty tracking, autosave, sync) can ignore it.
 *
 * Idempotent: every call brings the trailing-newline count up to a
 * viewport's worth (plus a small buffer). If the user types real
 * content into the runway the trailing count drops and the next call
 * tops it back up.
 */
export function ensureTypewriterRunway(view, state) {
  if (!state.typewriterMode) return;
  const lhStr = getComputedStyle(view.contentDOM).lineHeight;
  const lh = parseFloat(lhStr) || 24;
  const desired = Math.ceil(window.innerHeight / lh) + 3;
  const doc = view.state.doc;
  const text = doc.toString();
  const trailing = (text.match(/\n*$/) || [""])[0].length;
  if (trailing >= desired) return;
  const toAdd = desired - trailing;
  view.dispatch({
    changes: { from: doc.length, insert: "\n".repeat(toAdd) },
    annotations: [typewriterRunwayAnnotation.of(true)],
  });
}

/**
 * Strip every trailing newline / whitespace character from the doc.
 * Called when typewriter mode is turned off so the document returns
 * to its pre-runway shape. Also used to clean up the doc text before
 * it leaves the editor (getContent / save).
 */
export function stripTypewriterRunway(view) {
  const text = view.state.doc.toString();
  const stripped = text.replace(/[\s]+$/u, "");
  if (stripped.length === text.length) return;
  view.dispatch({
    changes: { from: stripped.length, to: text.length, insert: "" },
    annotations: [typewriterRunwayAnnotation.of(true)],
  });
}

/**
 * Return the doc text with our runway lines stripped — used by
 * getContent while typewriter is on so autosave never persists the
 * padding lines.
 */
export function stripTypewriterRunwayText(text) {
  return text.replace(/[\s]+$/u, "");
}

export function removeTypewriterBoundary(view, state) {
  if (typewriterBoundary) {
    typewriterBoundary.remove();
    typewriterBoundary = null;
  }
  if (view) {
    view.scrollDOM.style.paddingTop = "";
    view.scrollDOM.style.paddingBottom = "";
  }
}

export function scrollCursorToTypewriterLine(view, state) {
  if (!state.typewriterMode) return;
  const head = view.state.selection.main.head;
  const coords = view.coordsAtPos(head);
  if (!coords) return;
  const targetY = state.typewriterPosition * window.innerHeight;
  const offset = coords.bottom - targetY;
  if (Math.abs(offset) > 1) {
    view.scrollDOM.scrollTop += offset;
  }
}

/** Reposition the boundary line after a viewport change (resize, fullscreen). */
export function repositionTypewriterBoundary(state) {
  if (!typewriterBoundary) return;
  typewriterBoundary.style.top = state.typewriterPosition * window.innerHeight + "px";
}
