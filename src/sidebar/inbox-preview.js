/**
 * Inbox preview cards. Under an Inbox row's own line (icon, name, last
 * edited, menu) sits a glimpse of where the work on it left off:
 *
 *   - A **Doc** shows the stretch around its last caret position — up to
 *     the 50 words before it and the 5 after — within four lines, cut
 *     from the top so the end nearest the caret is the part that shows,
 *     with the caret itself a 3px line in the style's cursor colour.
 *
 * The item is framed in a light border, its last-edited line moved below
 * the preview (files-panel.js).
 *   - A **Notebook** shows a small snapshot of its canvas as it was last
 *     saved.
 *   - A **Stack** lists its files, the one edited last picked out.
 *
 * What a card needs that the tree doesn't hold — a caret, a snapshot —
 * comes from inbox-preview-store.js; a stack's file list is read once
 * and cached until the stack's file changes.
 */
import { escHtml } from "./files-panel-shared.js";
import { findNodeByFileId } from "../state/tree-helpers.js";
import { docCaret, notebookThumb } from "./inbox-preview-store.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
const WORDS_BEFORE = 50;
const WORDS_AFTER = 5;

/** The words around `caret` in `content`: `{ before, after }`, front
 *  matter left out. The caret defaults to the end of the document. */
export function docExcerpt(content, caret) {
  let text = String(content || "");
  let pos = Number.isFinite(caret) ? Math.max(0, Math.min(caret, text.length)) : text.length;
  const fm = /^---\n[\s\S]*?\n---\n?/.exec(text);
  if (fm) {
    text = text.slice(fm[0].length);
    pos = Math.max(0, pos - fm[0].length);
  }
  const beforeTokens = text.slice(0, pos).split(/(\s+)/);
  let words = 0;
  let start = beforeTokens.length;
  while (start > 0 && words < WORDS_BEFORE) {
    start--;
    if (beforeTokens[start].trim()) words++;
  }
  const afterTokens = text.slice(pos).split(/(\s+)/);
  let end = 0;
  words = 0;
  while (end < afterTokens.length && (words < WORDS_AFTER || !afterTokens[end].trim())) {
    if (afterTokens[end].trim()) words++;
    end++;
    if (words >= WORDS_AFTER) break;
  }
  return { before: beforeTokens.slice(start).join(""), after: afterTokens.slice(0, end).join("") };
}

function docPreview(state, item) {
  const content = (state.files || []).find((f) => f.id === item.fileId)?.content;
  if (typeof content !== "string" || !content.trim()) return null;
  const { before, after } = docExcerpt(content, docCaret(item.fileId));
  if (!before.trim() && !after.trim()) return null;
  const el = document.createElement("div");
  el.className = "inbox-preview inbox-preview-doc";
  el.innerHTML = `<div class="inbox-preview-text">${escHtml(before)}<span class="inbox-preview-caret" aria-hidden="true"></span>${escHtml(after)}</div>`;
  return el;
}

function notebookPreview(item) {
  const url = notebookThumb(item.fileId);
  if (!url) return null;
  const el = document.createElement("div");
  el.className = "inbox-preview inbox-preview-notebook";
  const img = document.createElement("img");
  img.alt = "";
  img.decoding = "async";
  img.src = url;
  el.appendChild(img);
  return el;
}

// fileId → { modified, ids } — a stack's member fileIds, re-read when the
// stack's own file changes.
const stackCache = new Map();

async function stackMembers(fileId, modified) {
  const hit = stackCache.get(fileId);
  if (hit && hit.modified === modified) return hit.ids;
  let ids = [];
  try {
    let raw = null;
    if (IS_TAURI) {
      const { invoke } = await import("@tauri-apps/api/core");
      raw = (await invoke("load_file", { id: fileId }))?.content;
    }
    const { decodeStackContent } = await import("../stack/stack-content.js");
    ids = decodeStackContent(raw).items.map((x) => x.fileId).filter(Boolean);
  } catch { ids = []; }
  stackCache.set(fileId, { modified, ids });
  return ids;
}

function stackPreview(state, item) {
  const modified = (state.files || []).find((f) => f.id === item.fileId)?.modified || 0;
  const el = document.createElement("div");
  el.className = "inbox-preview inbox-preview-stack";
  const paint = (ids) => {
    const rows = ids.map((id) => {
      const node = findNodeByFileId(state.fileTree, id);
      const f = (state.files || []).find((x) => x.id === id);
      return { id, name: node?.name || f?.name || "Untitled", modified: f?.modified || 0 };
    });
    if (!rows.length) { el.remove(); return; }
    const newest = rows.reduce((a, b) => (b.modified > a.modified ? b : a), rows[0]);
    el.innerHTML = rows.map((r) => `<div class="inbox-preview-stack-file${r === newest && r.modified ? " latest" : ""}">${escHtml(r.name)}</div>`).join("");
  };
  const cached = stackCache.get(item.fileId);
  if (cached && cached.modified === modified) paint(cached.ids);
  else void stackMembers(item.fileId, modified).then(paint);
  return el;
}

/** The preview card body for an Inbox row, or null when there is
 *  nothing to show. */
export function inboxPreviewFor(state, item) {
  if (!item?.fileId) return null;
  if (item.type === "document") return docPreview(state, item);
  if (item.type === "notebook") return notebookPreview(item);
  if (item.type === "stack") return stackPreview(state, item);
  return null;
}
