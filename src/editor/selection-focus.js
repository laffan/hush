/**
 * Selection Focus — a lightweight reading overlay fired by the focus
 * shortcut when an active editor selection is non-empty.
 *
 * Sits between regular Focus mode (dim the rest of the doc, keep the
 * editor surface where it is) and Zen Focus (fullscreen, bigger font,
 * its own shadow editor): like Zen the surrounding UI fades away, the
 * selected block paints vertically + horizontally centred inside the
 * viewport, and the same shortcut exits — but the type size is the
 * editor's, not a Zen-scale upsize, and the overlay is a static
 * read-only render of the selection rather than a fresh CodeMirror.
 *
 * Entry / exit ride `state.selectionFocus` + the matching
 * `selection-focus-changed` event so the command handler stays
 * symmetrical with the existing focus / zen toggles.
 */

let active = null;

export function initSelectionFocus(state) {
  state.on("selection-focus-changed", () => {
    if (state.selectionFocus) enterSelectionFocus(state);
    else exitSelectionFocus(state);
  });
}

function enterSelectionFocus(state) {
  if (active) return;
  const payload = state._selectionFocusPayload;
  if (!payload || !payload.text) {
    // Nothing to render — back out so the state flag doesn't pin a
    // mode the user can never see.
    state.selectionFocus = false;
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "selection-focus-overlay";

  const text = document.createElement("div");
  text.className = "selection-focus-text";
  text.textContent = payload.text;
  if (payload.fontSize) text.style.fontSize = payload.fontSize;
  if (payload.fontFamily) text.style.fontFamily = payload.fontFamily;
  if (payload.color) text.style.color = payload.color;
  if (payload.lineHeight) text.style.lineHeight = payload.lineHeight;
  overlay.appendChild(text);

  const onKeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      state.toggleSelectionFocus();
    }
  };
  document.addEventListener("keydown", onKeydown, true);

  document.body.classList.add("selection-focus-active");
  document.body.appendChild(overlay);

  active = { overlay, onKeydown };
}

function exitSelectionFocus(state) {
  if (!active) return;
  const a = active;
  active = null;
  document.removeEventListener("keydown", a.onKeydown, true);
  a.overlay.remove();
  document.body.classList.remove("selection-focus-active");
  // Drop the staged payload so a stale read can't surface on the
  // next entry — the next toggle hands in a fresh capture.
  state._selectionFocusPayload = null;
}
