/**
 * Courier's append surface — the end of the target document with the
 * new text written straight after it, in a CodeMirror editor built from
 * the same `createBaseExtensions` every document surface uses, so the
 * markdown renders and edits exactly as it does in the document itself.
 *
 * The buffer is `tail + "\n\n" + message`. Everything before `boundary`
 * is the document as it stands: faded, and refused by a transaction
 * filter, so the only thing that can be written is what comes after it.
 * Because nothing before the boundary can change, the boundary and the
 * tail's line decorations never move and need no mapping.
 *
 * Not built as a `fragment`: this buffer ends where the document ends,
 * which is exactly how the ratchet reads a buffer's end — the writing
 * edge — so a ratcheted desk still lets a note be appended here, as it
 * would in the document.
 */

import { EditorView, Decoration, keymap } from "@codemirror/view";
import { EditorState, EditorSelection, Prec, RangeSetBuilder } from "@codemirror/state";
import { createBaseExtensions } from "../editor/base-extensions.js";
import { resolveCursorPaint, paintCursorMode } from "../editor/block-cursor.js";

/** How much of the document leads into the new text — enough to
 *  recognise where it lands. */
const TAIL_CHARS = 600;

/** The last stretch of a document, cut at a paragraph break and clear of
 *  its frontmatter (a slice of a document isn't one, and the properties
 *  plugin would read a stray `---` as a block). */
export function documentTail(text) {
  const body = (text || "").replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/\s+$/, "");
  if (body.length <= TAIL_CHARS) return { tail: body, clipped: false };
  const cut = body.lastIndexOf("\n\n", body.length - TAIL_CHARS);
  return { tail: body.slice(cut >= 0 ? cut + 2 : body.length - TAIL_CHARS), clipped: true };
}

function tailDecorations(state, boundary) {
  const b = new RangeSetBuilder();
  if (boundary === 0) return b.finish();
  const deco = Decoration.line({ class: "courier-tail-line" });
  const last = state.doc.lineAt(Math.max(0, boundary - 1)).number;
  for (let n = 1; n <= last; n++) b.add(state.doc.line(n).from, state.doc.line(n).from, deco);
  return b.finish();
}

/**
 * Mount the editor into `host`. `onSend` runs on ⌘↩ / Ctrl↩ (taken at
 * the highest precedence — the default keymap would otherwise insert a
 * blank line first). Returns `{ view, getMessage, focus, destroy }`.
 */
export function mountAppendEditor(state, host, { existing, message = "", clipped = false, onInput, onSend }) {
  const tail = existing;
  const boundary = tail ? tail.length + 2 : 0;
  const doc = (tail ? tail + "\n\n" : "") + message;

  const guard = EditorState.transactionFilter.of((tr) => {
    if (tr.docChanged) {
      let touchesTail = false;
      tr.changes.iterChangedRanges((fromA) => { if (fromA < boundary) touchesTail = true; });
      return touchesTail ? [] : tr;
    }
    // A caret parked in the tail would type into nothing — keep it on
    // the writing side. Ranged selections are left alone, so the tail
    // can still be selected and copied.
    const sel = tr.selection?.main;
    if (sel && sel.empty && sel.head < boundary) {
      return [tr, { selection: EditorSelection.cursor(boundary), sequential: true }];
    }
    return tr;
  });

  const { extensions } = createBaseExtensions(state, () => onInput?.());
  const probe = EditorState.create({ doc });
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: [
        Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => { onSend?.(); return true; } }])),
        extensions,
        guard,
        EditorView.decorations.of(tailDecorations(probe, boundary)),
        EditorView.editorAttributes.of({ class: clipped ? "courier-tail-clipped" : "" }),
      ],
    }),
  });

  // Same caret and text colour the document surfaces wear.
  paintCursorMode(host, resolveCursorPaint(state.settings));
  const styleFg = getComputedStyle(document.documentElement).getPropertyValue("--style-fg").trim();
  if (styleFg) view.dom.style.color = styleFg;

  // Land at the writing edge. The scroll effect, not coordsAtPos —
  // the latter no-ops outside the rendered viewport.
  view.dispatch({ effects: EditorView.scrollIntoView(doc.length, { y: "end" }) });

  return {
    view,
    getMessage: () => view.state.sliceDoc(boundary),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
