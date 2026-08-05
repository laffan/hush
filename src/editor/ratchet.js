/**
 * Ratchet enforcement — shared by the two forward-only writing modes.
 *
 *   - **Timed Ratchet** (`state.ratchetMode`) — a session with an end
 *     time, started from the palette's duration grid. Deletion,
 *     selection, the mouse, and every navigation key are dead until the
 *     clock runs out.
 *   - **Desk Ratchet** (`desksMeta[deskId].ratchet`) — the same premise
 *     with no end time: every Doc in the desk is forward-only until the
 *     user turns it off, across sessions. Notebooks are a canvas, not a
 *     CodeMirror surface, so they never see any of this.
 *
 * Because the desk variant has no end time it relaxes two things the
 * timed session doesn't:
 *
 *   1. **Line 1 stays editable.** A doc's name follows its first line
 *      (see `state/state-naming.js`), so locking line 1 would mean a
 *      typo in the title is permanent.
 *   2. **Text can be selected** — but the only thing a selection is
 *      good for is the strikethrough shortcut, which annotates its
 *      dispatch with `bypassRatchet` (see `editor/formatting.js`).
 *      Every other key collapses the selection back to the end of the
 *      document, where writing continues.
 *
 * The lock point is per-surface state (`anchorField`): the position the
 * ratchet started from, mapped through every subsequent change. Edits
 * at or after it are the user writing forward; edits before it are the
 * ones this module exists to refuse.
 */

import { EditorState, StateField, StateEffect, Annotation, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { programmaticChange } from "./base-extensions.js";
import { typewriterRunwayAnnotation } from "./plugins/typewriter.js";
import { getDeskRatchet } from "../state/state-desks.js";

/** Marks a dispatch as exempt from the ratchet filter. Used by content
 *  loads and by the strikethrough toggle (the one edit a ratcheted
 *  selection is allowed to make). */
export const bypassRatchet = Annotation.define();

/** Move a surface's lock point. Value is a document position. */
export const ratchetAnchorEffect = StateEffect.define();

/** Dispatch helper for {@link ratchetAnchorEffect}. */
export function setRatchetAnchor(view, pos) {
  view.dispatch({ effects: ratchetAnchorEffect.of(pos) });
}

/** The timed session — a Ratchet with a countdown. */
export function timedRatchetActive(state) {
  return !!state?.ratchetMode;
}

/** The active desk's persistent Ratchet setting. */
export function deskRatchetActive(state) {
  return getDeskRatchet(state);
}

/** Desk Ratchet running on its own. A timed session layered on top wins:
 *  its stricter rules (no selection, no first-line exception) apply for
 *  the length of the session. */
export function deskOnlyRatchet(state) {
  return !timedRatchetActive(state) && deskRatchetActive(state);
}

/** Either mode — the editor is forward-only. */
export function ratchetLockActive(state) {
  return timedRatchetActive(state) || deskRatchetActive(state);
}

/** Park the cursor at the end of the document (where writing
 *  continues). Returns true when it had to move. */
function collapseToEnd(view) {
  const end = view.state.doc.length;
  const sel = view.state.selection.main;
  if (sel.anchor === end && sel.head === end) return false;
  view.dispatch({ selection: { anchor: end }, scrollIntoView: true });
  return true;
}

/** Drop a live selection under a desk ratchet — "I'm done with that
 *  selection", fired by any key that isn't the strikethrough shortcut. */
function dropSelection(view, state) {
  if (!deskOnlyRatchet(state)) return false;
  if (view.state.selection.main.empty) return false;
  return collapseToEnd(view);
}

/**
 * Put a stray cursor back where writing continues. Selections are left
 * alone (they're the strikethrough handle) and so is a cursor sitting on
 * line 1 (the title stays editable). Called after a click / drag in the
 * editor, never on every selection change — programmatic jumps (outline
 * clicks, find matches, YOU ARE HERE) have to survive.
 */
export function enforceRatchetSelection(view, state) {
  if (!deskOnlyRatchet(state)) return false;
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  if (view.state.doc.lineAt(sel.head).number === 1) return false;
  return collapseToEnd(view);
}

// Navigation / undo / cut keys — dead in both modes.
const BLOCKED_KEYS = ("Delete ArrowLeft ArrowRight ArrowUp ArrowDown Home End PageUp PageDown "
  + "Mod-ArrowLeft Mod-ArrowRight Mod-ArrowUp Mod-ArrowDown Mod-a Mod-z Mod-Shift-z Mod-x").split(" ");

// Selection keys — dead during a timed session, live under a desk
// ratchet so the user can reach the strikethrough shortcut.
const SELECTION_KEYS = ("Shift-ArrowLeft Shift-ArrowRight Shift-ArrowUp Shift-ArrowDown Shift-Home "
  + "Shift-End Mod-Shift-ArrowLeft Mod-Shift-ArrowRight Mod-Shift-ArrowUp Mod-Shift-ArrowDown").split(" ");

/**
 * Build the ratchet extension set for one editing surface.
 *
 * `enforceSelection` adds the pointer handling (mouse blocked outright
 * during a timed session; a click under a desk ratchet returns the
 * cursor to the end) — the main editor opts in, reference surfaces
 * (panes, stack columns, Zen) take the keymap + filter only so a
 * programmatic jump can still move their cursor.
 */
export function createRatchetExtensions(state, { enforceSelection = false } = {}) {
  const anchorField = StateField.define({
    create: (editorState) => editorState.doc.length,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(ratchetAnchorEffect)) return e.value;
      if (!tr.docChanged) return value;
      // A programmatic content swap (file load, pane mirror, sync pull)
      // is committed text arriving whole — re-lock behind its new end.
      // A timed session owns its anchor (captured from the cursor when
      // the session started), so it opts out of the re-lock.
      if (tr.annotation(programmaticChange) && !timedRatchetActive(state)) return tr.newDoc.length;
      return tr.changes.mapPos(value, -1);
    },
  });

  const filter = EditorState.transactionFilter.of((tr) => {
    if (!ratchetLockActive(state)) return tr;
    if (tr.annotation(bypassRatchet) || tr.annotation(programmaticChange)) return tr;
    // The typewriter runway is app-internal padding at the end of the
    // buffer, not text the user wrote — it has to be free to grow and
    // be stripped while the ratchet is on.
    if (tr.annotation(typewriterRunwayAnnotation)) return tr;
    if (!tr.docChanged) return tr;
    const startDoc = tr.startState.doc;
    // Clamped: a filter that throws would take the whole editor with it,
    // and an out-of-range anchor is one bad `setRatchetAnchor` away.
    const anchor = Math.min(Math.max(0, tr.startState.field(anchorField, false) ?? 0), startDoc.length);
    // The in-progress word: the user can backspace inside the word
    // they're typing, never into committed text. Scanning only back to
    // the anchor matters — a global search lands past the cursor in a
    // mid-document session and locks the user out entirely.
    const cursor = tr.startState.selection.main.head;
    const chunk = startDoc.sliceString(anchor, Math.max(anchor, cursor));
    let wordStart = anchor;
    for (let i = chunk.length - 1; i >= 0; i--) {
      const c = chunk.charCodeAt(i);
      if (c === 32 /* space */ || c === 10 /* \n */) { wordStart = anchor + i + 1; break; }
    }
    const lockPoint = Math.max(anchor, wordStart);
    // Desk ratchet keeps line 1 open — it's the filename until the user
    // moves off it. `-1` disables the exception during a timed session.
    const titleEnd = deskOnlyRatchet(state) ? startDoc.line(1).to : -1;

    let reject = false;
    tr.changes.iterChanges((fromA, toA) => {
      if (fromA >= lockPoint) return;   // writing forward
      if (toA <= titleEnd) return;      // editing the title
      reject = true;
    });
    return reject ? [] : tr;
  });

  const blockedEntry = (key, isActive) => ({
    key,
    run: (view) => {
      if (!isActive(state)) return false;
      dropSelection(view, state);
      return true;
    },
  });

  const keys = Prec.highest(keymap.of([
    ...BLOCKED_KEYS.map((k) => blockedEntry(k, ratchetLockActive)),
    ...SELECTION_KEYS.map((k) => blockedEntry(k, timedRatchetActive)),
    // Only claims Escape when there's a ratcheted selection to drop, so
    // every other Escape handler (find bar, panels) still sees it.
    { key: "Escape", run: (view) => dropSelection(view, state) },
  ]));

  if (!enforceSelection) return [anchorField, filter, keys];

  const pointer = EditorView.domEventHandlers({
    mousedown: (_e, view) => {
      if (timedRatchetActive(state)) return true;     // the mouse is dead for the session
      if (!deskOnlyRatchet(state)) return false;
      // Wait for the release: collapsing mid-drag would fight the
      // selection the user is dragging out.
      const onUp = () => {
        window.removeEventListener("mouseup", onUp, true);
        setTimeout(() => enforceRatchetSelection(view, state), 0);
      };
      window.addEventListener("mouseup", onUp, true);
      return false;
    },
    keydown: (e, view) => {
      if (!deskOnlyRatchet(state)) return false;
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return false;
      if (e.key.length !== 1) return false;
      // A plain character after a strikethrough: drop the selection so
      // the keystroke lands at the end instead of being refused.
      dropSelection(view, state);
      return false;
    },
  });

  return [anchorField, filter, keys, pointer];
}
