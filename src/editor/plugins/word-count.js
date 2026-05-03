/**
 * Word count display — pill pinned at the top-center of the editor column.
 * Stacks directly below the ratchet timer when both are visible (same
 * styling, same anchor). Toggled via AppState.wordCountVisible.
 */

let wordCountEl = null;
let recomputeTimer = null;

export function countWords(text) {
  if (!text) return 0;
  // The `---%` marker dims everything from the start of its line to the
  // end of the document in the editor (see comment-plugins.js).
  // Mirror that: anything past the marker is editorial gray-out, not
  // prose. Slice it off before any other stripping so a `---%` sitting
  // inside a multi-line comment is treated the same as the editor does.
  let cleaned = text;
  const tailMatch = cleaned.match(/(^|\n)[^\n]*---%/);
  if (tailMatch) {
    cleaned = cleaned.slice(0, tailMatch.index + (tailMatch[1] ? 1 : 0));
  }
  // Strip %% comments %% and inline image refs before counting — comments
  // are editorial notes, not prose, and image markdown isn't "words".
  cleaned = cleaned
    .replace(/%%[\s\S]*?%%/g, " ")
    .replace(/!\[[^\]]*\]\(\s*(?:"[^"]+"|[^()\s"]+)(?:\s+"[^"]*")?\s*\)/g, " ")
    .replace(/---hush-separator---/g, " ");
  const words = cleaned.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

export function isWordCountVisible(state) {
  return !!state.settings?.wordCountVisible;
}

/** Mount or unmount the pill based on `state.settings.wordCountVisible`. */
export function updateWordCountDisplay(state) {
  const visible = isWordCountVisible(state);
  if (!visible) {
    if (wordCountEl) { wordCountEl.remove(); wordCountEl = null; }
    document.body.classList.remove("word-count-active");
    return;
  }
  if (!wordCountEl) {
    wordCountEl = document.createElement("div");
    wordCountEl.id = "word-count-display";
    wordCountEl.className = "word-count-display";
    document.body.appendChild(wordCountEl);
  }
  document.body.classList.add("word-count-active");
  // Stack below the ratchet timer when both are visible
  wordCountEl.classList.toggle("stacked", !!state.ratchetMode);
  recompute(state);
}

function recompute(state) {
  if (!wordCountEl) return;
  let text = "";
  if (state.editor && state.editor.getContent) {
    text = state.editor.getContent();
  }
  // In project mode the editor holds every doc joined by
  // `---hush-separator---`. Show two counts: the doc the cursor is
  // inside / the entire project. Slip back to the single-count form
  // when the cursor isn't locatable (no view, no selection).
  if (state.currentProjectId && text.includes("---hush-separator---")) {
    const total = countWords(text);
    const cursor = getProjectCursorPos(state);
    if (cursor != null) {
      const segment = sliceProjectSegmentAt(text, cursor);
      const current = countWords(segment);
      wordCountEl.textContent = `${current.toLocaleString()} / ${total.toLocaleString()} ${total === 1 ? "word" : "words"}`;
      return;
    }
  }
  const n = countWords(text);
  wordCountEl.textContent = `${n.toLocaleString()} ${n === 1 ? "word" : "words"}`;
}

function getProjectCursorPos(state) {
  try {
    const view = state.editor?.view;
    if (!view) return null;
    return view.state.selection.main.head;
  } catch (_) {
    return null;
  }
}

/** Return the slice of the joined project buffer that surrounds `pos`,
 *  i.e. the text between the nearest preceding and following separator
 *  lines (or document edges). */
function sliceProjectSegmentAt(text, pos) {
  const sep = "---hush-separator---";
  let start = 0;
  let idx = text.indexOf(sep);
  while (idx !== -1 && idx < pos) {
    start = idx + sep.length;
    idx = text.indexOf(sep, start);
  }
  const end = idx === -1 ? text.length : idx;
  return text.slice(start, end);
}

/** Call on every doc change to update the pill (debounced). */
export function scheduleWordCountRecompute(state) {
  if (!isWordCountVisible(state)) return;
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(() => recompute(state), 120);
}

/** Toggle command handler — flips the setting and re-applies the display. */
export function toggleWordCount(state) {
  const next = !isWordCountVisible(state);
  state.updateSettings({ wordCountVisible: next });
  updateWordCountDisplay(state);
  return true;
}
