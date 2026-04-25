/**
 * Markdown task-list decorator — renders `- [ ]` / `- [x]` (and `*`/`+`
 * variants) as an inline checkbox widget. Clicking the widget toggles
 * the underlying text between `[ ]` and `[x]`.
 *
 * The widget replaces the `[ ]` portion only (not the leading `- `) so
 * the list-marker dimming and hang-indent logic in headingIndentPlugin
 * keeps working — the only thing the user sees in place of the brackets
 * is a tappable checkbox glyph.
 */
import { ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

const TASK_RE = /^(\s*)([-*+])(\s+)(\[[ xX]\])(\s+)/;

class TaskCheckboxWidget extends WidgetType {
  constructor(checked, from, to) {
    super();
    this.checked = checked;
    this.from = from;
    this.to = to;
  }

  eq(other) {
    return this.checked === other.checked && this.from === other.from && this.to === other.to;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-task-checkbox" + (this.checked ? " checked" : "");
    span.setAttribute("role", "checkbox");
    span.setAttribute("aria-checked", this.checked ? "true" : "false");
    span.dataset.taskFrom = String(this.from);
    span.dataset.taskTo = String(this.to);
    span.dataset.taskChecked = this.checked ? "1" : "0";
    return span;
  }

  ignoreEvent() { return false; }
}

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  const cursors = view.state.selection.ranges.map(r => ({
    from: Math.min(r.from, r.to),
    to: Math.max(r.from, r.to),
  }));
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = line.text.match(TASK_RE);
    if (!m) continue;
    const indent = m[1].length;
    const markerLen = m[2].length;
    const space1 = m[3].length;
    const bracket = m[4];
    const checked = bracket[1] !== " ";
    const bracketStart = line.from + indent + markerLen + space1;
    const bracketEnd = bracketStart + 4; // "[?]" is always 3 chars + the space after

    // If a cursor is inside the bracket area, leave the raw `[ ]`
    // visible so the user can edit it directly. Mirrors the way
    // link-decorator and heading markers behave.
    const cursorInside = cursors.some(c =>
      (c.from >= bracketStart && c.from <= bracketEnd) ||
      (c.to >= bracketStart && c.to <= bracketEnd)
    );
    if (cursorInside) continue;

    builder.add(
      bracketStart,
      bracketStart + 3, /* the `[?]` only — keep the trailing space as text so it spaces the next word */
      Decoration.replace({ widget: new TaskCheckboxWidget(checked, bracketStart, bracketStart + 3) }),
    );
  }
  return builder.finish();
}

/** Toggle the task at the given doc range between `[ ]` and `[x]`. */
function toggleTask(view, from, to) {
  const cur = view.state.doc.sliceString(from, to);
  const next = /\[ \]/.test(cur) ? "[x]" : "[ ]";
  view.dispatch({ changes: { from, to, insert: next } });
}

export function createCheckboxListPlugin() {
  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildDecorations(view);
      }
      update(update) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(e, view) {
          const target = e.target?.closest?.(".cm-task-checkbox");
          if (!target) return false;
          e.preventDefault();
          const from = parseInt(target.dataset.taskFrom, 10);
          const to = parseInt(target.dataset.taskTo, 10);
          if (Number.isFinite(from) && Number.isFinite(to)) toggleTask(view, from, to);
          return true;
        },
      },
    },
  );
  return plugin;
}
