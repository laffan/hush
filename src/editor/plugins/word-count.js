/**
 * Word count display — pill pinned at the top-center of the editor column.
 * Stacks directly below the ratchet timer when both are visible (same
 * styling, same anchor). Toggled via AppState.wordCountVisible.
 */

let wordCountEl = null;
let recomputeTimer = null;

function countWords(text) {
  if (!text) return 0;
  // Strip %% comments %% and inline image refs before counting — comments
  // are editorial notes, not prose, and image markdown isn't "words".
  const cleaned = text
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
  const n = countWords(text);
  wordCountEl.textContent = `${n.toLocaleString()} ${n === 1 ? "word" : "words"}`;
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
