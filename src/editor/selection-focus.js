/**
 * Selection Focus — a focused-reading-and-editing overlay fired by the
 * Focus shortcut when an active editor selection is non-empty.
 *
 * Sits between regular Focus mode (dim the rest of the doc, keep the
 * editor surface where it is) and Zen Focus (fullscreen, bigger font,
 * whole-doc shadow editor): like Zen, the overlay paints over every
 * other piece of chrome, mounts a fresh CodeMirror seeded with the
 * captured text, and supports the user's full editing surface (all
 * cursor types, all base-extension plugins). Unlike Zen, the editor
 * only carries the selected range (not the whole doc), so the user's
 * eye lands on exactly that block; type is the source's own size
 * bumped 10 %, and the column width tracks the source view's width
 * so the line measure the user dialled in is preserved.
 *
 * On exit, the (possibly edited) content writes back over the
 * original selection range in the source view as a single transaction
 * — so undo history stays sensible.
 */

import { EditorView } from "@codemirror/view";
import { EditorState, EditorSelection } from "@codemirror/state";
import { createBaseExtensions } from "./base-extensions.js";
import { applyBlockCursor } from "./block-cursor.js";

let active = null;

const FONT_SIZE_BUMP = 1.1;

export function initSelectionFocus(state) {
  state.on("selection-focus-changed", () => {
    if (state.selectionFocus) enterSelectionFocus(state);
    else exitSelectionFocus(state);
  });
}

function enterSelectionFocus(state) {
  if (active) return;
  const payload = state._selectionFocusPayload;
  if (!payload || !payload.text || !payload.sourceView) {
    // Nothing to focus on — back the flag out so the next shortcut
    // press starts fresh.
    state.selectionFocus = false;
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "selection-focus-overlay";

  const stage = document.createElement("div");
  stage.className = "selection-focus-stage";
  // Match the source view's column width so the line measure the user
  // dialled in carries over to the focused view.
  if (payload.columnWidth) stage.style.width = `${payload.columnWidth}px`;
  overlay.appendChild(stage);

  // Bumped font size — the source's own size scaled by FONT_SIZE_BUMP
  // so the focused text reads slightly larger without jumping to Zen's
  // upsized scale.
  if (payload.fontSizePx) {
    overlay.style.setProperty("--selection-focus-font-size", `${payload.fontSizePx * FONT_SIZE_BUMP}px`);
  }

  document.body.classList.add("selection-focus-active");
  document.body.appendChild(overlay);
  applyBlockCursor(state);

  // Build a fresh CodeMirror seeded with the captured selection. The
  // base extensions cover markdown, callouts, links, formatting, image
  // refs, etc., so the focused editor behaves identically to a pane
  // editor on the same content. The selection starts at the head end
  // of the captured range so the cursor lands at the end of the block.
  const { extensions } = createBaseExtensions(state, () => { /* no per-keystroke sync */ });
  const len = payload.text.length;
  const editorState = EditorState.create({
    doc: payload.text,
    selection: EditorSelection.range(len, len),
    extensions,
  });
  const view = new EditorView({ state: editorState, parent: stage });

  // Mirror the active style's text-colour override so the focused
  // editor matches the surrounding chrome — see the matching note in
  // zen-focus.js for the same trick.
  const styleFg = getComputedStyle(document.documentElement)
    .getPropertyValue("--style-fg").trim();
  if (styleFg) view.dom.style.color = styleFg;

  const onKeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      state.toggleSelectionFocus();
    }
  };
  document.addEventListener("keydown", onKeydown, true);

  view.focus();

  active = {
    overlay,
    view,
    onKeydown,
    sourceView: payload.sourceView,
    from: payload.from,
    to: payload.to,
  };
}

function exitSelectionFocus(state) {
  if (!active) return;
  const a = active;
  active = null;

  // Snapshot the (possibly edited) content + selection before tearing
  // down the focused editor.
  const finalContent = a.view.state.doc.toString();
  const finalSel = a.view.state.selection.main;

  document.removeEventListener("keydown", a.onKeydown, true);
  a.view.destroy();
  a.overlay.remove();
  document.body.classList.remove("selection-focus-active");
  state._selectionFocusPayload = null;

  // Write the edited block back over the original selection range as
  // a single transaction so undo collapses Selection-Focus edits to
  // one step from the source view's perspective. If the source view
  // was destroyed while we were focused (rare — closing a pane that
  // hosted the source), the dispatch throws and we just bail.
  try {
    const src = a.sourceView;
    if (!src || !src.state) return;
    const docLen = src.state.doc.length;
    const from = Math.max(0, Math.min(a.from, docLen));
    const to   = Math.max(from, Math.min(a.to, docLen));
    const newTo = from + finalContent.length;
    const cursorAnchor = from + Math.min(finalSel.anchor, finalContent.length);
    const cursorHead   = from + Math.min(finalSel.head,   finalContent.length);
    src.dispatch({
      changes: { from, to, insert: finalContent },
      selection: EditorSelection.range(cursorAnchor, cursorHead),
    });
    // Move the source's viewport so the (now-edited) block lands back
    // in view — without this the user's eye lands wherever the source
    // had scrolled to before the overlay opened.
    src.dispatch({ effects: EditorView.scrollIntoView(newTo, { y: "center" }) });
    src.focus();
  } catch (_) { /* source went away mid-focus */ }
}
