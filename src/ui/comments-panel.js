/**
 * Comments panel — a list of the document's imported Google-Docs comments,
 * pinned to the left edge of the outline (`#right-panel-overlay`).
 *
 * It mirrors the outline's visibility (shows on `show-outline`, hides on
 * `hide-outline`) and rides the same dock-offset CSS vars, so the two bars
 * move together; its list scrolls independently. Clicking an item scrolls
 * the editor to that comment's anchor.
 *
 * The panel only appears when the document actually has comments — an empty
 * bar would just be clutter — and re-syncs as comments come and go.
 */
import { EditorView } from "@codemirror/view";
import { COMMENT_ANCHOR_RE, parseCommentDefinitions } from "../editor/comment-syntax.js";
import { removeCommentFromDoc, renderNoteSegments } from "../editor/plugins/comment-anchors.js";

export function setupCommentsPanel(state) {
  const panel = document.createElement("div");
  panel.id = "comments-panel";
  panel.className = "hidden";

  const header = document.createElement("div");
  header.className = "comments-panel-header";
  header.textContent = "Comments";

  const listEl = document.createElement("div");
  listEl.className = "comments-panel-list";

  panel.append(header, listEl);
  document.getElementById("app").appendChild(panel);

  // Clicks inside the panel must not reach the outline's document-level
  // "click outside → hide" handler (overlay mode), which would otherwise
  // close both bars the moment you click a comment.
  panel.addEventListener("mousedown", (e) => e.stopPropagation());

  let refreshTimer = null;
  let selectedId = null; // anchor id of the comment last clicked in the panel

  function collectComments() {
    const view = state.editor?.view;
    if (!view) return [];
    const text = view.state.doc.toString();
    const defs = parseCommentDefinitions(text);
    const out = [];
    COMMENT_ANCHOR_RE.lastIndex = 0;
    let m;
    while ((m = COMMENT_ANCHOR_RE.exec(text)) !== null) {
      const id = m[2];
      const info = defs.get(id) || { note: "", gid: null, resolved: false };
      out.push({ id, offset: m.index, quoted: m[1], note: info.note, gid: info.gid, resolved: info.resolved });
    }
    return out;
  }

  function scrollEditorTo(offset) {
    const view = state.editor?.view;
    if (!view) return;
    const safe = Math.max(0, Math.min(offset, view.state.doc.length));
    // EditorView.scrollIntoView is the only reliable path for offsets below
    // the rendered viewport (mirrors the outline's scrollToOffset).
    view.dispatch({
      selection: { anchor: safe },
      effects: EditorView.scrollIntoView(safe, { y: "start", yMargin: 80 }),
    });
    view.focus();
  }

  // Resolve from the panel: strip the comment syntax from the document
  // (the prose stays) and, when the Google comment id is known, resolve
  // it in Google right away — same behavior as the editor hover tooltip.
  function resolveComment(c) {
    const view = state.editor?.view;
    if (!view) return;
    const info = removeCommentFromDoc(view, c.id);
    const gid = info?.gid || c.gid;
    if (gid) {
      import("../google-docs/comments-sync.js")
        .then((m) => m.resolveCommentInGoogle(state, gid))
        .catch((err) => console.warn("[google-docs] resolve from panel failed:", err));
    }
    if (selectedId === c.id) selectedId = null;
    sync();
  }

  function render(items) {
    listEl.replaceChildren();
    for (const c of items) {
      const selected = c.id === selectedId;
      const item = document.createElement("button");
      item.type = "button";
      item.className = "comments-item"
        + (c.resolved ? " comments-item-resolved" : "")
        + (selected ? " comments-item-selected" : "");

      const quote = document.createElement("div");
      quote.className = "comments-item-quote";
      quote.textContent = String(c.quoted || "").replace(/\s+/g, " ").trim();

      const note = document.createElement("div");
      note.className = "comments-item-note";
      renderNoteSegments(note, String(c.note || "").trim());

      item.append(quote, note);
      if (selected) {
        const btn = document.createElement("span");
        btn.className = "comments-item-resolve";
        btn.textContent = "Resolve";
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          resolveComment(c);
        });
        item.appendChild(btn);
      }
      item.addEventListener("click", () => {
        selectedId = c.id;
        scrollEditorTo(c.offset);
        render(items);
      });
      listEl.appendChild(item);
    }
  }

  function outlineVisible() {
    const rp = document.getElementById("right-panel-overlay");
    return !!rp && !rp.classList.contains("hidden");
  }

  // Show only when the outline is open AND there's something to list. A
  // visibility change relayouts the editor column so the panel pushes
  // content in (inset) rather than overlaying it.
  function sync(showWithOutline) {
    const shouldShow = !state.currentNotebookFileId && (showWithOutline ?? outlineVisible());
    const items = shouldShow ? collectComments() : [];
    const willShow = items.length > 0;
    if (willShow) render(items);
    const wasHidden = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !willShow);
    if (wasHidden === willShow) state.runtime?.columnResizeHandler?.();
  }

  state.on("show-outline", () => sync(true));
  state.on("hide-outline", () => sync(false));
  state.on("file-opened", () => sync());

  state.on("doc-content-changed", () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => sync(), 250);
  });
}
