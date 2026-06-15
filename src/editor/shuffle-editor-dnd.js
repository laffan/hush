/**
 * Shuffle Editor — drag-and-drop + sentence tokenizing helpers.
 *
 * Extracted from shuffle-editor.js so the lifecycle file stays under the
 * repo's 700-line cap. This module owns three concerns:
 *
 *   1. Splitting the captured selection into sentence strings.
 *   2. The in-editor sentence hover-highlight CodeMirror extension and the
 *      "drag a sentence out of the editor" gesture.
 *   3. The margin-chip drag gesture (chip → editor, chip → margin, or a
 *      plain click that drops the chip into inline edit mode).
 *
 * The lifecycle file builds a `ctrl` controller object and hands it here;
 * everything routes back through that so this module never reaches into
 * module-level overlay state.
 */

import { EditorView, Decoration } from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";
import {
  findSentenceStart, findSentenceEnd, offsetToPos, posToOffset,
} from "./sentence-core.js";

const DRAG_THRESHOLD = 5; // px of pointer travel before a press becomes a drag

/* ===== Capitalization + combining helpers ===== */

/** Capitalize the first alphabetic character of a string, leaving the
 *  rest untouched (so an all-caps acronym mid-sentence survives). */
export function capitalizeFirst(str) {
  const s = String(str || "");
  const i = s.search(/[a-z]/i);
  if (i === -1) return s;
  return s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1);
}

/** Lowercase the first alphabetic character — used when a sentence is
 *  combined onto the end of another and becomes a mid-sentence clause. */
function lowerFirst(str) {
  const s = String(str || "");
  const i = s.search(/[a-z]/i);
  if (i === -1) return s;
  return s.slice(0, i) + s[i].toLowerCase() + s.slice(i + 1);
}

/** Drop a single trailing run of concluding punctuation (and any closing
 *  quotes/markup after it) from the end of a sentence. */
function stripTrailingPunct(str) {
  return String(str || "").replace(/[.!?]+["')\]}*_`]*\s*$/, "").trimEnd();
}

/** Merge `follower` onto the end of `target`: the target's concluding
 *  punctuation is removed and the follower joins as a continuing clause. */
export function combineInto(targetText, followerText) {
  const base = stripTrailingPunct(targetText);
  return `${base} ${lowerFirst(followerText.trim())}`.trim();
}

/** CodeMirror extension that auto-capitalizes the first letter of each
 *  sentence as the user types — the doc's very first letter, and any
 *  letter typed directly after concluding punctuation + whitespace. The
 *  fix is deferred to a microtask so it never dispatches synchronously
 *  from inside the update cycle. */
export function autoCapitalizeExtension() {
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    let hit = null;
    u.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      if (inserted.length === 1) hit = { pos: fromB, ch: inserted.toString() };
    });
    if (!hit || !/[a-z]/.test(hit.ch)) return;
    if (!atSentenceStart(u.state.doc, hit.pos)) return;
    const { pos, ch } = hit;
    queueMicrotask(() => {
      try {
        if (u.view.state.doc.sliceString(pos, pos + 1) !== ch) return;
        u.view.dispatch({ changes: { from: pos, to: pos + 1, insert: ch.toUpperCase() } });
      } catch (_) { /* view gone */ }
    });
  });
}

/** True when `pos` begins a sentence: doc start, or preceded by
 *  whitespace whose nearest non-space neighbour is concluding punctuation. */
function atSentenceStart(doc, pos) {
  if (pos === 0) return true;
  let j = pos - 1;
  let sawSpace = false;
  while (j >= 0 && /\s/.test(doc.sliceString(j, j + 1))) { sawSpace = true; j--; }
  if (j < 0) return true; // only whitespace before the cursor
  if (!sawSpace) return false; // letter butts straight against prior text
  return /[.!?]/.test(doc.sliceString(j, j + 1));
}

/* ===== Sentence tokenizing ===== */

/** Split prose into sentence strings. Mirrors the boundary rules in
 *  sentence-core.js (a `.!?` followed by optional closing quotes/markup
 *  then whitespace or end-of-line) but operates on a raw string so it can
 *  run over the captured selection before any CodeMirror exists. Blank
 *  lines are skipped; each non-empty line contributes at least one
 *  sentence so list items / headings ride along as their own chips. */
export function splitIntoSentences(text) {
  const out = [];
  for (const line of String(text || "").split(/\n/)) {
    if (!line.trim()) continue;
    let start = 0;
    let i = 0;
    while (i < line.length) {
      if (/[.!?]/.test(line[i])) {
        let j = i + 1;
        while (j < line.length && /["')\]}*_`]/.test(line[j])) j++;
        if (j >= line.length || /\s/.test(line[j])) {
          while (j < line.length && /\s/.test(line[j])) j++;
          const s = line.slice(start, j).trim();
          if (s) out.push(s);
          start = j;
          i = j;
          continue;
        }
      }
      i++;
    }
    const tail = line.slice(start).trim();
    if (tail) out.push(tail);
  }
  return out;
}

/* ===== In-editor sentence hover highlight ===== */

const setHoverRange = StateEffect.define();
const hoverMark = Decoration.mark({ class: "shuffle-sentence-hover" });

const hoverField = StateField.define({
  create() { return Decoration.none; },
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setHoverRange)) {
        next = e.value && e.value.to > e.value.from
          ? Decoration.set([hoverMark.range(e.value.from, e.value.to)])
          : Decoration.none;
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** CodeMirror extension that paints the `.shuffle-sentence-hover` mark.
 *  The range itself is driven from the DOM listeners installed by
 *  `installEditorSentenceDrag`. */
export function shuffleHoverExtension() {
  return [hoverField];
}

/** Resolve the sentence range surrounding a document offset, in CM
 *  offsets. Returns null when the offset sits in empty space. */
export function sentenceRangeAt(view, offset) {
  const doc = view.state.doc;
  if (doc.length === 0) return null;
  const pos = offsetToPos(doc, offset);
  const from = posToOffset(doc, findSentenceStart(doc, pos));
  const to = posToOffset(doc, findSentenceEnd(doc, pos));
  if (to <= from) return null;
  return { from, to };
}

/* ===== In-editor sentence drag ===== */

/** Wire the "hover a sentence to highlight, drag it out" gesture onto the
 *  center editor. A plain click (no travel past the threshold) is left
 *  untouched so CodeMirror places the caret and the user can edit inline.
 *  Returns a cleanup function. */
export function installEditorSentenceDrag(ctrl) {
  const view = ctrl.view;
  const content = view.contentDOM;
  let pending = null; // { from, to, text, startX, startY }
  let dragging = null; // { ghost, text }

  const clearHover = () => {
    try { view.dispatch({ effects: setHoverRange.of(null) }); } catch (_) {}
  };

  const onMouseMoveHover = (e) => {
    if (pending || dragging) return;
    const offset = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (offset == null) { clearHover(); return; }
    const range = sentenceRangeAt(view, offset);
    view.dispatch({ effects: setHoverRange.of(range) });
  };

  const onMouseLeave = () => { if (!dragging) clearHover(); };

  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    const offset = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (offset == null) return;
    const range = sentenceRangeAt(view, offset);
    if (!range) return;
    pending = {
      from: range.from, to: range.to,
      text: view.state.sliceDoc(range.from, range.to).trim(),
      startX: e.clientX, startY: e.clientY,
    };
  };

  const onDocMouseMove = (e) => {
    if (!pending && !dragging) return;
    if (pending && !dragging) {
      const moved = Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY);
      if (moved < DRAG_THRESHOLD) return;
      // Promote to a real drag: lift the sentence out of the editor,
      // consuming one adjacent space so the remaining prose stays clean.
      let { from, to } = pending;
      const doc = view.state.doc;
      if (to < doc.length && /\s/.test(doc.sliceString(to, to + 1))) to += 1;
      else if (from > 0 && /\s/.test(doc.sliceString(from - 1, from))) from -= 1;
      view.dispatch({ changes: { from, to, insert: "" }, selection: { anchor: from } });
      clearHover();
      dragging = { ghost: ctrl.makeGhost(pending.text), text: pending.text };
      pending = null;
    }
    if (dragging) {
      e.preventDefault();
      ctrl.moveGhost(dragging.ghost, e.clientX, e.clientY);
    }
  };

  const onDocMouseUp = (e) => {
    if (dragging) {
      ctrl.removeGhost(dragging.ghost);
      if (ctrl.isOverEditor(e.clientX, e.clientY)) {
        ctrl.insertSentenceIntoEditor(dragging.text, e.clientX, e.clientY);
      } else {
        ctrl.dropChipAtClient(dragging.text, e.clientX, e.clientY);
      }
      dragging = null;
    }
    pending = null;
  };

  content.addEventListener("mousemove", onMouseMoveHover);
  content.addEventListener("mouseleave", onMouseLeave);
  content.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mousemove", onDocMouseMove);
  document.addEventListener("mouseup", onDocMouseUp);

  return () => {
    content.removeEventListener("mousemove", onMouseMoveHover);
    content.removeEventListener("mouseleave", onMouseLeave);
    content.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("mousemove", onDocMouseMove);
    document.removeEventListener("mouseup", onDocMouseUp);
  };
}

/* ===== Margin chip drag ===== */

/** Wire drag + click-to-edit onto a single margin chip. A press that
 *  never travels past the threshold becomes an inline edit; a press that
 *  moves drags the chip — dropping it over the editor inserts the
 *  sentence into the CM doc, dropping it in a margin repositions it. */
export function installChipDrag(ctrl, chip) {
  chip.el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (chip.editing) return; // editing — let the browser select text
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let ghost = null;
    e.preventDefault();

    const onMove = (e2) => {
      if (!dragging) {
        if (Math.hypot(e2.clientX - startX, e2.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
        chip.el.classList.add("dragging");
        ghost = ctrl.makeGhost(chip.text);
      }
      ctrl.moveGhost(ghost, e2.clientX, e2.clientY);
    };

    const onUp = (e2) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (!dragging) { ctrl.editChip(chip); return; }
      chip.el.classList.remove("dragging");
      ctrl.removeGhost(ghost);
      if (ctrl.isOverEditor(e2.clientX, e2.clientY)) {
        ctrl.insertSentenceIntoEditor(chip.text, e2.clientX, e2.clientY);
        ctrl.removeChip(chip);
        return;
      }
      const target = ctrl.chipAtClient(e2.clientX, e2.clientY, chip);
      if (target) {
        ctrl.combineChips(target, chip.text);
        ctrl.removeChip(chip);
      } else {
        ctrl.placeChipAtClient(chip, e2.clientX, e2.clientY);
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
