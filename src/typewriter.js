/**
 * Typewriter Mode — boundary line, scroll-locking, and ratchet centering.
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

  // Initial scroll
  requestAnimationFrame(() => scrollCursorToTypewriterLine(view, state));
}

export function applyTypewriterPadding(view, state) {
  const targetY = state.typewriterPosition * window.innerHeight;
  view.scrollDOM.style.paddingTop = targetY + "px";
  view.scrollDOM.style.paddingBottom = (window.innerHeight - targetY) + "px";
}

export function removeTypewriterBoundary(view, state) {
  if (typewriterBoundary) {
    typewriterBoundary.remove();
    typewriterBoundary = null;
  }
  if (view && !(state && state.ratchetMode)) {
    view.scrollDOM.style.paddingTop = "";
    view.scrollDOM.style.paddingBottom = "";
  }
}

export function scrollCursorToTypewriterLine(view, state) {
  if (!state.typewriterMode && !state.ratchetMode) return;
  const head = view.state.selection.main.head;
  const coords = view.coordsAtPos(head);
  if (!coords) return;
  const position = state.ratchetMode ? 0.5 : state.typewriterPosition;
  const targetY = position * window.innerHeight;
  const offset = coords.bottom - targetY;
  if (Math.abs(offset) > 1) {
    view.scrollDOM.scrollTop += offset;
  }
}

export function applyRatchetTypewriterPadding(view) {
  const targetY = 0.5 * window.innerHeight;
  view.scrollDOM.style.paddingTop = targetY + "px";
  view.scrollDOM.style.paddingBottom = (window.innerHeight - targetY) + "px";
}
