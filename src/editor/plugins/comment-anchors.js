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
 * range pops a tooltip with the note and a Resolve button. Resolving
 * removes the comment syntax from the document entirely (the commented
 * prose stays) and — when the doc is linked and the Google comment id is
 * known — resolves the comment in Google right away (best-effort; see
 * `google-docs/comments-sync.js#resolveCommentInGoogle`). Raw syntax is
 * revealed whenever the selection touches a comment, so everything stays
 * directly editable.
 */
import { ViewPlugin, Decoration, hoverTooltip } from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
  COMMENT_ANCHOR_RE, COMMENT_DEF_RE,
  parseCommentDefinitions, parseCommentMeta, splitNoteSegments,
} from "../comment-syntax.js";

// ───────────────────── active comment ─────────────────────

// The comments panel marks one comment "active" (clicked) — its anchor
// paints in a stronger tint so the reader can spot the clicked comment in
// the text without the cursor having to move into it (which would reveal
// the raw syntax and drop the highlight entirely).
export const setActiveComment = StateEffect.define();

export const activeCommentField = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setActiveComment)) value = e.value;
    return value;
  },
});

/** Mark the comment with this anchor id active (null clears). */
export function setActiveCommentId(view, id) {
  view.dispatch({ effects: setActiveComment.of(id || null) });
}

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

/**
 * Resolve a comment: strip every trace of its syntax from the document —
 * unwrap the `{>text<id}` anchor(s) to the bare prose and delete the
 * `[>id]:` definition line(s) — in one transaction so undo restores the
 * comment whole. Returns the definition info (for its `gid`) or null.
 */
export function removeCommentFromDoc(view, id) {
  const doc = view.state.doc;
  const text = doc.toString();
  const info = locateDef(doc, id);
  const changes = [];
  COMMENT_ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = COMMENT_ANCHOR_RE.exec(text)) !== null) {
    if (m[2] !== id) continue;
    const start = m.index;
    const end = start + m[0].length;
    changes.push({ from: start, to: start + 2 }); // `{>`
    changes.push({ from: end - (id.length + 2), to: end }); // `<id}`
    // A suggested-edit anchor carries the `~~` the importer added to
    // mirror the GDoc's strikethrough — resolving drops those too so the
    // prose comes out clean.
    const inner = m[1];
    if (info?.sug && /^~~[\s\S]*~~$/.test(inner) && inner.length >= 4) {
      changes.push({ from: start + 2, to: start + 4 });
      changes.push({ from: end - (id.length + 4), to: end - (id.length + 2) });
    }
  }
  if (info) {
    // Take the trailing newline with the definition (or the leading one
    // when it's the last line) so no blank line is left behind.
    let from = info.from;
    let to = info.to;
    if (to < doc.length) to += 1;
    else if (from > 0) from -= 1;
    changes.push({ from, to });
  }
  if (changes.length) view.dispatch({ changes });
  return info;
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
      const info = defs.get(id) || { note: "", resolved: false, sug: false };
      return { from: openEnd, to: closeStart, id, note: info.note, resolved: info.resolved, sug: info.sug };
    }
  }
  return null;
}

/**
 * Render a flattened note into `host` as one block per thread segment —
 * author name on its own styled run, comment text after it — so a thread
 * with several voices doesn't read as one run-on line. Shared by the hover
 * tooltip and the comments panel.
 */
export function renderNoteSegments(host, note) {
  const segments = splitNoteSegments(note);
  if (segments.length === 0) {
    host.textContent = "(empty comment)";
    return;
  }
  for (const seg of segments) {
    const row = document.createElement("div");
    row.className = "comment-note-segment";
    if (seg.author) {
      const who = document.createElement("span");
      who.className = "comment-note-author";
      who.textContent = seg.author;
      row.appendChild(who);
    }
    row.appendChild(document.createTextNode(seg.text));
    host.appendChild(row);
  }
}

function tooltipDom(view, found, state) {
  const dom = document.createElement("div");
  dom.className = "comment-tooltip"
    + (found.sug ? " comment-tooltip-suggestion" : "")
    + (found.resolved ? " comment-resolved" : "");
  const note = document.createElement("div");
  note.className = "comment-tooltip-note";
  renderNoteSegments(note, found.note);
  const btn = document.createElement("button");
  btn.className = "comment-resolve-btn";
  btn.textContent = "Resolve";
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const info = removeCommentFromDoc(view, found.id);
    if (info?.gid && state) {
      import("../../google-docs/comments-sync.js")
        .then((m) => m.resolveCommentInGoogle(state, info.gid))
        .catch((err) => console.warn("[google-docs] resolve on Resolve click failed:", err));
    }
  });
  dom.append(note, btn);
  return dom;
}

function commentHoverTooltip(state) {
  return hoverTooltip((view, pos) => {
    const found = commentAt(view.state.doc, pos);
    if (!found) return null;
    return {
      pos: found.from,
      end: found.to,
      above: true,
      create: () => ({ dom: tooltipDom(view, found, state) }),
    };
  });
}

// ───────────────────── decorations ─────────────────────

function buildDecorations(view) {
  const doc = view.state.doc;
  const text = doc.toString();
  const defs = parseCommentDefinitions(text);
  const activeId = view.state.field(activeCommentField, false) ?? null;
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
    const info = defs.get(id) || { resolved: false, sug: false };
    const openEnd = start + 2;
    const closeStart = end - (id.length + 2);
    if (overlaps(start, end)) continue; // editing — show raw
    items.push({ from: start, to: openEnd, deco: Decoration.replace({}) });
    if (closeStart > openEnd) {
      items.push({
        from: openEnd, to: closeStart,
        deco: Decoration.mark({
          class: "comment-anchor"
            + (info.sug ? " comment-anchor-suggestion" : "")
            + (info.resolved ? " comment-anchor-resolved" : "")
            + (id === activeId ? " comment-anchor-active" : ""),
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

export function createCommentAnchorPlugin(state) {
  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) { this.decorations = buildDecorations(view); }
      update(update) {
        const activeChanged =
          update.startState.field(activeCommentField, false) !==
          update.state.field(activeCommentField, false);
        if (update.docChanged || update.viewportChanged || update.selectionSet || activeChanged) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
  return [activeCommentField, plugin, commentHoverTooltip(state)];
}
