/**
 * The pinned outline's editor.
 *
 * A pinned outline leaves the text — its lines collapse out of the
 * document (CodeMirror only renders the lines near the scroll position,
 * so nothing left in the document could stay on screen) — and is shown
 * in a panel docked to the bottom of its frame. The panel holds a real
 * CodeMirror editor built by `createPaneEditor`, from the same extension
 * list every doc surface uses, whose document is the pinned block's
 * lines and nothing else. That is what makes working on a pinned outline
 * the same as working on one in the text: the checkboxes, Alt-Arrow,
 * ⌘[ / ⌘], formatting, the drag grip, hide-completed and undo are not
 * re-implemented here, they are the same code running on the same lines.
 *
 * The two stay one document:
 *
 *   - **Panel → document.** Each edit is replayed onto the host editor at
 *     the block's offset, as the user's own edit (so it is saved, and the
 *     host's filters — ratchet, the word cap — still have their say), but
 *     outside the host's undo history: the panel keeps its own, the way a
 *     pane does. Replays are gathered and sent on a microtask, because an
 *     editor may not be dispatched to from inside another's update.
 *   - **Document → panel.** Whenever the host's document changes, the
 *     block is read back and, if it differs from the panel's (the host
 *     refused or reshaped an edit, a sync pull, an undo in the host), the
 *     panel takes it as a minimal programmatic diff, which keeps its caret
 *     and stays out of its history.
 *
 * One rule the in-flow outline doesn't have: every line of the panel has
 * to stay a checklist item. A line that stopped being one would split the
 * block in the document — the pin names a block by its place among the
 * document's outlines — and everything after it would drop out of the
 * panel into the text. Such an edit is refused.
 */

import { EditorView } from "@codemirror/view";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { createPaneEditor } from "../pane/pane-editor.js";
import { programmaticChange } from "./base-extensions.js";
import { parseOutlineLine } from "../outline/outline-model.ts";
import { outlineHost } from "./plugins/outline-view.js";

/** Refuse an edit that would leave any line of the panel not a checklist
 *  item. Only the lines a change touched are checked. */
const keepChecklist = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(programmaticChange)) return tr;
  const doc = tr.newDoc;
  let ok = true;
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (!ok) return;
    const first = doc.lineAt(fromB).number;
    const last = doc.lineAt(toB).number;
    for (let n = first; n <= last && ok; n++) ok = !!parseOutlineLine(doc.line(n).text, n);
  });
  return ok ? tr : [];
});

/**
 * @param {object} o
 * @param {HTMLElement} o.parent       Where the editor mounts.
 * @param {object} o.appState
 * @param {import("@codemirror/view").EditorView} o.hostView
 * @param {() => ({ from: number, to: number } | null)} o.getRange
 *   The pinned block's span in the host document, as it stands now.
 * @param {boolean} o.hideDone
 */
export function createPinnedOutlineEditor(o) {
  const { hostView, getRange, appState } = o;
  const hostComp = new Compartment();
  /** Panel edits not yet replayed onto the host, composed. They are
   *  relative to the panel's document at the last replay — which is the
   *  host block's text at that moment. */
  let pending = null;
  let scheduled = false;
  let destroyed = false;

  const flush = () => {
    scheduled = false;
    const changes = pending;
    pending = null;
    if (!changes || destroyed) return;
    const range = getRange();
    if (!range || range.to - range.from !== changes.length) {
      // The block moved under us in a way the replay can't be mapped
      // through. The document is the truth; take it back.
      resync();
      return;
    }
    const spec = [];
    changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      spec.push({ from: range.from + fromA, to: range.from + toA, insert: inserted.toString() });
    });
    hostView.dispatch({
      changes: spec,
      annotations: [Transaction.addToHistory.of(false), Transaction.userEvent.of("input.outline")],
    });
    // A host filter may have refused or trimmed the edit; the host's
    // update schedules `sync`, which reconciles either way.
  };

  const replay = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (update.transactions.some((tr) => tr.annotation(programmaticChange))) return;
    pending = pending ? pending.compose(update.changes) : update.changes;
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  });

  // No typewriter in the panel — it is a few lines tall and has no page
  // to hold a line in the middle of. Every other mode is the host's.
  const modeContext = Object.create(appState);
  modeContext.typewriterMode = false;

  // No line indicator either: it marks the line being written in the
  // text, and the panel is the outline, not the text.
  const editor = createPaneEditor(o.parent, appState, null, {
    modeContext,
    fragment: true,
    lineIndicator: false,
    extraExtensions: [
      hostComp.of(outlineHost.of({ hideDone: !!o.hideDone })),
      keepChecklist,
      replay,
    ],
  });
  editor.reconfigureTheme(appState.settings, null);

  const range0 = getRange();
  if (range0) editor.setContent(hostView.state.doc.sliceString(range0.from, range0.to));

  /** Take the host's block as the panel's document. */
  function resync() {
    if (destroyed) return;
    const range = getRange();
    if (!range) return;
    editor.setContent(hostView.state.doc.sliceString(range.from, range.to));
  }

  const onTheme = () => { if (!destroyed) editor.reconfigureTheme(appState.settings, null); };
  appState.on?.("theme-changed", onTheme);
  appState.on?.("style-changed", onTheme);
  appState.on?.("style-preview-end", onTheme);

  return {
    view: editor.view,
    /** The host's document changed: send anything still queued, then
     *  take the block back if the two disagree. */
    sync() {
      if (destroyed) return;
      if (pending) flush();
      resync();
    },
    setHideDone(hideDone) {
      if (destroyed) return;
      editor.view.dispatch({ effects: hostComp.reconfigure(outlineHost.of({ hideDone: !!hideDone })) });
    },
    destroy() {
      if (destroyed) return;
      if (pending) flush();
      destroyed = true;
      appState.off?.("theme-changed", onTheme);
      appState.off?.("style-changed", onTheme);
      appState.off?.("style-preview-end", onTheme);
      editor.destroy();
    },
  };
}
