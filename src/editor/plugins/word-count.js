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
  // end of the document in the editor (see comment-plugins.js). Mirror
  // that: drop the dimmed region before any other stripping so a `---%`
  // sitting inside a multi-line comment is treated the same as the
  // editor does. In project mode the joined buffer concatenates multiple
  // docs separated by `---hush-separator---`; `---%` only dims through
  // to the next separator, so split per segment and trim each.
  let cleaned = (text.includes("---hush-separator---")
      ? text.split(/(?=^---hush-separator---$)/m)
      : [text])
    .map((seg) => {
      const m = seg.match(/(^|\n)[^\n]*---%/);
      return m ? seg.slice(0, m.index + (m[1] ? 1 : 0)) : seg;
    })
    .join("");
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
    // Pill stays click-through (`pointer-events: none`) at all times so
    // editor drag-selects pass straight through. Selection counts are
    // surfaced automatically — no hover required.
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
  const showSel = hasNonEmptySelection(state);

  const total = countWords(text);
  const inProject = !!state.currentProjectId && text.includes("---hush-separator---");

  // Project mode: show "<n> section / <n> total". Section = the slice
  // of the joined buffer between the separators surrounding the
  // cursor. With a selection, "<n> selected" appends after total.
  if (inProject) {
    const cursor = getProjectCursorPos(state);
    if (cursor != null) {
      const section = countWords(sliceProjectSegmentAt(text, cursor));
      const parts = showSel
        ? [[section, "section"], [total, "total"], [countWords(getSelectionText(state)), "selected"]]
        : [[section, "section"], [total, "total"]];
      wordCountEl.textContent = formatCounts(parts);
      return;
    }
    // Cursor wasn't locatable — fall through to the non-project format.
  }

  // Non-project: "<n> words" alone, or "<n> words / <n> selected"
  // when a selection is active.
  const parts = showSel
    ? [[total, total === 1 ? "word" : "words"], [countWords(getSelectionText(state)), "selected"]]
    : [[total, total === 1 ? "word" : "words"]];
  wordCountEl.textContent = formatCounts(parts);
}

/** Render `[[count, label], …]` as `"a label / b label / c label"`. */
function formatCounts(parts) {
  return parts.map(([n, label]) => `${n.toLocaleString()} ${label}`).join(" / ");
}

function hasNonEmptySelection(state) {
  try {
    const view = state.editor?.view;
    if (!view) return false;
    const sel = view.state.selection.main;
    return sel.from !== sel.to;
  } catch (_) {
    return false;
  }
}

function getSelectionText(state) {
  try {
    const view = state.editor?.view;
    if (!view) return "";
    const sel = view.state.selection.main;
    return view.state.doc.sliceString(sel.from, sel.to);
  } catch (_) {
    return "";
  }
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
