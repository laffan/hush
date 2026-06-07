/**
 * Comment anchors — CodeMirror ViewPlugin that visualises Google-Docs
 * comments imported into Hush.
 *
 * Source shape (see `editor/comment-syntax.js`):
 *
 *   inside the text {>it looks like<ab} more
 *   [>ab]: Jane Doe: interesting, i love this thought
 *
 * The plugin:
 *   - underlines the commented range (`{>...<id}`) with a margin-note tint,
 *   - hides the `{>` / `<id}` delimiters and drops a clickable bubble at
 *     the end of the range; clicking it pops the note over the text,
 *   - dims the `[>id]:` definition lines so the imported notes read as
 *     metadata rather than body copy.
 *
 * Raw syntax is revealed whenever the selection touches an anchor so the
 * markers stay directly editable — the same affordance the footnote
 * plugin uses for `[^id]`.
 */
import { ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import {
  COMMENT_ANCHOR_RE, COMMENT_DEF_RE, parseCommentDefinitions,
} from "../comment-syntax.js";

const COMMENT_COLOR = "#b8860b"; // amber — distinct from footnote dots

let _activeOverlay = null;

function closeOverlay() {
  if (_activeOverlay) { _activeOverlay.remove(); _activeOverlay = null; }
}

function showOverlay(anchorEl, note) {
  closeOverlay();
  const el = document.createElement("div");
  el.className = "comment-overlay";
  const close = document.createElement("button");
  close.className = "footnote-overlay-close";
  close.textContent = "×";
  close.addEventListener("mousedown", (e) => { e.preventDefault(); closeOverlay(); });
  const body = document.createElement("div");
  body.className = "comment-overlay-content";
  body.textContent = note || "(empty comment)";
  el.appendChild(close);
  el.appendChild(body);
  document.body.appendChild(el);
  const r = anchorEl.getBoundingClientRect();
  el.style.position = "fixed";
  el.style.left = Math.min(r.left, window.innerWidth - 320) + "px";
  el.style.top = (r.bottom + 6) + "px";
  el.style.maxWidth = "300px";
  _activeOverlay = el;
}

class CommentBubbleWidget extends WidgetType {
  constructor(id, note) { super(); this.id = id; this.note = note; }
  eq(other) { return this.id === other.id && this.note === other.note; }
  toDOM() {
    const b = document.createElement("span");
    b.className = "comment-bubble";
    b.title = this.note || `Comment ${this.id}`;
    b.style.color = COMMENT_COLOR;
    b.textContent = "\u{1F5E8}"; // 🗨 speech balloon
    const note = this.note;
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (_activeOverlay && _activeOverlay.dataset.id === this.id) { closeOverlay(); return; }
      showOverlay(b, note);
      if (_activeOverlay) _activeOverlay.dataset.id = this.id;
    });
    return b;
  }
  ignoreEvent() { return true; }
}

function buildDecorations(view) {
  const doc = view.state.doc;
  const text = doc.toString();
  const defs = parseCommentDefinitions(text);
  const sel = view.state.selection.ranges;
  const overlaps = (from, to) => sel.some((r) => r.from <= to && r.to >= from);

  // Gather (from, to, decoration) tuples, then sort — anchors and
  // definitions interleave by position so a single ordered pass into the
  // builder isn't guaranteed without sorting.
  const items = [];

  COMMENT_ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = COMMENT_ANCHOR_RE.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const id = m[2];
    const note = defs.get(id) || "";
    const openEnd = start + 2;                 // after `{>`
    const closeStart = end - (id.length + 2);  // before `<id}`
    if (overlaps(start, end)) continue;        // editing — show raw
    items.push({ from: start, to: openEnd, deco: Decoration.replace({}) });
    if (closeStart > openEnd) {
      items.push({
        from: openEnd, to: closeStart,
        deco: Decoration.mark({
          class: "comment-anchor",
          attributes: { title: note || `Comment ${id}` },
        }),
      });
    }
    items.push({
      from: closeStart, to: end,
      deco: Decoration.replace({ widget: new CommentBubbleWidget(id, note) }),
    });
  }

  // Dim the `[>id]:` definition lines (and their indented continuations).
  let inDef = false;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (COMMENT_DEF_RE.test(line.text)) inDef = true;
    else if (inDef && /^  \S/.test(line.text)) { /* continuation */ }
    else { inDef = false; continue; }
    if (line.from < line.to && !overlaps(line.from, line.to)) {
      items.push({
        from: line.from, to: line.from,
        deco: Decoration.line({ attributes: { class: "comment-def-line" } }),
      });
    }
  }

  items.sort((a, b) => (a.from - b.from) || (a.to - b.to));
  const builder = new RangeSetBuilder();
  for (const it of items) builder.add(it.from, it.to, it.deco);
  return builder.finish();
}

export function createCommentAnchorPlugin() {
  return ViewPlugin.fromClass(
    class {
      constructor(view) { this.decorations = buildDecorations(view); }
      update(update) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildDecorations(update.view);
        }
      }
      destroy() { closeOverlay(); }
    },
    { decorations: (v) => v.decorations }
  );
}
