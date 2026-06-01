/**
 * Typewriter Mode — boundary line and scroll-locking.
 */

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
  // Defensive: re-apply our padding before measuring. Other layout
  // passes (column reflow, sidebar toggles) periodically wipe the
  // scroller's inline padding back to the CSS defaults; without enough
  // top + bottom pad the scrollTop we want is clamped to the stale
  // max and the cursor never reaches the boundary on short docs.
  applyTypewriterPadding(view, state);

  // Force a synchronous layout flush so scrollHeight reflects the
  // freshly-typed content. Short-doc typing crosses the boundary on
  // almost every keystroke, and without this the browser clamps
  // scrollTop to the previous frame's max scroll range.
  void view.scrollDOM.offsetHeight;

  const head = view.state.selection.main.head;
  const coords = view.coordsAtPos(head);
  if (!coords) return;
  const targetY = state.typewriterPosition * window.innerHeight;
  const desired = view.scrollDOM.scrollTop + (coords.bottom - targetY);
  // Clamp ourselves rather than relying on the browser — webkit has
  // been seen to clamp against a stale scrollHeight in the same tick
  // as a layout-affecting style change.
  const maxScroll = Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight);
  const clamped = Math.max(0, Math.min(maxScroll, desired));
  if (Math.abs(clamped - view.scrollDOM.scrollTop) > 0.5) {
    view.scrollDOM.scrollTop = clamped;
  }
}

/** Reposition the boundary line after a viewport change (resize, fullscreen). */
export function repositionTypewriterBoundary(state) {
  if (!typewriterBoundary) return;
  typewriterBoundary.style.top = state.typewriterPosition * window.innerHeight + "px";
}
