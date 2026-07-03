/**
 * Shuffle Editor — source capture + write-back.
 *
 * The Shuffle Editor is a standalone mode (like Zen Focus) that works
 * across surfaces. This module resolves what to shuffle and how to commit
 * the result, keeping the lifecycle file (shuffle-editor.js) under the
 * repo's 700-line cap.
 *
 *   • Docs / panes / stacks — a non-empty CodeMirror selection; the chosen
 *     result writes back over that range as a single transaction.
 *   • Notebooks — the selected text shapes' bodies; the chosen result is
 *     dropped onto the canvas as a fresh text shape near the selection
 *     (originals untouched).
 */

import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { getActiveModeContext } from "../state/mode-context.js";
import { getCanvasInstance } from "../notebook/notebook-bridge.js";
import { panes, activePaneId } from "../pane/pane-state.js";

/** Resolve the source surface to shuffle. A focused doc surface (main
 *  editor, any floating pane, or stack column) with a live selection wins
 *  — even over a notebook canvas, since a doc pane can float above one.
 *  Falling back to a notebook's selected text shapes. Returns null when
 *  there's nothing to shuffle. */
export function captureAnyShufflePayload(state) {
  const doc = captureDocShufflePayload(state);
  if (doc) return doc;
  if (state.currentNotebookFileId) return captureNotebookShufflePayload();
  return null;
}

/** Doc surfaces: the first non-empty CodeMirror selection among the active
 *  mode context, every open pane (active one first), and — unless a
 *  notebook is the main surface — the main editor. Scanning all panes
 *  keeps it working even when the active-pane bookkeeping is stale (e.g.
 *  after the command palette took focus). */
function captureDocShufflePayload(state) {
  const seen = new Set();
  const candidates = [];
  const add = (v) => { if (v && !seen.has(v)) { seen.add(v); candidates.push(v); } };
  add(getActiveModeContext(state)?.view);
  if (activePaneId) add(panes.get(activePaneId)?.editor?.view);
  for (const [, p] of panes) add(p?.editor?.view);
  if (!state.currentNotebookFileId) add(state.editor?.view);
  for (const v of candidates) {
    try {
      const sel = v.state.selection.main;
      if (sel.empty) continue;
      const text = v.state.sliceDoc(sel.from, sel.to);
      if (!text.trim()) continue;
      const dom = v.contentDOM || v.dom;
      const rect = dom.getBoundingClientRect();
      const fontSizePx = parseFloat(getComputedStyle(dom).fontSize) || 16;
      return {
        kind: "doc",
        sourceView: v, from: sel.from, to: sel.to, text,
        columnWidth: Math.max(360, Math.round(rect.width)),
        fontSizePx,
      };
    } catch (_) { /* try next candidate */ }
  }
  return null;
}

/** Notebook surface: every selected text shape's body, joined. Write-back
 *  drops the result onto the canvas as a fresh text shape near the
 *  selection (originals untouched). */
function captureNotebookShufflePayload() {
  let st = null;
  try { st = getCanvasInstance()?.state || null; } catch (_) { st = null; }
  if (!st) return null;
  const selected = st.shapes.filter((s) => s.type === "text" && st.selectedIds.has(s.id));
  if (!selected.length) return null;
  const text = selected.map((s) => (s.text || "").trim()).filter(Boolean).join("\n\n");
  if (!text.trim()) return null;
  let minX = Infinity;
  let maxY = -Infinity;
  for (const s of selected) {
    if (!s.position) continue;
    minX = Math.min(minX, s.position.x);
    maxY = Math.max(maxY, s.position.y);
  }
  return {
    kind: "notebook",
    text,
    columnWidth: 600,
    fontSizePx: selected[0]?.fontSize || 16,
    nbState: st,
    nbPos: Number.isFinite(minX) ? { x: minX, y: maxY + 60 } : null,
  };
}

/** Palette gate — the Shuffle command only shows with something to shuffle. */
export function shuffleSelectionAvailable(state) {
  return !!captureAnyShufflePayload(state);
}

/** Commit the chosen result. Doc payloads write back over the original
 *  selection range as a single transaction; notebook payloads spawn a new
 *  text shape on the canvas. */
export function writeBackShuffle(payload, content) {
  if (payload.kind === "notebook") {
    try {
      if (payload.nbPos) payload.nbState.addTextShapeAtPosition(content, payload.nbPos);
      else payload.nbState.addTextShapeAtCenter(content);
    } catch (_) { /* canvas went away */ }
    return;
  }
  try {
    const src = payload.sourceView;
    if (!src || !src.state) return;
    // The captured offsets are only trustworthy if the doc still holds
    // the captured text there — the buffer can shift underneath a long
    // shuffle session (a sync pull, a pane mirror, a watcher reload).
    // Verify before replacing; blindly splicing at stale offsets is how
    // unrelated prose gets destroyed.
    const range = resolveWriteBackRange(src.state, payload);
    if (range.mode === "replace") {
      const caret = range.from + content.length;
      src.dispatch({
        changes: { from: range.from, to: range.to, insert: content },
        selection: EditorSelection.range(caret, caret),
      });
      src.dispatch({ effects: EditorView.scrollIntoView(caret, { y: "center" }) });
    } else {
      // Original text is nowhere to be found — insert the result at the
      // nearest safe point rather than deleting content that is no
      // longer what the user shuffled.
      const at = range.from;
      const insert = (at > 0 ? "\n\n" : "") + content;
      const caret = at + insert.length;
      src.dispatch({
        changes: { from: at, to: at, insert },
        selection: EditorSelection.range(caret, caret),
      });
      src.dispatch({ effects: EditorView.scrollIntoView(caret, { y: "center" }) });
    }
    src.focus();
  } catch (_) { /* source went away mid-shuffle */ }
}

/** Find where the shuffled text should land in the (possibly changed)
 *  source doc. Preference order: the captured range if it still holds
 *  the captured text; the text's unique new location if the range
 *  drifted; otherwise fall back to insert-only at the clamped offset. */
function resolveWriteBackRange(editorState, payload) {
  const docLen = editorState.doc.length;
  const from = Math.max(0, Math.min(payload.from, docLen));
  const to = Math.max(from, Math.min(payload.to, docLen));
  const original = payload.text;
  if (typeof original === "string" && original.length) {
    if (editorState.sliceDoc(from, to) === original) {
      return { mode: "replace", from, to };
    }
    // The doc moved under us — look for the captured text elsewhere.
    const doc = editorState.doc.toString();
    const first = doc.indexOf(original);
    if (first !== -1 && doc.indexOf(original, first + 1) === -1) {
      return { mode: "replace", from: first, to: first + original.length };
    }
  }
  return { mode: "insert", from: to };
}
