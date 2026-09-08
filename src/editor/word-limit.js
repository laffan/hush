/**
 * Word count limit — a per-document cap on how many words a doc holds.
 *
 * Set from the command palette ("Set word count limit"), stored on the
 * doc's tree node as `wordLimit` so it travels with the file, and
 * enforced on every doc surface: once the doc is at its cap a
 * transaction that would add words is refused, and a paste that would
 * overshoot lands truncated to the words that still fit. Nothing is
 * ever taken away — a cap set on a doc that is already longer than it
 * leaves the text alone and only refuses growth.
 *
 * Three pieces:
 *
 *   - **the store** — `getWordLimit` / `setWordLimit` read and write the
 *     tree node, the same per-doc metadata channel `lockedStyleId` uses,
 *     so the cap round-trips through `save_file_tree` and rides along
 *     when the desk folder syncs to another device.
 *   - **the filter** — one `transactionFilter` per surface. It counts
 *     with `countWords`, the very function the word-count pill shows, so
 *     "1,000 words" means the same thing in both places (comments,
 *     image markdown and `---%` regions don't count in either).
 *   - **the countdown** — a red pill at the bottom of the surface once
 *     the doc is within `COUNTDOWN_THRESHOLD` words of the cap.
 *
 * **Every doc surface has to carry this**, not just the main editor: a
 * floating pane or a stack column over a capped doc would otherwise be
 * the way around the cap — the same hazard `ratchet.js` calls out for
 * forward-only writing. Which document a surface is showing is not
 * something the extension can work out for itself (`state.currentFileId`
 * is the *main editor's* file, and a pane reading it would enforce the
 * wrong doc's cap), so every caller passes its own `getFileId`. A
 * surface that passes none is deliberately uncapped: the Selection
 * Focus fragment holds a slice of a document, and a whole-doc word
 * count can't be measured from a slice.
 */

import { EditorState, Transaction } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";
import { countWords } from "./plugins/word-count.js";
import { programmaticChange } from "./base-extensions.js";
import { typewriterRunwayAnnotation } from "./plugins/typewriter.js";
import { findNodeByFileId } from "../state/tree-helpers.js";
import { showImportToast } from "./import-toast.js";

/** How near the cap the countdown starts showing itself. */
export const COUNTDOWN_THRESHOLD = 10;

/**
 * Word counts memoised per `Text` instance. A cap means counting the
 * whole document on every insert, and the count of the document a
 * transaction starts from is the count we computed for the one the
 * previous transaction produced — the same immutable `Text` object, so
 * the sequential case costs one pass per edit rather than two.
 */
const countCache = new WeakMap();

/** `countWords` over a CodeMirror document, memoised. */
export function countWordsInDoc(doc) {
  let n = countCache.get(doc);
  if (n === undefined) {
    n = countWords(doc.toString());
    countCache.set(doc, n);
  }
  return n;
}

/** A stored limit as a usable number, or null for "no cap". Anything
 *  absent, zero, negative or unparseable reads as no cap. */
export function normalizeWordLimit(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The cap on `fileId`'s document, or null. */
export function getWordLimit(state, fileId) {
  if (!fileId || !state?.fileTree) return null;
  const node = findNodeByFileId(state.fileTree, fileId);
  return node ? normalizeWordLimit(node.wordLimit) : null;
}

/**
 * The document the palette commands act on: whatever plain doc the main
 * editor is showing. `currentFileId` is nulled for every other surface
 * (notebook, project, stack, PDF, Local Folder file), so this is also
 * the "can this be capped at all?" test — a project's joined buffer is
 * many documents at once, and a Local Folder file has no tree node to
 * carry the cap.
 */
export function wordLimitTargetFileId(state) {
  return state?.currentFileId || null;
}

/** The cap on the doc the main editor is showing, or null. */
export function currentWordLimit(state) {
  return getWordLimit(state, wordLimitTargetFileId(state));
}

/**
 * Set (or, with a null limit, clear) the cap on `fileId`'s tree node.
 * Written as `undefined` when cleared so the key drops out of the saved
 * tree entirely rather than persisting as a zero.
 */
export async function setWordLimit(state, fileId, limit) {
  if (!fileId || !state?.fileTree) return;
  const node = findNodeByFileId(state.fileTree, fileId);
  if (!node) return;
  const next = normalizeWordLimit(limit);
  node.wordLimit = next === null ? undefined : next;
  await state.saveFileTree();
  // Every surface showing this doc re-reads its cap: the countdown has
  // to appear (or go) without waiting for the next keystroke.
  state.emit("word-limit-changed", fileId);
}

// A refused or trimmed insert says so, once — a rate limit like the
// ratchet's, for the same reason: an operation that can't land should
// never just evaporate, and it shouldn't stack up notices either.
let lastNoticeAt = -Infinity;
const NOTICE_GAP_MS = 4000;

function notice(message) {
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  if (now - lastNoticeAt < NOTICE_GAP_MS) return;
  lastNoticeAt = now;
  // Deferred: this runs inside a transaction filter, and mounting DOM
  // mid-dispatch is asking for trouble.
  setTimeout(() => showImportToast(message), 0);
}

/**
 * The offsets in `text` a prefix can be cut at without splitting a word:
 * 0, the end of every run of non-whitespace, and the end of the string.
 */
function wordCuts(text) {
  const cuts = [0];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) cuts.push(m.index + m[0].length);
  if (cuts[cuts.length - 1] !== text.length) cuts.push(text.length);
  return cuts;
}

/**
 * The longest whole-word prefix of `insert` that keeps `head + prefix +
 * tail` inside `limit` words. Binary search over the cut points: the
 * count grows with the prefix, so the first cut that overshoots bounds
 * every cut after it.
 *
 * "Grows with the prefix" is true of prose and very nearly true of
 * everything else — a prefix that happens to close a `%%comment%%` or
 * open a `---%` region hides words rather than adding them, so the
 * search can settle one cut short of the theoretical best. It can never
 * settle one cut long: only a candidate measured at or under the limit
 * is ever returned.
 */
function fitWords(head, insert, tail, limit) {
  const cuts = wordCuts(insert);
  let lo = 0;
  let hi = cuts.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (countWords(head + insert.slice(0, cuts[mid]) + tail) <= limit) {
      best = cuts[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return insert.slice(0, best);
}

/**
 * Refuse — or trim — any transaction that would push the document past
 * its cap.
 */
function wordLimitFilter(state, limitOf) {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    // App-driven writes aren't the user adding words: a file load, a
    // sync pull, a version restore and a pane mirror all carry text
    // that already exists, and the typewriter runway is padding rather
    // than prose. Capping those would mean a doc that can't finish
    // loading itself.
    if (tr.annotation(programmaticChange)) return tr;
    if (tr.annotation(typewriterRunwayAnnotation)) return tr;
    const limit = limitOf();
    if (!limit) return tr;

    let changeCount = 0;
    let insertedLen = 0;
    let only = null;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, insert) => {
      changeCount++;
      insertedLen += insert.length;
      if (changeCount === 1) only = { from: fromA, to: toA, insert: insert.toString() };
    });
    // A pure deletion can only take the count down — never worth a pass
    // over the document to confirm it.
    if (insertedLen === 0) return tr;

    const after = countWordsInDoc(tr.newDoc);
    if (after <= limit) return tr;
    // Past the cap already: a doc can be over its limit (one set after
    // the writing, a version restored over it), and the rule is "no
    // more words", not "no more editing". An edit that doesn't grow the
    // count is the user working inside what they've already written.
    if (after <= countWordsInDoc(tr.startState.doc)) return tr;

    // More than one insertion point (multi-cursor typing, a replace-all)
    // has no single place to trim, so the whole transaction is refused.
    if (changeCount !== 1) {
      notice(`Word limit reached — ${limit.toLocaleString()} words.`);
      return [];
    }

    const startText = tr.startState.doc.toString();
    const head = startText.slice(0, only.from);
    const tail = startText.slice(only.to);
    const kept = fitWords(head, only.insert, tail, limit);
    // Nothing fits and nothing was being replaced: there is no
    // transaction left to run.
    if (!kept && only.from === only.to) {
      if (only.insert.length > 1) notice(`Word limit reached — ${limit.toLocaleString()} words.`);
      return [];
    }
    // A single typed character that didn't fit is refused in silence —
    // the countdown sitting at the bottom of the surface is already
    // saying why, and a toast per keystroke would be its own problem.
    if (only.insert.length > 1) {
      const fit = countWords(kept);
      notice(fit
        ? `Word limit: only ${fit.toLocaleString()} more ${fit === 1 ? "word" : "words"} fit.`
        : `Word limit reached — ${limit.toLocaleString()} words.`);
    }
    return {
      changes: { from: only.from, to: only.to, insert: kept },
      selection: { anchor: only.from + kept.length },
      // The filter rebuilds the transaction from this spec, so anything
      // it should still read as goes here — a trimmed paste is a paste.
      userEvent: tr.annotation(Transaction.userEvent) || undefined,
      scrollIntoView: true,
    };
  });
}

/** The countdown's wording, from how many words are left. */
function countdownLabel(remaining) {
  if (remaining > 0) return `${remaining.toLocaleString()} ${remaining === 1 ? "word" : "words"} left`;
  if (remaining === 0) return "Word limit reached";
  const over = -remaining;
  return `${over.toLocaleString()} ${over === 1 ? "word" : "words"} over limit`;
}

/**
 * The red countdown at the bottom of the surface, from
 * `COUNTDOWN_THRESHOLD` words out. It mounts into the editor's own
 * `.cm-editor` (position: relative, per CodeMirror's base theme) rather
 * than the window, so the pane or stack column showing a capped doc
 * carries its own countdown instead of the main window speaking for it.
 */
class WordLimitCountdown {
  constructor(view, state, limitOf) {
    this.view = view;
    this.state = state;
    this.limitOf = limitOf;
    this.el = null;
    // The cap can change with the document sitting still (the palette
    // command), and the main editor can be handed a different file.
    this.onRefresh = () => this.render();
    state.on("word-limit-changed", this.onRefresh);
    state.on("file-opened", this.onRefresh);
    this.render();
  }

  update(update) {
    if (update.docChanged) this.render();
  }

  destroy() {
    this.state.off("word-limit-changed", this.onRefresh);
    this.state.off("file-opened", this.onRefresh);
    this.clear();
  }

  clear() {
    if (this.el) { this.el.remove(); this.el = null; }
  }

  /** Write-only DOM: no layout reads, no dispatches — this runs inside
   *  `ViewPlugin.update`, where both are a hazard. */
  render() {
    const limit = this.limitOf();
    if (!limit) { this.clear(); return; }
    const remaining = limit - countWordsInDoc(this.view.state.doc);
    if (remaining > COUNTDOWN_THRESHOLD) { this.clear(); return; }
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "word-limit-countdown";
      this.view.dom.appendChild(this.el);
    }
    this.el.classList.toggle("at-limit", remaining <= 0);
    this.el.textContent = countdownLabel(remaining);
  }
}

/**
 * Build the word-limit extensions for one editing surface.
 *
 * `getFileId` names the document this surface is showing; a caller with
 * nothing to name (a fragment, a notebook) passes none and gets no
 * extensions at all, which is why this returns a list rather than
 * gating internally.
 */
export function createWordLimitExtensions(state, { getFileId } = {}) {
  if (typeof getFileId !== "function") return [];
  const limitOf = () => getWordLimit(state, getFileId());
  return [
    wordLimitFilter(state, limitOf),
    ViewPlugin.define((view) => new WordLimitCountdown(view, state, limitOf)),
  ];
}
