/**
 * Comment anchors — CodeMirror support for Google-Docs comments imported
 * into Hush.
 *
 * Source shape (see `editor/comment-syntax.js`):
 *
 *   inside the text {>it looks like<ab} more
 *   [>ab]: Jane Doe: interesting, i love this thought %%cmnt id=AAAB123%%
 *
 * A reader sees only the tinted commented range — every delimiter (`{>`,
 * `<id}`) and the whole `[>id]:` definition block are hidden. Hovering the
 * range pops a tooltip with the note and a Resolve/Unresolve button
 * (resolving is applied to Google on the next push — see
 * `google-docs/comments-sync.js`). Raw syntax is revealed whenever the
 * selection touches a comment, so everything stays directly editable.
 */
import { ViewPlugin, Decoration, hoverTooltip } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import {
  COMMENT_ANCHOR_RE, COMMENT_DEF_RE,
  parseCommentDefinitions, parseCommentMeta, formatCommentMeta,
} from "../comment-syntax.js";

// ───────────────────── definition read / write ─────────────────────

// Locate the `[>id]:` definition (plus indented continuations) in the doc.
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
    return { from: line.from, to, ...parseCommentMeta(buf.trim()) };
  }
  return null;
}

// Rewrite a comment's definition with a new note / resolved state,
// preserving the Google comment id metadata.
function saveComment(view, id, note, resolved) {
  const info = locateDef(view.state.doc, id);
  if (!info) return;
  const clean = String(note || "").replace(/\s+/g, " ").trim();
  const line = `[>${id}]: ${clean}${formatCommentMeta(info.gid, resolved)}`;
  if (line === view.state.doc.sliceString(info.from, info.to)) return;
  view.dispatch({ changes: { from: info.from, to: info.to, insert: line } });
}

// ───────────────────── hover tooltip ─────────────────────

// Find the comment anchor whose visible range covers `pos`.
function commentAt(doc, pos) {
  const text = doc.toString();
  const defs = parseCommentDefinitions(text);
  COMMENT_ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = COMMENT_ANCHOR_RE.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const id = m[2];
    const openEnd = start + 2;
    const closeStart = end - (id.length + 2);
    if (pos >= openEnd && pos <= closeStart) {
      const info = defs.get(id) || { note: "", resolved: false };
      return { from: openEnd, to: closeStart, id, note: info.note, resolved: info.resolved };
    }
  }
  return null;
}

function tooltipDom(view, found) {
  const dom = document.createElement("div");
  dom.className = "comment-tooltip" + (found.resolved ? " comment-resolved" : "");
  const note = document.createElement("div");
  note.className = "comment-tooltip-note";
  note.textContent = found.note || "(empty comment)";
  const btn = document.createElement("button");
  btn.className = "comment-resolve-btn";
  btn.textContent = found.resolved ? "Unresolve" : "Resolve";
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    saveComment(view, found.id, found.note, !found.resolved);
  });
  dom.append(note, btn);
  return dom;
}

function commentHoverTooltip() {
  return hoverTooltip((view, pos) => {
    const found = commentAt(view.state.doc, pos);
    if (!found) return null;
    return {
      pos: found.from,
      end: found.to,
      above: true,
      create: () => ({ dom: tooltipDom(view, found) }),
    };
  });
}

// ───────────────────── decorations ─────────────────────

function buildDecorations(view) {
  const doc = view.state.doc;
  const text = doc.toString();
  const defs = parseCommentDefinitions(text);
  const sel = view.state.selection.ranges;
  const overlaps = (from, to) => sel.some((r) => r.from <= to && r.to >= from);
  const items = [];

  // Anchored ranges: hide the `{>` / `<id}` delimiters, tint the text.
  COMMENT_ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = COMMENT_ANCHOR_RE.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const id = m[2];
    const info = defs.get(id) || { resolved: false };
    const openEnd = start + 2;
    const closeStart = end - (id.length + 2);
    if (overlaps(start, end)) continue; // editing — show raw
    items.push({ from: start, to: openEnd, deco: Decoration.replace({}) });
    if (closeStart > openEnd) {
      items.push({
        from: openEnd, to: closeStart,
        deco: Decoration.mark({
          class: "comment-anchor" + (info.resolved ? " comment-anchor-resolved" : ""),
        }),
      });
    }
    items.push({ from: closeStart, to: end, deco: Decoration.replace({}) });
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
  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) { this.decorations = buildDecorations(view); }
      update(update) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
  return [plugin, commentHoverTooltip()];
}
