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

/** Resolve the source surface to shuffle. A notebook with selected text
 *  shapes hands over their text; otherwise a doc / pane / stack hands over
 *  its active selection. Returns null when there's nothing to shuffle. */
export function captureAnyShufflePayload(state) {
  if (state.currentNotebookFileId) return captureNotebookShufflePayload();
  return captureDocShufflePayload(state);
}

/** Doc surfaces: a non-empty selection in the active mode context
 *  (focused pane / stack column) or the main editor. */
function captureDocShufflePayload(state) {
  const candidates = [];
  const ctx = getActiveModeContext(state);
  if (ctx?.view) candidates.push(ctx.view);
  if (state.editor?.view && !candidates.includes(state.editor.view)) {
    candidates.push(state.editor.view);
  }
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
    const docLen = src.state.doc.length;
    const from = Math.max(0, Math.min(payload.from, docLen));
    const to = Math.max(from, Math.min(payload.to, docLen));
    const caret = from + content.length;
    src.dispatch({
      changes: { from, to, insert: content },
      selection: EditorSelection.range(caret, caret),
    });
    src.dispatch({ effects: EditorView.scrollIntoView(caret, { y: "center" }) });
    src.focus();
  } catch (_) { /* source went away mid-shuffle */ }
}
