/**
 * Project view — CodeMirror extension for displaying multiple documents
 * as a single document with dashed separators between them.
 *
 * Separators are rendered as horizontal dashed lines and are protected
 * from editing via a transaction filter.
 *
 * Uses a StateField (not ViewPlugin) because block-level decorations
 * must be provided via EditorView.decorations.from(field).
 */

import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { EditorState, StateField, Annotation } from "@codemirror/state";

export const bypassSeparatorFilter = Annotation.define();

export const SEPARATOR = "\n\n---hush-separator---\n\n";
const SEPARATOR_LINE = "---hush-separator---";

// Widget that renders a dashed horizontal line
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

// StateField that provides block-level separator decorations
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

/**
 * Transaction filter that prevents editing separator lines.
 * Users cannot delete into or modify the separator text.
 */
export function createSeparatorFilter(state) {
  return EditorState.transactionFilter.of((tr) => {
    if (!state.currentProjectId) return tr;
    if (!tr.docChanged) return tr;
    if (tr.annotation(bypassSeparatorFilter)) return tr;

    // Check if any change touches a separator line
    let dominated = false;
    tr.changes.iterChanges((fromA, toA) => {
      const doc = tr.startState.doc;
      const fromLine = doc.lineAt(fromA);
      const toLine = doc.lineAt(Math.min(toA, doc.length));

      for (let i = fromLine.number; i <= toLine.number; i++) {
        const line = doc.line(i);
        if (line.text.trim() === SEPARATOR_LINE) {
          dominated = true;
        }
      }
    });

    if (dominated) return []; // Block the transaction
    return tr;
  });
}
