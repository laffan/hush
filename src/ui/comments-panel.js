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
      const info = defs.get(id) || { note: "", resolved: false };
      out.push({ offset: m.index, quoted: m[1], note: info.note, resolved: info.resolved });
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

  function render(items) {
    listEl.replaceChildren();
    for (const c of items) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "comments-item" + (c.resolved ? " comments-item-resolved" : "");

      const quote = document.createElement("div");
      quote.className = "comments-item-quote";
      quote.textContent = String(c.quoted || "").replace(/\s+/g, " ").trim();

      const note = document.createElement("div");
      note.className = "comments-item-note";
      // Show the whole comment — no excerpting.
      note.textContent = String(c.note || "").trim() || "(empty comment)";

      item.append(quote, note);
      item.addEventListener("click", () => scrollEditorTo(c.offset));
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
