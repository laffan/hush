/**
 * Comment anchors — CodeMirror ViewPlugin that visualises Google-Docs
 * comments imported into Hush.
 *
 * Source shape (see `editor/comment-syntax.js`):
 *
 *   inside the text {>it looks like<ab} more
 *   [>ab]: Jane Doe: interesting, i love this thought %%cmnt id=AAAB123%%
 *
 * While scrolling (cursor outside a comment) the reader sees only the
 * tinted commented range and a 🗨 bubble — every delimiter (`{>`, `<id}`)
 * and the entire `[>id]:` definition block are hidden. Clicking the bubble
 * opens the note in an editable popover with a Resolve button. Raw syntax
 * is revealed whenever the selection touches an anchor or definition so
 * everything stays directly editable as a fallback.
 *
 * The note text and resolved state are written back into the `[>id]:`
 * definition; resolving is applied to Google on the next push (see
 * `google-docs/comments-sync.js`).
 */
import { ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import {
  COMMENT_ANCHOR_RE, COMMENT_DEF_RE,
  parseCommentDefinitions, parseCommentMeta, formatCommentMeta,
} from "../comment-syntax.js";

const COMMENT_COLOR = "#b8860b"; // amber — distinct from footnote dots

// ───────────────────── overlay ─────────────────────

let _activeOverlay = null;
let _outsideHandler = null;

function closeOverlay() {
  if (_outsideHandler) {
    document.removeEventListener("mousedown", _outsideHandler, true);
    _outsideHandler = null;
  }
  if (_activeOverlay) { _activeOverlay.remove(); _activeOverlay = null; }
}

// Locate the `[>id]:` definition (plus indented continuations) in the doc.
// Returns the line range to rewrite and the parsed note/metadata.
function locateDef(doc, id) {
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = line.text.match(COMMENT_DEF_RE);
    if (!m || m[1] !== id) continue;
    let to = line.to;
    let buf = m[2];
    for (let j = i + 1; j <= doc.lines; j++) {
      const nl = doc.line(j);
      if (/^  \S/.test(nl.text)) { buf += " " + nl.text.trim(); to = nl.to; }
      else break;
    }
    const meta = parseCommentMeta(buf.trim());
    return { from: line.from, to, ...meta };
  }
  return null;
}

// Rewrite a comment's definition with a new note and/or resolved state,
// preserving the Google comment id metadata.
function saveComment(view, id, note, resolved) {
  const info = locateDef(view.state.doc, id);
  if (!info) return;
  const clean = String(note || "").replace(/\s+/g, " ").trim();
  const line = `[>${id}]: ${clean}${formatCommentMeta(info.gid, resolved)}`;
  if (line === view.state.doc.sliceString(info.from, info.to)) return;
  view.dispatch({ changes: { from: info.from, to: info.to, insert: line } });
}

function showOverlay(view, bubbleEl, id) {
  closeOverlay();
  const info = locateDef(view.state.doc, id) || { note: "", resolved: false };

  const el = document.createElement("div");
  el.className = "comment-overlay" + (info.resolved ? " comment-resolved" : "");
  el.dataset.id = id;

  const closeBtn = document.createElement("button");
  closeBtn.className = "footnote-overlay-close";
  closeBtn.textContent = "×";
  closeBtn.title = "Close";

  const content = document.createElement("div");
  content.className = "comment-overlay-content";
  content.contentEditable = "true";
  content.textContent = info.note;

  const actions = document.createElement("div");
  actions.className = "comment-overlay-actions";
  const resolveBtn = document.createElement("button");
  resolveBtn.className = "comment-resolve-btn";
  resolveBtn.textContent = info.resolved ? "Unresolve" : "Resolve";
  actions.appendChild(resolveBtn);

  el.append(closeBtn, content, actions);
  document.body.appendChild(el);

  closeBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    saveComment(view, id, content.textContent, info.resolved);
    closeOverlay();
    view.focus();
  });
  resolveBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    saveComment(view, id, content.textContent, !info.resolved);
    closeOverlay();
    view.focus();
  });

  // Click outside the overlay (and not on a bubble) saves + closes.
  _outsideHandler = (e) => {
    if (el.contains(e.target) || (e.target.classList && e.target.classList.contains("comment-bubble"))) return;
    saveComment(view, id, content.textContent, info.resolved);
    closeOverlay();
  };
  document.addEventListener("mousedown", _outsideHandler, true);

  const r = bubbleEl.getBoundingClientRect();
  el.style.position = "fixed";
  el.style.left = Math.min(r.left, window.innerWidth - 320) + "px";
  el.style.top = (r.bottom + 6) + "px";
  el.style.maxWidth = "300px";
  _activeOverlay = el;
  content.focus();
}

// ───────────────────── decorations ─────────────────────

class CommentBubbleWidget extends WidgetType {
  constructor(id, note, resolved, view) {
    super();
    this.id = id; this.note = note; this.resolved = resolved; this.view = view;
  }
  eq(o) { return this.id === o.id && this.note === o.note && this.resolved === o.resolved; }
  toDOM() {
    const b = document.createElement("span");
    b.className = "comment-bubble" + (this.resolved ? " comment-bubble-resolved" : "");
    b.title = this.note || `Comment ${this.id}`;
    if (!this.resolved) b.style.color = COMMENT_COLOR;
    b.textContent = this.resolved ? "✓" : "\u{1F5E8}"; // ✓ resolved, 🗨 open
    const view = this.view;
    const id = this.id;
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (_activeOverlay && _activeOverlay.dataset.id === id) { closeOverlay(); return; }
      showOverlay(view, b, id);
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
  const items = [];

  // Anchored ranges.
  COMMENT_ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = COMMENT_ANCHOR_RE.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const id = m[2];
    const info = defs.get(id) || { note: "", resolved: false };
    const openEnd = start + 2;                 // after `{>`
    const closeStart = end - (id.length + 2);  // before `<id}`
    if (overlaps(start, end)) continue;        // editing — show raw
    items.push({ from: start, to: openEnd, deco: Decoration.replace({}) });
    if (closeStart > openEnd) {
      items.push({
        from: openEnd, to: closeStart,
        deco: Decoration.mark({
          class: "comment-anchor" + (info.resolved ? " comment-anchor-resolved" : ""),
          attributes: { title: info.note || `Comment ${id}` },
        }),
      });
    }
    items.push({
      from: closeStart, to: end,
      deco: Decoration.replace({ widget: new CommentBubbleWidget(id, info.note, info.resolved, view) }),
    });
  }

  // Hide each contiguous `[>id]:` definition block (plus its two-space
  // continuations) so the imported notes never clutter the document foot.
  let i = 1;
  while (i <= doc.lines) {
    const line = doc.line(i);
    if (!COMMENT_DEF_RE.test(line.text)) { i++; continue; }
    let endLine = line;
    let j = i + 1;
    while (j <= doc.lines) {
      const nl = doc.line(j);
      if (COMMENT_DEF_RE.test(nl.text) || /^  \S/.test(nl.text)) { endLine = nl; j++; }
      else break;
    }
    // Eat the newline before the block too so it collapses cleanly.
    const from = line.from > 0 ? line.from - 1 : line.from;
    const to = endLine.to;
    if (!overlaps(from, to)) items.push({ from, to, deco: Decoration.replace({}) });
    i = j;
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
