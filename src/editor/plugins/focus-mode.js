/**
 * Focus Mode — dims all text except the current sentence to 50% opacity.
 * Uses the same sentence-boundary detection as sentence-navigator.js.
 */
import { ViewPlugin, Decoration, EditorView } from "@codemirror/view";
import { RangeSetBuilder, Prec, StateEffect } from "@codemirror/state";
import { syntaxHighlighting } from "@codemirror/language";
import { tagHighlighter, tags } from "@lezer/highlight";
import { stepFade } from "../../ui/fade-step.js";

// ===== Sentence boundary detection (mirrors sentence-navigator.js) =====

function getLine(doc, lineNum) {
  if (lineNum < 0 || lineNum >= doc.lines) return "";
  return doc.line(lineNum + 1).text;
}

function posToOffset(doc, pos) {
  const n = Math.min(Math.max(pos.line + 1, 1), doc.lines);
  const line = doc.line(n);
  return line.from + Math.min(pos.ch, line.length);
}

function offsetToPos(doc, offset) {
  const clamped = Math.max(0, Math.min(doc.length, offset));
  const line = doc.lineAt(clamped);
  return { line: line.number - 1, ch: clamped - line.from };
}

function findSentenceStart(doc, pos) {
  const { line } = pos;
  let ch = pos.ch;
  const content = getLine(doc, line);

  while (ch > 0) {
    if (/\s/.test(content.charAt(ch - 1))) {
      let lb = ch - 1;
      while (lb > 0 && /\s/.test(content.charAt(lb - 1))) lb--;
      while (lb > 0 && /["')\]}*_`=~]/.test(content.charAt(lb - 1))) lb--;
      if (lb > 0 && /[.!?]/.test(content.charAt(lb - 1))) {
        while (ch < content.length && /\s/.test(content.charAt(ch))) ch++;
        return { line, ch };
      }
    }
    ch--;
  }
  return { line, ch: 0 };
}

function findSentenceEnd(doc, pos) {
  const { line } = pos;
  let ch = pos.ch;
  const content = getLine(doc, line);

  // A caret just after a sentence's closing punctuation (and any closing
  // quote or mark) is still in that sentence — its start is found
  // backwards from here. Scanning on forward would run through the next
  // sentence too, lighting both at once.
  let back = ch;
  while (back > 0 && /["')\]}*_`=~]/.test(content.charAt(back - 1))) back--;
  if (back > 0 && /[.!?]/.test(content.charAt(back - 1))
      && (ch >= content.length || /[\s"')\]}*_`=~]/.test(content.charAt(ch)))) {
    while (ch < content.length && /["')\]}*_`=~]/.test(content.charAt(ch))) ch++;
    while (ch < content.length && /[ \t]/.test(content.charAt(ch))) ch++;
    return { line, ch };
  }

  while (ch < content.length) {
    if (/[.!?]/.test(content.charAt(ch))) {
      ch++;
      while (ch < content.length && /["')\]}*_`=~]/.test(content.charAt(ch))) ch++;
      while (ch < content.length && /[ \t]/.test(content.charAt(ch))) ch++;
      return { line, ch };
    }
    ch++;
  }
  return { line, ch: content.length };
}

/** Find the bounds of the sentence currently containing the cursor.
 *  Exported so other plugins (notably link-decorator) can apply the
 *  same dim treatment to widgets that bypass our `Decoration.mark`
 *  range — `Decoration.replace` widgets render as their own DOM and
 *  don't inherit opacity from the mark span around them. Returns
 *  `{ from, to }` document offsets, or null if focus mode is off /
 *  the document is empty. */
export function focusSentenceBounds(view, state) {
  if (!state?.focusMode) return null;
  const doc = view.state.doc;
  if (doc.length === 0) return null;
  const head = view.state.selection.main.head;
  const cursorPos = offsetToPos(doc, head);
  const lineContent = getLine(doc, cursorPos.line);
  if (lineContent.trim().length === 0) return { from: head, to: head };
  const ss = findSentenceStart(doc, cursorPos);
  const se = findSentenceEnd(doc, cursorPos);
  return { from: posToOffset(doc, ss), to: posToOffset(doc, se) };
}

// ===== Decoration marks =====

const dimMark = Decoration.mark({ class: "focus-mode-dim" });

/** How long the current sentence takes to come up, and the one it left
 *  to go back down (styles/focus-mode.css holds the same number). */
const FADE_MS = 300;

/** Ends a fade: an empty transaction would not reach `update` with
 *  anything to tell it apart from an ordinary one. */
const fadeDone = StateEffect.define();

/** The two fading marks. Neither carries a CSS animation: their opacity
 *  is a calc over `--fm-p`, the fade's eased progress (0 → 1), which the
 *  plugin steps on the editor element frame by frame. A CSS opacity
 *  animation lifts the span onto a compositing layer of its own while
 *  it runs, and WebKit repaints the text as it drops back off at the
 *  end — under Zen's frosted blur that read as a blink. A span redrawn
 *  mid-fade (every keystroke in the sentence) simply reads the current
 *  `--fm-p`, so the fade carries on. */
const enteringMark = Decoration.mark({ class: "focus-mode-entering" });
const leavingMark = Decoration.mark({ class: "focus-mode-dim focus-mode-leaving" });

const reducedMotion = () => {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** `range` with `cut` taken out of it — none, one or two pieces. */
function subtract(range, cut) {
  if (cut.to <= range.from || cut.from >= range.to || cut.from === cut.to) return [range];
  const out = [];
  if (range.from < cut.from) out.push({ from: range.from, to: cut.from });
  if (cut.to < range.to) out.push({ from: cut.to, to: range.to });
  return out;
}

// A stable class on heading tokens, so styles/focus-mode.css can grey a
// heading out while it sits in a dim span. The markdown HighlightStyle
// paints headings through generated class names, and a HighlightStyle
// entry's `class` *replaces* its generated style rather than adding to
// it — a second highlighter stacks its class alongside instead.
// `tags.heading` matches heading1–6.
const headingClass = syntaxHighlighting(
  tagHighlighter([{ tag: tags.heading, class: "cm-md-heading" }])
);

// ===== ViewPlugin =====

// `Prec.lowest` puts the dim marks at the bottom of the decoration
// stack, and CodeMirror nests lower-precedence marks *outside* higher
// ones — so the dim span wraps highlight / YOUAREHERE / find spans and
// their backgrounds fade with the text instead of sitting at full
// strength around a faded glyph. Being the wrapper is also what lets
// the CSS desaturate exactly what is dimmed (`.focus-mode-dim .x`), so
// the current sentence — the one gap in the dim — keeps its colour.
// `cm-focus-mode` on the editor root covers what no mark can wrap
// (rendered tables); it is per surface because a pane's focus mode is
// its own, so <body> can't say.
//
// The sentence changes with a fade rather than a cut (FADE_MS): the new
// one comes up from the dim level (`.focus-mode-entering`) while the one
// the caret left goes back down to it (`.focus-mode-leaving`, a dim span
// that starts its animation at full strength). Only the last sentence
// left fades; one left before it, mid-fade, drops straight to the dim.
//
// Turning the mode on or off fades too, over the same FADE_MS: the dim
// comes down from full strength on the way in, and on the way out the
// marks stay while it goes back up, and only then are dropped. That is
// `--fm-in` on the editor (0 no dim … 1 the dim the slider sets), stepped
// from script like `--fm-p`; the CSS folds it into `--fm-dim`, the level
// every mark reads.
export function createFocusModePlugin(state) {
  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.lastFocusMode = state.focusMode;
        this.current = null;   // { from, to } the caret's sentence
        this.leaving = null;   // { from, to } the one it left, fading out
        this.changedAt = 0;    // when the sentence last changed
        this.frame = 0;        // the running fade's animation frame
        this.fading = false;
        this.level = state.focusMode ? 1 : 0; // --fm-in
        this.exiting = false;  // off, but still fading out
        this.stopLevel = () => {};
        this.decorations = this.buildDecorations(view, false);
      }

      /** Fade `--fm-in` to `to` from wherever it is; `done` at the end. */
      fadeLevel(to, done) {
        this.stopLevel();
        const dom = this.view.dom;
        this.stopLevel = stepFade(this.level, to, (v) => {
          this.level = v;
          dom.style.setProperty("--fm-in", v.toFixed(4));
        }, done);
      }

      update(update) {
        const focusChanged = state.focusMode !== this.lastFocusMode;
        this.lastFocusMode = state.focusMode;
        const ended = update.transactions.some((tr) => tr.effects.some((e) => e.is(fadeDone)));
        if (focusChanged && state.focusMode) {
          // On (or back on mid-exit): from no dim, or from where the exit
          // had got to, down to the slider's level. Stopping the exit's
          // stepper also drops its ending.
          this.exiting = false;
          this.fadeLevel(1);
        } else if (focusChanged && this.decorations.size) {
          // Off: keep the marks where they are while the dim lifts, then
          // drop them (the fadeDone rebuilds to nothing). The end is
          // dispatched from a microtask: under reduced motion the fade
          // ends at once, inside this update, where no dispatch may run.
          this.exiting = true;
          this.fadeLevel(0, () => queueMicrotask(() => {
            this.exiting = false;
            try { this.view.dispatch({ effects: fadeDone.of(null) }); } catch { /* view gone */ }
          }));
          return;
        }
        if (this.exiting) {
          if (update.docChanged) this.decorations = this.decorations.map(update.changes);
          return;
        }
        if (update.docChanged) {
          const map = (r) => r && { from: update.changes.mapPos(r.from, -1), to: update.changes.mapPos(r.to, 1) };
          this.current = map(this.current);
          this.leaving = map(this.leaving);
        }
        if (
          focusChanged ||
          ended ||
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged
        ) {
          // Turning focus mode on or off is not a sentence change.
          this.decorations = this.buildDecorations(update.view, !focusChanged);
        }
      }

      destroy() {
        cancelAnimationFrame(this.frame);
        this.stopLevel();
      }

      /** Run the fade: `--fm-p` from 0 to 1 over FADE_MS on the editor,
       *  then drop the fading marks (an effect, so `update` rebuilds). It
       *  is set to 0 here, before the marks first render, so the new
       *  sentence never shows a frame at full strength. */
      startFade(now) {
        cancelAnimationFrame(this.frame);
        this.changedAt = now;
        this.fading = true;
        const dom = this.view.dom;
        dom.style.setProperty("--fm-p", "0");
        const step = () => {
          const t = Math.min(1, (performance.now() - this.changedAt) / FADE_MS);
          dom.style.setProperty("--fm-p", ease(t).toFixed(4));
          if (t < 1) { this.frame = requestAnimationFrame(step); return; }
          this.frame = 0;
          this.fading = false;
          this.leaving = null;
          try { this.view.dispatch({ effects: fadeDone.of(null) }); } catch { /* view gone */ }
        };
        this.frame = requestAnimationFrame(step);
      }

      buildDecorations(view, animate) {
        if (!state.focusMode) {
          this.current = this.leaving = null;
          return Decoration.none;
        }

        const doc = view.state.doc;
        if (doc.length === 0) return Decoration.none;

        const head = view.state.selection.main.head;
        const cursorPos = offsetToPos(doc, head);
        const lineContent = getLine(doc, cursorPos.line);

        // If cursor is on an empty line, highlight nothing (dim everything)
        let sentStart, sentEnd;
        if (lineContent.trim().length === 0) {
          sentStart = head;
          sentEnd = head;
        } else {
          const ss = findSentenceStart(doc, cursorPos);
          const se = findSentenceEnd(doc, cursorPos);
          sentStart = posToOffset(doc, ss);
          sentEnd = posToOffset(doc, se);
        }
        const next = { from: sentStart, to: sentEnd };

        // A new sentence is one that starts somewhere else: typing on
        // in the same one only moves its end.
        const now = performance.now();
        if (this.current && this.current.from !== next.from) {
          if (animate && !reducedMotion()) {
            this.leaving = this.current;
            this.startFade(now);
          } else {
            this.leaving = null;
          }
        }
        this.current = next;
        const fading = animate !== false && this.fading;
        if (!fading) this.leaving = null;

        // The marked ranges in document order; whatever lies between
        // them is dimmed.
        // Only what wasn't lit already comes up: where the new sentence
        // overlaps the one just left, it stays at full strength rather
        // than dropping to the dim level and fading back (a blink).
        const marks = [];
        if (fading && next.to > next.from) {
          const fresh = this.leaving ? subtract(next, this.leaving) : [next];
          for (const piece of fresh) marks.push({ ...piece, deco: enteringMark });
          if (this.leaving) {
            const from = Math.max(next.from, this.leaving.from), to = Math.min(next.to, this.leaving.to);
            if (to > from) marks.push({ from, to, deco: null });
          }
        } else marks.push({ ...next, deco: null });
        if (fading && this.leaving) {
          const out = leavingMark;
          for (const piece of subtract(this.leaving, next)) {
            const from = Math.max(0, piece.from), to = Math.min(doc.length, piece.to);
            if (to > from) marks.push({ from, to, deco: out });
          }
        }
        marks.sort((a, b) => a.from - b.from);

        const builder = new RangeSetBuilder();
        let pos = 0;
        for (const m of marks) {
          if (m.from > pos) builder.add(pos, m.from, dimMark);
          if (m.deco && m.to > m.from) builder.add(m.from, m.to, m.deco);
          pos = Math.max(pos, m.to);
        }
        if (pos < doc.length) builder.add(pos, doc.length, dimMark);

        return builder.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
      // Re-read on every view update, which is also what re-dims on toggle.
      // Held through the exit fade, with the marks.
      provide: (self) => EditorView.editorAttributes.of(
        (view) => (state.focusMode || view.plugin(self)?.exiting ? { class: "cm-focus-mode" } : null)
      ),
    }
  );
  return [headingClass, Prec.lowest(plugin)];
}
