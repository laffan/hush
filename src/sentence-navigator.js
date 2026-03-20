/**
 * Sentence navigation and editing for CodeMirror 6.
 * Ported from obsidian-sentence-navigator (github.com/laffan/obsidian-sentence-navigator).
 *
 * Operates on the main selection. Sentence boundaries are detected within
 * individual lines (matching Obsidian/markdown paragraph semantics).
 */
import { EditorSelection } from "@codemirror/state";

// ===== Helpers bridging Obsidian line/ch positions to CM6 offsets =====

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

function selBounds(doc, sel) {
  return { from: offsetToPos(doc, sel.from), to: offsetToPos(doc, sel.to) };
}

// ===== Core sentence-boundary detection (ported as-is) =====

function findSentenceStart(doc, pos) {
  const { line } = pos;
  let ch = pos.ch;
  const content = getLine(doc, line);

  while (ch > 0) {
    if (/\s/.test(content.charAt(ch - 1))) {
      let lb = ch - 1;
      while (lb > 0 && /\s/.test(content.charAt(lb - 1))) lb--;
      while (lb > 0 && /["')\]}*_`]/.test(content.charAt(lb - 1))) lb--;
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

  while (ch < content.length) {
    if (/[.!?]/.test(content.charAt(ch))) {
      ch++;
      while (ch < content.length && /["')\]}*_`]/.test(content.charAt(ch))) ch++;
      while (ch < content.length && /[ \t]/.test(content.charAt(ch))) ch++;
      return { line, ch };
    }
    ch++;
  }
  return { line, ch: content.length };
}

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

/** Shrink the selection by one sentence from the tail. */
export function reduceSentenceSelection(view) {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  if (sel.from === sel.to) return true;
  const { from, to } = selBounds(doc, sel);

  if (to.ch === 0 && to.line > from.line) {
    const prev = to.line - 1;
    dispatch(view, from, { line: prev, ch: getLine(doc, prev).length });
    return true;
  }

  const text = doc.sliceString(sel.from, sel.to);
  const matches = Array.from(text.matchAll(/[.!?](?:\s|$)/g));
  if (matches.length >= 2) {
    const prev = matches[matches.length - 2];
    const end = (prev.index ?? 0) + prev[0].length;
    const newHead = offsetToPos(doc, sel.from + end);
    if (newHead.line > from.line || (newHead.line === from.line && newHead.ch > from.ch)) {
      dispatch(view, from, newHead);
      return true;
    }
  }
  dispatch(view, findSentenceStart(doc, from), findSentenceEnd(doc, from));
  return true;
}

/** Move selection to the next sentence (without keeping current). */
export function shiftSelectionToNextSentence(view) {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const { to } = selBounds(doc, sel);
  let sp = to;

  // Skip trailing whitespace
  let lc = getLine(doc, sp.line);
  while (sp.ch < lc.length && /\s/.test(lc.charAt(sp.ch))) sp = { line: sp.line, ch: sp.ch + 1 };

  if (sp.ch >= lc.length) {
    if (sp.line + 1 >= doc.lines) return true;
    sp = { line: sp.line + 1, ch: 0 };
    let nl = getLine(doc, sp.line);
    while (nl.trim().length === 0) {
      if (sp.line + 1 >= doc.lines) return true;
      sp = { line: sp.line + 1, ch: 0 };
      nl = getLine(doc, sp.line);
    }
    const fw = nl.search(/\S/);
    if (fw !== -1) sp = { line: sp.line, ch: fw };
  }
  dispatch(view, findSentenceStart(doc, sp), findSentenceEnd(doc, sp));
  return true;
}

/** Move selection to the previous sentence. */
export function shiftSelectionToPreviousSentence(view) {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const { from } = selBounds(doc, sel);
  let sp = from;

  // Step back one char
  if (sp.ch > 0) {
    sp = { line: sp.line, ch: sp.ch - 1 };
  } else if (sp.line > 0) {
    sp = { line: sp.line - 1, ch: getLine(doc, sp.line - 1).length };
  } else {
    return true;
  }

  // Skip whitespace backward
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

  // Skip closing delimiters and sentence-ending punctuation
  const lc = getLine(doc, sp.line);
  while (sp.ch > 0 && /["')\]}*_`]/.test(lc.charAt(sp.ch - 1))) sp = { line: sp.line, ch: sp.ch - 1 };
  if (sp.ch > 0 && /[.!?]/.test(lc.charAt(sp.ch - 1)) && sp.ch > 1) {
    sp = { line: sp.line, ch: sp.ch - 2 };
  }

  dispatch(view, findSentenceStart(doc, sp), findSentenceEnd(doc, sp));
  return true;
}

/** Swap the current sentence with the next one. */
export function moveSentenceForward(view) {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
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

/** Swap the current sentence with the previous one. */
export function moveSentenceBack(view) {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
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
  if (startOff >= head && pos.line > 0) {
    const prevLine = pos.line - 1;
    const content = getLine(doc, prevLine);
    if (content.trim().length === 0) {
      startOff = posToOffset(doc, { line: prevLine, ch: 0 });
    } else {
      startOff = posToOffset(doc, findSentenceStart(doc, { line: prevLine, ch: content.length }));
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

// ===== Internal helpers =====

function dispatch(view, fromPos, toPos) {
  const doc = view.state.doc;
  view.dispatch({
    selection: EditorSelection.single(posToOffset(doc, fromPos), posToOffset(doc, toPos)),
  });
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
