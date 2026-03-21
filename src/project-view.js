/**
 * Project view — CodeMirror plugin for displaying multiple documents
 * as a single document with dashed separators between them.
 *
 * Separators are rendered as horizontal dashed lines and are protected
 * from editing via a transaction filter.
 */

import { ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { EditorState, StateField, StateEffect } from "@codemirror/state";

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

// ViewPlugin that finds separator lines and decorates them
export function createProjectViewPlugin(state) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.buildDecorations(view, state);
      }

      update(update) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view, state);
        }
      }

      buildDecorations(view, appState) {
        if (!appState.currentProjectId) return Decoration.none;

        const builder = [];
        const doc = view.state.doc;

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
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}

/**
 * Transaction filter that prevents editing separator lines.
 * Users cannot delete into or modify the separator text.
 */
export function createSeparatorFilter(state) {
  return EditorState.transactionFilter.of((tr) => {
    if (!state.currentProjectId) return tr;
    if (!tr.docChanged) return tr;

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
