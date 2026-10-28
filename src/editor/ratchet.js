/**
 * Ratchet enforcement — shared by the two forward-only writing modes.
 *
 *   - **Timed Ratchet** (`state.ratchetMode`) — a session with an end
 *     time, started from the palette's duration grid. Deletion,
 *     selection, the mouse, and every navigation key are dead until the
 *     clock runs out. Its **Untimed** entry is the same session with no
 *     end time (`ratchetEndTime` null), which runs until the End Ratchet
 *     Mode button in the countdown's slot is pressed.
 *   - **Desk Ratchet** (`desksMeta[deskId].ratchet`) — the same premise
 *     with no end time: every Doc in the desk is forward-only until the
 *     user turns it off, across sessions. Notebooks are a canvas, not a
 *     CodeMirror surface, so they never see any of this.
 *
 * Because the desk variant has no end time it relaxes four things the
 * timed session doesn't:
 *
 *   1. **Line 1 stays editable.** A doc's name follows its first line
 *      (see `state/state-naming.js`), so locking line 1 would mean a
 *      typo in the title is permanent.
 *   2. **Text can be selected** — but the only thing a selection is
 *      good for is the strikethrough shortcut, which annotates its
 *      dispatch with `bypassRatchet` (see `editor/formatting.js`).
 *      Every other key collapses the selection to its end, where
 *      writing continues.
 *   3. **Committed text can be rearranged.** The rule the mode actually
 *      enforces is *your words don't change* — not *nothing moves*. A
 *      transaction that puts the same material back in a different
 *      order is a move, and moves are allowed: the sentence-shift
 *      shortcuts, a Shuffle Editor reorder, a Selection Focus reorder.
 *      Add a word or drop one and the same check refuses it.
 *   4. **Writing can start anywhere.** A click (or any caret placement
 *      that isn't typing — a find match, an outline jump) moves the lock
 *      to the caret, and the user writes from there. What was already
 *      on either side of it stays committed: no deleting, and the arrow
 *      keys stay dead, as in a timed session.
 *
 * The lock is per-surface state (`anchorField`): `from`, the position
 * writing started at, and `to`, the end of what has been written since —
 * mapped through every change, `to` growing with what is typed at it.
 * Edits inside that stretch are the user writing; edits outside it, on
 * committed text before or after, are the ones this module exists to
 * refuse — visibly, via a brief notice, so an operation that can't land
 * never just evaporates.
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

/**
 * The material in a stretch of text: every character that isn't
 * whitespace or a strike / comment marker, sorted. Two stretches with
 * the same material hold the same words — in some order, wrapped or
 * spaced differently, but with nothing added and nothing lost.
 *
 * Whitespace is excluded because every rearranging tool renormalises it
 * (the Shuffle Editor rejoins sentences with a single space); `~` and
 * `%` because striking a sentence through or commenting it out keeps
 * its words in the file, which is the point.
 */
function material(text) {
  return [...text.replace(/[\s~%]+/g, "")].sort().join("");
}

/**
 * True when a transaction only moves material around: everything it
 * removes turns up again in what it inserts. Measured across the whole
 * transaction, since a move is a delete here plus an insert there.
 *
 * Empty material means the edit is pure whitespace or bare markers —
 * an insertion of nothing rather than a rearrangement of something, so
 * it doesn't earn the exemption (otherwise a stray space could be typed
 * into the middle of a committed word).
 */
function isRearrangement(tr) {
  let removed = "";
  let inserted = "";
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, insert) => {
    removed += tr.startState.doc.sliceString(fromA, toA);
    inserted += insert.toString();
  });
  const before = material(removed);
  return before.length > 0 && before === material(inserted);
}

// A refused edit under a desk ratchet flashes the desk's Ratchet mark —
// the ring round the glyph after the desk's name, or the disc on its
// icon — red (styles/custom-icons.css, `body.ratchet-refused`), instead
// of a notice: hammering Backspace just keeps it glowing. A timed
// session stays silent — its silence is the whole feel of it.
let flashTimer = 0;

function noticeRefusal(state) {
  if (!deskOnlyRatchet(state) || typeof document === "undefined") return;
  // Deferred: this runs inside a transaction filter.
  setTimeout(() => {
    const body = document.body;
    body.classList.remove("ratchet-refused");
    void body.offsetWidth; // restart the animation
    body.classList.add("ratchet-refused");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => body.classList.remove("ratchet-refused"), 900);
  }, 0);
}

/** Drop a live selection under a desk ratchet — "I'm done with that
 *  selection", fired by any key that isn't the strikethrough shortcut.
 *  The caret lands at the selection's end, and writing starts there. */
function dropSelection(view, state) {
  if (!deskOnlyRatchet(state)) return false;
  const sel = view.state.selection.main;
  if (sel.empty) return false;
  view.dispatch({ selection: { anchor: sel.to }, scrollIntoView: true });
  return true;
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
 * `enforceSelection` adds the pointer handling (the mouse is blocked
 * outright during a timed session) — the main editor opts in, reference
 * surfaces (panes, stack columns, Zen) take the keymap + filter only so
 * a programmatic jump can still move their cursor.
 *
 * `fragment` marks a surface holding a slice of a document rather than
 * the whole thing — the Selection Focus overlay. Two things change,
 * both because the buffer's edges aren't the document's:
 *
 *   - Its line 1 is wherever the selection happened to start, not the
 *     doc's filename line, so the title exception doesn't apply.
 *   - Its *end* is the middle of committed text, not the writing edge.
 *     Everything in a fragment is committed, so nothing can be appended
 *     — only moved around, or struck through.
 */
export function createRatchetExtensions(state, { enforceSelection = false, fragment = false } = {}) {
  const at = (pos) => ({ from: pos, to: pos });
  const anchorField = StateField.define({
    create: (editorState) => at(editorState.doc.length),
    update(value, tr) {
      for (const e of tr.effects) if (e.is(ratchetAnchorEffect)) return at(e.value);
      if (!tr.docChanged) {
        // Desk Ratchet: wherever the caret is put down — a click, a find
        // match, an outline jump — is where writing starts (the arrow
        // keys that would otherwise move it are dead). A selection is
        // the strikethrough handle, and leaves the lock where it was.
        const sel = tr.selection?.main;
        if (sel && sel.empty && deskOnlyRatchet(state)) return at(sel.head);
        return value;
      }
      // A programmatic content swap (file load, pane mirror, sync pull)
      // is committed text arriving whole — re-lock behind its new end.
      // A timed session owns its anchor (captured from the cursor when
      // the session started), so it opts out of the re-lock.
      if (tr.annotation(programmaticChange) && !timedRatchetActive(state)) return at(tr.newDoc.length);
      return { from: tr.changes.mapPos(value.from, -1), to: tr.changes.mapPos(value.to, 1) };
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
    const lock = tr.startState.field(anchorField, false) || at(0);
    const anchor = Math.min(Math.max(0, lock.from), startDoc.length);
    // The end of what has been written since — committed text follows.
    const writtenEnd = Math.min(Math.max(anchor, lock.to), startDoc.length);
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
    // A fragment has no writing edge — its end is the middle of the
    // document it was cut from — so the lock covers all of it.
    const lockPoint = fragment ? startDoc.length + 1 : Math.max(anchor, wordStart);
    // Desk ratchet keeps line 1 open — it's the filename until the user
    // moves off it. `-1` disables the exception during a timed session,
    // and on a fragment, whose first line names nothing.
    const titleEnd = deskOnlyRatchet(state) && !fragment ? startDoc.line(1).to : -1;

    let reject = false;
    tr.changes.iterChanges((fromA, toA) => {
      if (fromA >= lockPoint && (fragment || toA <= writtenEnd)) return; // writing
      if (toA <= titleEnd) return;      // editing the title
      reject = true;
    });
    if (!reject) return tr;
    // Committed text can still be reordered — the mode keeps your words,
    // not their arrangement. Anything that adds or drops material falls
    // through to the refusal.
    if (deskOnlyRatchet(state) && isRearrangement(tr)) return tr;
    noticeRefusal(state);
    return [];
  });

  const blockedEntry = (key, isActive) => ({
    key,
    run: (view) => {
      if (!isActive(state)) return false;
      dropSelection(view, state);
      return true;
    },
  });

  // A fragment is governed by the filter alone. The keymap exists to keep
  // the cursor at the writing edge, and a fragment has no writing edge —
  // blocking its arrows would just make the block unnavigable, when
  // moving around inside it is the whole reason to be there.
  if (fragment) return [anchorField, filter];

  const keys = Prec.highest(keymap.of([
    ...BLOCKED_KEYS.map((k) => blockedEntry(k, ratchetLockActive)),
    ...SELECTION_KEYS.map((k) => blockedEntry(k, timedRatchetActive)),
    // Only claims Escape when there's a ratcheted selection to drop, so
    // every other Escape handler (find bar, panels) still sees it.
    { key: "Escape", run: (view) => dropSelection(view, state) },
  ]));

  if (!enforceSelection) return [anchorField, filter, keys];

  const pointer = EditorView.domEventHandlers({
    // The mouse is dead for a timed session — except to bring the
    // keyboard back: after a sticky (or anything else) took focus, a
    // click on the document refocuses it with the caret where it was.
    // Under a desk ratchet a click puts the caret down and the lock
    // follows it (anchorField).
    mousedown: (e, view) => {
      if (!timedRatchetActive(state)) return false;
      if (!view.hasFocus) {
        e.preventDefault();
        view.focus();
      }
      return true;
    },
    keydown: (e, view) => {
      if (!deskOnlyRatchet(state)) return false;
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return false;
      if (e.key.length !== 1) return false;
      // A plain character after a strikethrough: drop the selection so
      // the keystroke lands after it instead of being refused.
      dropSelection(view, state);
      return false;
    },
  });

  return [anchorField, filter, keys, pointer];
}
