/**
 * Sentence navigation and editing for CodeMirror 6.
 * Ported from obsidian-sentence-navigator (github.com/laffan/obsidian-sentence-navigator).
 *
 * Operates on the main selection. Sentence boundaries are detected within
 * individual lines (matching Obsidian/markdown paragraph semantics). The
 * low-level position + boundary helpers live in `sentence-core.js`.
 */
import { EditorSelection } from "@codemirror/state";
import { moveWordsForward, moveWordsBack } from "./word-shift.js";
import {
  getLine, posToOffset, offsetToPos, selBounds,
  findSentenceStart, findSentenceEnd, dispatch,
} from "./sentence-core.js";

// ===== Exported CM6 commands =====

/** Select the current sentence, or expand by one sentence on repeat. */
export function selectSentence(view) {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const { from, to } = selBounds(doc, sel);
  const pos = offsetToPos(doc, sel.head);

  if (sel.from !== sel.to) {
    // Already have a selection — try to expand
    const rest = getLine(doc, to.line).substring(to.ch);
    if (/\S/.test(rest)) {
      const next = findSentenceEnd(doc, { line: to.line, ch: to.ch });
      if (next.ch > to.ch) {
        dispatch(view, from, next);
        return true;
      }
    }
    const nextLine = to.line + 1;
    if (nextLine >= doc.lines) return true;
    const nextContent = getLine(doc, nextLine);
    if (nextContent.trim().length === 0) {
      dispatch(view, from, { line: nextLine + 1, ch: 0 });
      return true;
    }
    const fw = nextContent.search(/\S/);
    const end = findSentenceEnd(doc, { line: nextLine, ch: fw >= 0 ? fw : 0 });
    dispatch(view, from, end);
    return true;
  }

  // No selection — select current sentence
  const content = getLine(doc, pos.line);
  if (content.trim().length === 0) {
    dispatch(view, { line: pos.line, ch: 0 }, { line: pos.line + 1, ch: 0 });
    return true;
  }
  let sp = pos;
  if (/^\s*$/.test(content.substring(0, pos.ch))) {
    const fw = content.search(/\S/);
    if (fw !== -1) sp = { line: pos.line, ch: fw };
  }
  dispatch(view, findSentenceStart(doc, sp), findSentenceEnd(doc, sp));
  return true;
}

/** Shrink the selection by one sentence from the tail — the precise
 *  inverse of `selectSentence`'s grow. Retracts the head to the start of
 *  the last selected sentence; floors at the first sentence so repeated
 *  presses never snap back to the whole original selection. */
export function reduceSentenceSelection(view) {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  if (sel.empty) return true;
  const from = sel.from; // anchor (sentence start) stays put

  // Walk to the start of the sentence the head currently sits at the end
  // of, and retract the head there — dropping exactly one sentence.
  const probePos = offsetToPos(doc, Math.max(from, sel.to - 1));
  const lastStart = posToOffset(doc, findSentenceStart(doc, probePos));
  if (lastStart > from) {
    view.dispatch({ selection: EditorSelection.single(from, lastStart) });
    return true;
  }

  // Only one sentence remains — keep it selected without expanding past
  // the current head.
  const firstEnd = posToOffset(doc, findSentenceEnd(doc, offsetToPos(doc, from)));
  const head = Math.min(sel.to, Math.max(from, firstEnd));
  view.dispatch({ selection: EditorSelection.single(from, head) });
  return true;
}

/** Shift the selection forward by as many sentences as it currently
 *  spans, keeping that span size. With an empty selection it first grows
 *  the head to the end of the current sentence (extend-by-sentence feel);
 *  with N sentences selected it slides the N-sentence window forward by N. */
export function shiftSelectionToNextSentence(view) {
  const doc = view.state.doc;
  const sel = view.state.selection.main;

  // Empty selection, cursor mid-sentence — extend the head to the
  // sentence end and bail (matches the prior first-press behaviour).
  if (sel.empty) {
    const sentEndOff = posToOffset(doc, findSentenceEnd(doc, offsetToPos(doc, sel.head)));
    if (sentEndOff > sel.head) {
      view.dispatch({ selection: EditorSelection.single(sel.anchor, sentEndOff) });
      return true;
    }
  }

  const n = sel.empty ? 1 : countSentencesInRange(doc, sel.from, sel.to);
  const start = nextSentenceStart(doc, selBounds(doc, sel).to);
  if (!start) return true;
  const startPos = findSentenceStart(doc, start);
  let endPos = findSentenceEnd(doc, start);
  for (let i = 1; i < n; i++) {
    const ns = nextSentenceStart(doc, endPos);
    if (!ns) break;
    endPos = findSentenceEnd(doc, ns);
  }
  dispatch(view, startPos, endPos);
  return true;
}

/** Mirror of `shiftSelectionToNextSentence` — shifts the selection back by
 *  as many sentences as it currently spans. Empty selection extends the
 *  head back to the sentence start; an N-sentence window slides back by N. */
export function shiftSelectionToPreviousSentence(view) {
  const doc = view.state.doc;
  const sel = view.state.selection.main;

  if (sel.empty) {
    const sentStartOff = posToOffset(doc, findSentenceStart(doc, offsetToPos(doc, sel.head)));
    if (sentStartOff < sel.head) {
      view.dispatch({ selection: EditorSelection.single(sel.anchor, sentStartOff) });
      return true;
    }
  }

  const n = sel.empty ? 1 : countSentencesInRange(doc, sel.from, sel.to);
  const probe = prevSentenceProbe(doc, selBounds(doc, sel).from);
  if (!probe) return true;
  const endPos = findSentenceEnd(doc, probe);
  let startPos = findSentenceStart(doc, probe);
  for (let i = 1; i < n; i++) {
    const pp = prevSentenceProbe(doc, startPos);
    if (!pp) break;
    startPos = findSentenceStart(doc, pp);
  }
  dispatch(view, startPos, endPos);
  return true;
}

/** Swap the current sentence with the next one — unless the user has a
 *  partial (sub-sentence) selection, in which case shift those selected
 *  words forward past the next word instead (see `moveWordsForward`). A
 *  full-sentence selection or a bare cursor keeps the sentence-swap. */
export function moveSentenceForward(view) {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  if (!sel.empty && !selectionIsFullSentence(doc, sel)) return moveWordsForward(view);
  const { csStart, csEnd, csStartOff, csEndOff, csText, csLen } =
    currentSentenceRange(doc, sel);

  // Find next sentence, checking for paragraph breaks
  let sp = csEnd;
  let crossesParagraph = false;
  let pbEndOff = null;

  while (sp.line < doc.lines) {
    const lc = getLine(doc, sp.line);
    if (sp.ch < lc.length) {
      if (!/\s/.test(lc.charAt(sp.ch))) break;
      sp = { line: sp.line, ch: sp.ch + 1 };
    } else {
      if (sp.line + 1 >= doc.lines) return true;
      const nl = getLine(doc, sp.line + 1);
      if (nl.trim().length === 0) {
        crossesParagraph = true;
        let endLine = sp.line + 1;
        while (endLine < doc.lines && getLine(doc, endLine).trim().length === 0) endLine++;
        pbEndOff = posToOffset(doc, { line: endLine, ch: 0 });
        break;
      }
      sp = { line: sp.line + 1, ch: 0 };
    }
  }

  if (crossesParagraph && pbEndOff !== null) {
    // Move sentence to start of next paragraph (no swap)
    view.dispatch({
      changes: [
        { from: csStartOff, to: csEndOff },
        { from: pbEndOff, insert: csText },
      ],
      selection: EditorSelection.single(pbEndOff - csLen, pbEndOff),
    });
    return true;
  }

  // Normal swap with next sentence
  const nsStart = findSentenceStart(doc, sp);
  const nsEnd = findSentenceEnd(doc, sp);
  const nsStartOff = posToOffset(doc, nsStart);
  const nsEndOff = posToOffset(doc, nsEnd);
  const nsText = doc.sliceString(nsStartOff, nsEndOff);
  let between = doc.sliceString(csEndOff, nsStartOff);
  if (between.length === 0 && !/\s$/.test(nsText)) between = " ";

  const replacement = nsText + between + csText;
  const newAnchor = csStartOff + nsText.length + between.length;
  view.dispatch({
    changes: { from: csStartOff, to: nsEndOff, insert: replacement },
    selection: EditorSelection.single(newAnchor, newAnchor + csLen),
  });
  return true;
}

/** Swap the current sentence with the previous one — unless the user has
 *  a partial (sub-sentence) selection, in which case shift those selected
 *  words back past the previous word instead (see `moveWordsBack`). */
export function moveSentenceBack(view) {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  if (!sel.empty && !selectionIsFullSentence(doc, sel)) return moveWordsBack(view);
  const { csStart, csEnd, csStartOff, csEndOff, csText, csLen } =
    currentSentenceRange(doc, sel);

  // Find previous sentence, checking for paragraph breaks
  let sp = csStart;
  let crossesParagraph = false;
  let pbStartOff = null;

  if (sp.ch > 0) {
    sp = { line: sp.line, ch: sp.ch - 1 };
  } else if (sp.line > 0) {
    sp = { line: sp.line - 1, ch: getLine(doc, sp.line - 1).length };
  } else {
    return true;
  }

  while (sp.ch > 0 || sp.line > 0) {
    const lc = getLine(doc, sp.line);
    if (sp.ch > 0) {
      if (!/\s/.test(lc.charAt(sp.ch - 1))) break;
      sp = { line: sp.line, ch: sp.ch - 1 };
    } else {
      const cl = getLine(doc, sp.line);
      if (cl.trim().length === 0) {
        crossesParagraph = true;
        let startLine = sp.line;
        while (startLine > 0 && getLine(doc, startLine - 1).trim().length === 0) startLine--;
        if (startLine > 0) {
          const prevLine = startLine - 1;
          pbStartOff = posToOffset(doc, { line: prevLine, ch: getLine(doc, prevLine).length });
        }
        break;
      }
      if (sp.line === 0) break;
      sp = { line: sp.line - 1, ch: getLine(doc, sp.line - 1).length };
    }
  }

  if (crossesParagraph && pbStartOff !== null) {
    // Move sentence to end of previous paragraph (no swap)
    view.dispatch({
      changes: [
        { from: csStartOff, to: csEndOff },
        { from: pbStartOff, insert: csText },
      ],
      selection: EditorSelection.single(
        pbStartOff,
        pbStartOff + csLen,
      ),
    });
    return true;
  }

  // Skip closing delimiters and punctuation to land inside prev sentence
  const lc2 = getLine(doc, sp.line);
  while (sp.ch > 0 && /["')\]}*_`]/.test(lc2.charAt(sp.ch - 1))) sp = { line: sp.line, ch: sp.ch - 1 };
  if (sp.ch > 0 && /[.!?]/.test(lc2.charAt(sp.ch - 1))) sp = { line: sp.line, ch: sp.ch - 1 };
  if (sp.ch > 0) sp = { line: sp.line, ch: sp.ch - 1 };

  const psStart = findSentenceStart(doc, sp);
  const psEnd = findSentenceEnd(doc, sp);
  const psStartOff = posToOffset(doc, psStart);
  const psEndOff = posToOffset(doc, psEnd);
  const psText = doc.sliceString(psStartOff, psEndOff);
  let between = doc.sliceString(psEndOff, csStartOff);
  if (between.length === 0 && !/\s$/.test(csText)) between = " ";

  const replacement = csText + between + psText;
  view.dispatch({
    changes: { from: psStartOff, to: csEndOff, insert: replacement },
    selection: EditorSelection.single(psStartOff, psStartOff + csLen),
  });
  return true;
}

/** Move cursor to the start of the next sentence. */
export function jumpToNextSentence(view) {
  const doc = view.state.doc;
  const head = view.state.selection.main.head;
  const pos = offsetToPos(doc, head);
  const end = findSentenceEnd(doc, pos);
  let endOff = posToOffset(doc, end);
  if (endOff <= head && pos.line + 1 < doc.lines) {
    const nextLine = pos.line + 1;
    const content = getLine(doc, nextLine);
    const fw = content.search(/\S/);
    endOff = posToOffset(doc, { line: nextLine, ch: fw >= 0 ? fw : 0 });
  }
  view.dispatch({ selection: EditorSelection.cursor(endOff) });
  return true;
}

/** Move cursor to the start of the current/previous sentence. */
export function jumpToPrevSentence(view) {
  const doc = view.state.doc;
  const head = view.state.selection.main.head;
  const pos = offsetToPos(doc, head);
  const start = findSentenceStart(doc, pos);
  let startOff = posToOffset(doc, start);

  if (startOff >= head) {
    // Already at sentence start — look for the previous sentence.
    // First try the same line: step back past the boundary punctuation.
    const lineText = getLine(doc, start.line);
    let backCh = start.ch;
    while (backCh > 0 && /\s/.test(lineText.charAt(backCh - 1))) backCh--;
    while (backCh > 0 && /["')\]}*_`]/.test(lineText.charAt(backCh - 1))) backCh--;
    while (backCh > 0 && /[.!?]/.test(lineText.charAt(backCh - 1))) backCh--;

    if (backCh > 0) {
      // Found content before the boundary on this line — get its sentence start
      const prevStart = findSentenceStart(doc, { line: start.line, ch: backCh });
      startOff = posToOffset(doc, prevStart);
    } else if (start.line > 0) {
      // Nothing before on this line — go to the previous line
      const prevLine = start.line - 1;
      const content = getLine(doc, prevLine);
      if (content.trim().length === 0) {
        startOff = posToOffset(doc, { line: prevLine, ch: 0 });
      } else {
        startOff = posToOffset(doc, findSentenceStart(doc, { line: prevLine, ch: content.length }));
      }
    }
  }

  view.dispatch({ selection: EditorSelection.cursor(startOff) });
  return true;
}

/** Delete from cursor to end of current sentence. */
export function deleteToSentenceEnd(view) {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const pos = offsetToPos(doc, sel.head);
  const lineEnd = { line: pos.line, ch: getLine(doc, pos.line).length };
  const rest = getLine(doc, pos.line).substring(pos.ch);

  const m = rest.match(/[.!?]["')\]}*_`]*(?=\s|$)/);
  let endOff;
  if (m && m.index !== undefined) {
    endOff = sel.head + m.index + m[0].length;
  } else {
    endOff = posToOffset(doc, lineEnd);
    if (sel.head === endOff && pos.line + 1 < doc.lines) {
      endOff = posToOffset(doc, { line: pos.line + 1, ch: 0 });
    }
  }

  if (endOff > sel.head) {
    view.dispatch({
      changes: { from: sel.head, to: endOff },
      selection: EditorSelection.cursor(sel.head),
    });
  }
  return true;
}

// ===== Paragraph navigation =====

/** Jump cursor to the first word of the previous paragraph. */
export function jumpToPrevParagraph(view) {
  const doc = view.state.doc;
  const curLine = doc.lineAt(view.state.selection.main.head);
  let ln = curLine.number;
  if (curLine.text.trim().length > 0) {
    while (ln > 1 && doc.line(ln - 1).text.trim().length > 0) ln--;
  }
  while (ln > 1 && doc.line(ln - 1).text.trim().length === 0) ln--;
  while (ln > 1 && doc.line(ln - 1).text.trim().length > 0) ln--;
  const line = doc.line(ln);
  const fw = line.text.search(/\S/);
  view.dispatch({ selection: EditorSelection.cursor(line.from + (fw >= 0 ? fw : 0)) });
  return true;
}

/** Jump cursor to the first word of the next paragraph. */
export function jumpToNextParagraph(view) {
  const doc = view.state.doc;
  const curLine = doc.lineAt(view.state.selection.main.head);
  let ln = curLine.number;
  while (ln < doc.lines && doc.line(ln).text.trim().length > 0) ln++;
  while (ln < doc.lines && doc.line(ln).text.trim().length === 0) ln++;
  if (ln <= doc.lines) {
    const line = doc.line(ln);
    const fw = line.text.search(/\S/);
    view.dispatch({ selection: EditorSelection.cursor(line.from + (fw >= 0 ? fw : 0)) });
  }
  return true;
}

// ===== Select paragraph =====

/** Select the current paragraph (text block between blank lines). */
export function selectParagraph(view) {
  const doc = view.state.doc;
  const head = view.state.selection.main.head;
  const curLine = doc.lineAt(head);
  let startLn = curLine.number;
  let endLn = curLine.number;

  // Expand upward to find paragraph start (stop at blank line or doc start)
  while (startLn > 1 && doc.line(startLn - 1).text.trim().length > 0) startLn--;
  // Expand downward to find paragraph end (stop at blank line or doc end)
  while (endLn < doc.lines && doc.line(endLn + 1).text.trim().length > 0) endLn++;

  const from = doc.line(startLn).from;
  const to = doc.line(endLn).to;
  view.dispatch({ selection: EditorSelection.single(from, to) });
  return true;
}

/**
 * Extend the selection upward to the start of the current paragraph
 * (Cmd+Shift+Up). Overrides CodeMirror's default "select to document
 * start". If the head is already at the paragraph start, hop to the start
 * of the previous paragraph so repeated presses keep climbing.
 */
export function selectToParagraphAbove(view) {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const headLine = doc.lineAt(sel.head);
  let target = headLine.from;
  if (sel.head === target) {
    // Already at a paragraph start — climb past blank lines into the
    // previous paragraph and land on its first line start.
    let ln = headLine.number;
    while (ln > 1 && doc.line(ln - 1).text.trim().length === 0) ln--;
    while (ln > 1 && doc.line(ln - 1).text.trim().length > 0) ln--;
    target = doc.line(ln).from;
  } else {
    // Climb to the first line of the paragraph the head sits in.
    let ln = headLine.number;
    while (ln > 1 && doc.line(ln - 1).text.trim().length > 0) ln--;
    target = doc.line(ln).from;
    if (target === sel.head && ln > 1) {
      while (ln > 1 && doc.line(ln - 1).text.trim().length === 0) ln--;
      while (ln > 1 && doc.line(ln - 1).text.trim().length > 0) ln--;
      target = doc.line(ln).from;
    }
  }
  view.dispatch({ selection: EditorSelection.range(sel.anchor, target), scrollIntoView: true });
  return true;
}

/**
 * Extend the selection downward to the end of the current paragraph
 * (Cmd+Shift+Down). Overrides CodeMirror's default "select to document
 * end". Repeated presses descend through following paragraphs.
 */
export function selectToParagraphBelow(view) {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const headLine = doc.lineAt(sel.head);
  let target = headLine.to;
  if (sel.head === target) {
    let ln = headLine.number;
    while (ln < doc.lines && doc.line(ln + 1).text.trim().length === 0) ln++;
    while (ln < doc.lines && doc.line(ln + 1).text.trim().length > 0) ln++;
    target = doc.line(ln).to;
  } else {
    let ln = headLine.number;
    while (ln < doc.lines && doc.line(ln + 1).text.trim().length > 0) ln++;
    target = doc.line(ln).to;
    if (target === sel.head && ln < doc.lines) {
      while (ln < doc.lines && doc.line(ln + 1).text.trim().length === 0) ln++;
      while (ln < doc.lines && doc.line(ln + 1).text.trim().length > 0) ln++;
      target = doc.line(ln).to;
    }
  }
  view.dispatch({ selection: EditorSelection.range(sel.anchor, target), scrollIntoView: true });
  return true;
}

// ===== Join lines (pull up) =====

/** Remove the next line break, joining the current line with the line below. */
export function joinLines(view) {
  const doc = view.state.doc;
  const head = view.state.selection.main.head;
  const line = doc.lineAt(head);
  if (line.number >= doc.lines) return true; // already last line
  const nextLine = doc.line(line.number + 1);
  // Replace the newline + any leading whitespace on the next line with a single space
  const leadingWs = nextLine.text.match(/^\s*/)[0].length;
  const from = line.to;            // end of current line (before \n)
  const to = nextLine.from + leadingWs; // start of next line content
  const insert = nextLine.text.trim().length > 0 ? " " : "";
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + insert.length),
  });
  return true;
}

/** Remove the previous line break, joining the current line with the line above. */
export function joinLinesUp(view) {
  const doc = view.state.doc;
  const head = view.state.selection.main.head;
  const line = doc.lineAt(head);
  if (line.number <= 1) return true; // already first line
  const prevLine = doc.line(line.number - 1);
  // Replace the newline + any leading whitespace on the current line with a single space
  const leadingWs = line.text.match(/^\s*/)[0].length;
  const from = prevLine.to;          // end of previous line (before \n)
  const to = line.from + leadingWs;  // start of current line content
  const insert = line.text.trim().length > 0 ? " " : "";
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + insert.length),
  });
  return true;
}

/**
 * Open a new line below the current one and drop the cursor into it.
 *
 * This is the pair to `insertBreakBefore`. ⌘↩ has always done this —
 * it's CodeMirror's own `insertBlankLine`, which arrives with the
 * default keymap — but only as a fixed binding nothing in Settings knew
 * about, so it had no visible partner and couldn't be rebound. Naming it
 * here puts both halves in the Shortcuts tab under one pair of labels.
 *
 * Leading whitespace carries over, so opening a line inside an indented
 * block lands the caret where the block continues rather than at column
 * zero.
 */
export function insertBreakAfter(view) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const indent = line.text.match(/^[ \t]*/)[0];
  view.dispatch({
    changes: { from: line.to, to: line.to, insert: "\n" + indent },
    selection: EditorSelection.cursor(line.to + 1 + indent.length),
    scrollIntoView: true,
  });
  return true;
}

/**
 * Open a new line *above* the current one and drop the cursor into it,
 * leaving the current line's text where it was.
 *
 * Written as an insert at the line's start (`indent + "\n"`) rather than
 * at the previous line's end so it works on line 1, where there is no
 * previous line to append to.
 */
export function insertBreakBefore(view) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const indent = line.text.match(/^[ \t]*/)[0];
  view.dispatch({
    changes: { from: line.from, to: line.from, insert: indent + "\n" },
    selection: EditorSelection.cursor(line.from + indent.length),
    scrollIntoView: true,
  });
  return true;
}

// ===== Internal helpers =====

/** True when the selection covers exactly one full sentence (ignoring
 *  leading / trailing whitespace), so the sentence-swap behaviour applies
 *  rather than the word shift. */
function selectionIsFullSentence(doc, sel) {
  if (sel.empty) return false;
  const fromPos = offsetToPos(doc, sel.from);
  const ssOff = posToOffset(doc, findSentenceStart(doc, fromPos));
  const seOff = posToOffset(doc, findSentenceEnd(doc, fromPos));
  const selText = doc.sliceString(sel.from, sel.to).trim();
  const sentText = doc.sliceString(ssOff, seOff).trim();
  return selText.length > 0 && selText === sentText;
}

/** Position where the next sentence begins after `pos` (skips trailing
 *  whitespace and blank lines). Returns null at document end. */
function nextSentenceStart(doc, pos) {
  let sp = pos;
  let lc = getLine(doc, sp.line);
  while (sp.ch < lc.length && /\s/.test(lc.charAt(sp.ch))) sp = { line: sp.line, ch: sp.ch + 1 };
  if (sp.ch >= lc.length) {
    if (sp.line + 1 >= doc.lines) return null;
    sp = { line: sp.line + 1, ch: 0 };
    let nl = getLine(doc, sp.line);
    while (nl.trim().length === 0) {
      if (sp.line + 1 >= doc.lines) return null;
      sp = { line: sp.line + 1, ch: 0 };
      nl = getLine(doc, sp.line);
    }
    const fw = nl.search(/\S/);
    if (fw !== -1) sp = { line: sp.line, ch: fw };
  }
  return sp;
}

/** A position inside the sentence preceding `pos` (steps back over the
 *  whitespace + terminator separating them). Returns null at doc start. */
function prevSentenceProbe(doc, pos) {
  let sp = pos;
  if (sp.ch > 0) sp = { line: sp.line, ch: sp.ch - 1 };
  else if (sp.line > 0) sp = { line: sp.line - 1, ch: getLine(doc, sp.line - 1).length };
  else return null;
  while (sp.ch > 0 || sp.line > 0) {
    const lc = getLine(doc, sp.line);
    if (sp.ch > 0) {
      if (!/\s/.test(lc.charAt(sp.ch - 1))) break;
      sp = { line: sp.line, ch: sp.ch - 1 };
    } else {
      if (sp.line === 0) break;
      sp = { line: sp.line - 1, ch: getLine(doc, sp.line - 1).length };
    }
  }
  const lc = getLine(doc, sp.line);
  while (sp.ch > 0 && /["')\]}*_`]/.test(lc.charAt(sp.ch - 1))) sp = { line: sp.line, ch: sp.ch - 1 };
  if (sp.ch > 0 && /[.!?]/.test(lc.charAt(sp.ch - 1)) && sp.ch > 1) sp = { line: sp.line, ch: sp.ch - 2 };
  return sp;
}

/** Count how many sentences the offset range [fromOff, toOff) spans, using
 *  the same boundary stepping as the grow/select commands so the tally
 *  matches what the user actually selected. Always at least 1. */
function countSentencesInRange(doc, fromOff, toOff) {
  if (toOff <= fromOff) return 1;
  let count = 0;
  let cur = fromOff;
  let guard = 0;
  while (cur < toOff && guard++ < 5000) {
    const p = offsetToPos(doc, cur);
    let endOff = posToOffset(doc, findSentenceEnd(doc, p));
    if (endOff <= cur) {
      if (p.line + 1 >= doc.lines) break;
      endOff = posToOffset(doc, { line: p.line + 1, ch: 0 });
    }
    count++;
    cur = endOff;
  }
  return Math.max(1, count);
}

function currentSentenceRange(doc, sel) {
  const { from, to } = selBounds(doc, sel);
  const hasSelection = sel.from !== sel.to;
  let csStart, csEnd;

  if (hasSelection) {
    csStart = findSentenceStart(doc, from);
    const endSS = findSentenceStart(doc, to);
    if (endSS.line > to.line || (endSS.line === to.line && endSS.ch >= to.ch)) {
      csEnd = to;
    } else {
      csEnd = findSentenceEnd(doc, endSS);
    }
  } else {
    csStart = findSentenceStart(doc, from);
    csEnd = findSentenceEnd(doc, from);
  }

  const csStartOff = posToOffset(doc, csStart);
  const csEndOff = posToOffset(doc, csEnd);
  return {
    csStart, csEnd, csStartOff, csEndOff,
    csText: doc.sliceString(csStartOff, csEndOff),
    csLen: csEndOff - csStartOff,
  };
}
