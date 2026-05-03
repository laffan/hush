/**
 * Project view — CodeMirror extension for displaying multiple documents
 * as a single document with dashed separators between them.
 *
 * Separators are rendered as a block-level dashed widget that fully
 * replaces the marker line, and are protected from any edit that would
 * change how many separator lines exist in the affected range — so users
 * can neither delete an existing separator nor type a new one.
 */

import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { EditorState, StateField, Annotation } from "@codemirror/state";

export const bypassSeparatorFilter = Annotation.define();

// One newline on each side: the marker's own line-break boundaries also
// double as the join boundaries between docs, so removing either \n
// touches the separator line and is rejected by the filter below.
export const SEPARATOR = "\n---hush-separator---\n";
const SEPARATOR_LINE = "---hush-separator---";

class SeparatorWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("div");
    el.className = "project-separator";
    el.setAttribute("contenteditable", "false");
    return el;
  }

  ignoreEvent() {
    return true;
  }
}

function buildDecorations(editorState, appState) {
  if (!appState.currentProjectId) return Decoration.none;

  const builder = [];
  const doc = editorState.doc;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (line.text.trim() === SEPARATOR_LINE) {
      builder.push(
        Decoration.replace({
          widget: new SeparatorWidget(),
          block: true,
        }).range(line.from, line.to)
      );
    }
  }

  return Decoration.set(builder);
}

export function createProjectViewField(state) {
  return StateField.define({
    create(editorState) {
      return buildDecorations(editorState, state);
    },
    update(value, tr) {
      if (!tr.docChanged) return value;
      return buildDecorations(tr.state, state);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

function countSeparatorsInRange(doc, from, to) {
  if (doc.length === 0) return 0;
  const clampedFrom = Math.max(0, Math.min(from, doc.length));
  const clampedTo = Math.max(0, Math.min(to, doc.length));
  const fromLine = doc.lineAt(clampedFrom).number;
  const toLine = doc.lineAt(clampedTo).number;
  let n = 0;
  for (let i = fromLine; i <= toLine; i++) {
    if (doc.line(i).text.trim() === SEPARATOR_LINE) n++;
  }
  return n;
}

/**
 * Block any transaction that would change the number of separator lines
 * in the affected range — covers both deleting existing separators and
 * typing/pasting a new `---hush-separator---` line.
 */
export function createSeparatorFilter(state) {
  return EditorState.transactionFilter.of((tr) => {
    if (!state.currentProjectId) return tr;
    if (!tr.docChanged) return tr;
    if (tr.annotation(bypassSeparatorFilter)) return tr;

    let blocked = false;
    tr.changes.iterChanges((fromA, toA, fromB, toB) => {
      if (blocked) return;
      const oldCount = countSeparatorsInRange(tr.startState.doc, fromA, toA);
      const newCount = countSeparatorsInRange(tr.state.doc, fromB, toB);
      if (oldCount !== newCount) blocked = true;
    });

    if (blocked) return [];
    return tr;
  });
}
