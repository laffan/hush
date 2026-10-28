/**
 * Inbox preview cards. Under an Inbox row's own line (icon, name, last
 * edited, menu) sits a glimpse of where the work on it left off:
 *
 *   - A **Doc** shows the stretch around its last caret position — up to
 *     the 50 words before it and the 5 after, run together on one line
 *     — within two lines, cut from the top so the end nearest the caret
 *     is the part that shows, with the caret a dotted line in the text's
 *     colour (against the last word when it was in the space after it).
 *   - A **Notebook** shows a small snapshot of its shapes as last saved,
 *     transparent so the sidebar shows through, in the appearance on
 *     screen.
 *   - A **Stack** lists its files, each with its type's icon, in an
 *     outline, the one edited last picked out.
 *
 * The item is framed in a light border, its last-edited line moved below
 * the preview (files-panel.js).
 *
 * What a card needs that the tree doesn't hold — a caret, a snapshot —
 * comes from inbox-preview-store.js; a stack's file list is read once
 * and cached until the stack's file changes.
 */
import { escHtml } from "./files-panel-shared.js";
import { findNodeByFileId, findParentOfNode } from "../state/tree-helpers.js";
import { getIcon } from "./files-panel-rows.js";
import { AppState } from "../state/state.js";
import { docCaret, notebookThumb } from "./inbox-preview-store.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
const WORDS_BEFORE = 50;
const WORDS_AFTER = 5;

/** The words around `caret` in `content`: `{ before, after }`, front
 *  matter left out and line breaks flattened to spaces. The caret
 *  defaults to the end of the document. */
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
  // One run of text: line breaks and runs of space become one space.
  let before = beforeTokens.slice(start).join("").replace(/\s+/g, " ").trimStart();
  let after = afterTokens.slice(0, end).join("").replace(/\s+/g, " ").trimEnd();
  // A caret in the space between words — past the last line, on a blank
  // line — sits against the word before it.
  if (/\s$/.test(before) && (!after || /^\s/.test(after))) {
    before = before.trimEnd();
    if (after) after = ` ${after.trimStart()}`;
  }
  return { before, after };
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
  const thumbs = notebookThumb(item.fileId);
  if (!thumbs) return null;
  const el = document.createElement("div");
  el.className = "inbox-preview inbox-preview-notebook";
  // Both appearances, transparent: the stylesheet shows the one for the
  // page on screen, so an appearance change needs no new snapshot.
  for (const variant of ["light", "dark"]) {
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.className = `inbox-thumb-${variant}`;
    img.src = thumbs[variant];
    el.appendChild(img);
  }
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
      return { id, node, name: node?.name || f?.name || "Untitled", modified: f?.modified || 0 };
    });
    if (!rows.length) { el.remove(); return; }
    const newest = rows.reduce((a, b) => (b.modified > a.modified ? b : a), rows[0]);
    el.innerHTML = rows.map((r) => `<div class="inbox-preview-stack-file${r === newest && r.modified ? " latest" : ""}">`
      + `${r.node ? getIcon(r.node, state) : ""}<span class="inbox-preview-stack-name">${escHtml(r.name)}</span></div>`).join("");
  };
  const cached = stackCache.get(item.fileId);
  if (cached && cached.modified === modified) paint(cached.ids);
  else void stackMembers(item.fileId, modified).then(paint);
  return el;
}

/** Whether the desk an Inbox row is in shows previews — Settings →
 *  General → Show Inbox Item Preview, kept per desk (on unless turned
 *  off): `settings.inboxPreviewByDesk[deskId] === false` turns it off. */
export function inboxPreviewsOn(state, item) {
  const parentId = findParentOfNode(state.fileTree, item.id)?.id || "";
  const prefix = AppState.INBOX_ID + ":";
  const deskId = parentId.startsWith(prefix) ? parentId.slice(prefix.length) : state.settings?.activeDeskId;
  return state.settings?.inboxPreviewByDesk?.[deskId] !== false;
}

/** The preview card body for an Inbox row, or null when there is
 *  nothing to show (or the desk shows none). */
export function inboxPreviewFor(state, item) {
  if (!item?.fileId || !inboxPreviewsOn(state, item)) return null;
  if (item.type === "document") return docPreview(state, item);
  if (item.type === "notebook") return notebookPreview(item);
  if (item.type === "stack") return stackPreview(state, item);
  return null;
}
