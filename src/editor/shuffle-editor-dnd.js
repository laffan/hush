/**
 * Shuffle Editor — pure helpers shared by the lifecycle module.
 *
 * Sentence tokenizing, capitalization / combining rules, and a small
 * pointer drag-gesture utility (threshold-based click-vs-drag). The
 * Shuffle Editor models every sentence — in the centre column or the
 * margins — as the same kind of node, so there's no CodeMirror-specific
 * code here any more.
 */

const DRAG_THRESHOLD = 5; // px of pointer travel before a press becomes a drag

/* ===== Capitalization + combining ===== */

/** Capitalize the first alphabetic character, leaving the rest as-is. */
export function capitalizeFirst(str) {
  const s = String(str || "");
  const i = s.search(/[a-zA-Z]/);
  if (i === -1) return s;
  return s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1);
}

/** Lowercase the first alphabetic character — used when a sentence is
 *  merged onto another and becomes a continuing clause. */
function lowerFirst(str) {
  const s = String(str || "");
  const i = s.search(/[a-zA-Z]/);
  if (i === -1) return s;
  return s.slice(0, i) + s[i].toLowerCase() + s.slice(i + 1);
}

/** Drop a trailing run of concluding punctuation (+ any closing
 *  quotes/markup) from the end of a sentence. */
function stripTrailingPunct(str) {
  return String(str || "").replace(/[.!?]+["')\]}*_`]*\s*$/, "").trimEnd();
}

/** Merge `follower` onto the end of `target`: the target's concluding
 *  punctuation is removed and the follower joins as a continuing clause. */
export function combineInto(targetText, followerText) {
  const base = stripTrailingPunct(targetText);
  const tail = lowerFirst(String(followerText || "").trim());
  return `${base} ${tail}`.trim();
}

/* ===== Sentence tokenizing ===== */

/** Split prose into sentence strings. A `.!?` followed by optional
 *  closing quotes/markup then whitespace (or end-of-line) ends a
 *  sentence. Blank lines are skipped; each non-empty line yields at
 *  least one sentence. */
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

/* ===== Drag gesture ===== */

/** Wire a threshold-based drag off an initial mousedown event. `onClick`
 *  fires when the press never travels past the threshold; otherwise
 *  `onBegin` fires once, `onMove` on every move, and `onDrop` on release.
 *  Caller is responsible for any preventDefault on the originating event. */
export function startDragGesture(startEvent, handlers) {
  const startX = startEvent.clientX;
  const startY = startEvent.clientY;
  let dragging = false;

  const onMove = (e) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
      dragging = true;
      handlers.onBegin && handlers.onBegin(e);
    }
    handlers.onMove && handlers.onMove(e);
  };
  const onUp = (e) => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (dragging) handlers.onDrop && handlers.onDrop(e);
    else handlers.onClick && handlers.onClick(e);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
