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

/** Drop the concluding punctuation from the end of a sentence while
 *  preserving any trailing closing quotes / brackets — so a quoted
 *  sentence like `He said "hello."` becomes `He said "hello"` (the period
 *  goes, the quote stays) rather than losing its closing quote. */
function stripTrailingPunct(str) {
  let s = String(str || "").trimEnd();
  const closers = (s.match(/[")'’”»\]}*_`]+$/) || [""])[0];
  let core = closers ? s.slice(0, s.length - closers.length) : s;
  core = core.replace(/[.!?]+$/, "");
  return (core + closers).trimEnd();
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
        while (j < line.length && /["')\]}*_`’”»]/.test(line[j])) j++;
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

/* ===== Presentation helpers (kept here so the lifecycle file stays under
 *       the 700-line cap) ===== */

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

const TOOLBAR_ICONS = {
  shuffle: '<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>',
  done: '<path d="M20 6 9 17l-5-5"/>',
  cancel: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

function iconBtn(name, title, extraClass) {
  const b = el("button", `shuffle-editor-btn ${extraClass}`);
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${TOOLBAR_ICONS[name]}</svg>`;
  return b;
}

/** The bottom toolbar: Shuffle pinned left, Cancel + Done right. */
export function buildToolbar() {
  const wrap = el("div", "shuffle-editor-toolbar");
  const shuffleBtn = iconBtn("shuffle", "Shuffle the margin sentences", "shuffle-editor-shuffle");
  const right = el("div", "shuffle-editor-toolbar-right");
  const cancelBtn = iconBtn("cancel", "Cancel — discard changes", "shuffle-editor-cancel");
  const doneBtn = iconBtn("done", "Done — choose a version", "shuffle-editor-done");
  right.appendChild(cancelBtn);
  right.appendChild(doneBtn);
  wrap.appendChild(shuffleBtn);
  wrap.appendChild(right);
  return { el: wrap, shuffleBtn, cancelBtn, doneBtn };
}

/** Best-effort caret placement at a client point inside a contenteditable;
 *  falls back to the end of the node. */
export function placeCaretAtPoint(node_el, cx, cy) {
  const sel = window.getSelection();
  let range = null;
  if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(cx, cy);
  else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(cx, cy);
    if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); }
  }
  sel.removeAllRanges();
  if (range && node_el.contains(range.startContainer)) {
    range.collapse(true);
    sel.addRange(range);
  } else {
    const r = document.createRange();
    r.selectNodeContents(node_el);
    r.collapse(false);
    sel.addRange(r);
  }
}

/** A synthetic event positioned at a node's centre — used to seed caret
 *  placement when a node is created (rather than clicked). */
export function fakeCenterEvent(node_el) {
  const r = node_el.getBoundingClientRect();
  return { clientX: r.left + 12, clientY: r.top + r.height / 2 };
}

function rectsOverlap(p, q, pad) {
  return !(p.x + p.w + pad <= q.x || q.x + q.w + pad <= p.x ||
           p.y + p.h + pad <= q.y || q.y + q.h + pad <= p.y);
}

/** Pick a scattered position somewhere around the margins (either gutter,
 *  anywhere down the canvas) that avoids overlapping the existing chips.
 *  `geo`: { canvasW, canvasH, colLeft, colRight, chipW, gap, existing,
 *  estH }. Tries random candidates, returns the first clash-free one (or
 *  the least-overlapping fallback). */
export function findFreeMarginSpot(geo) {
  const estH = geo.estH || 64;
  const gutters = [];
  const leftMax = geo.colLeft - geo.chipW - geo.gap;
  if (leftMax >= 8) gutters.push([8, leftMax]);
  const rightMin = geo.colRight + geo.gap;
  const rightMax = geo.canvasW - geo.chipW - 8;
  if (rightMax >= rightMin) gutters.push([rightMin, rightMax]);
  if (!gutters.length) gutters.push([8, Math.max(8, geo.canvasW - geo.chipW - 8)]);
  const yMax = Math.max(24, geo.canvasH - estH - 24);
  let best = null;
  let bestScore = Infinity;
  for (let i = 0; i < 60; i++) {
    const [lo, hi] = gutters[Math.floor(Math.random() * gutters.length)];
    const x = lo + Math.random() * Math.max(0, hi - lo);
    const y = 24 + Math.random() * Math.max(0, yMax - 24);
    const cand = { x, y, w: geo.chipW, h: estH };
    let score = 0;
    for (const r of geo.existing) if (rectsOverlap(cand, r, 8)) score++;
    if (score === 0) return { x, y };
    if (score < bestScore) { bestScore = score; best = cand; }
  }
  return best ? { x: best.x, y: best.y } : { x: gutters[0][0], y: 24 };
}

/** Build the close-time compare modal (original vs shuffled). Returns the
 *  backdrop element; the caller mounts it and tracks it for dismissal. */
export function buildCompareModal(originalText, newText, handlers) {
  const back = el("div", "shuffle-compare-backdrop");
  const modal = el("div", "shuffle-compare-modal");
  modal.innerHTML = `
    <div class="shuffle-compare-cols">
      <div class="shuffle-compare-col">
        <div class="shuffle-compare-label">Original</div>
        <div class="shuffle-compare-text" data-role="original"></div>
      </div>
      <div class="shuffle-compare-col">
        <div class="shuffle-compare-label">Shuffled</div>
        <div class="shuffle-compare-text" data-role="shuffled"></div>
      </div>
    </div>
    <div class="shuffle-compare-btns">
      <button class="shuffle-compare-cancel">Cancel</button>
      <button class="shuffle-compare-keep-original">Keep Original</button>
      <button class="shuffle-compare-keep-shuffled">Keep Shuffled</button>
    </div>`;
  modal.querySelector('[data-role="original"]').textContent = originalText;
  modal.querySelector('[data-role="shuffled"]').textContent = newText || "(empty)";
  back.appendChild(modal);
  modal.querySelector(".shuffle-compare-cancel").addEventListener("click", handlers.onCancel);
  modal.querySelector(".shuffle-compare-keep-original").addEventListener("click", handlers.onKeepOriginal);
  modal.querySelector(".shuffle-compare-keep-shuffled").addEventListener("click", handlers.onKeepShuffled);
  return back;
}
