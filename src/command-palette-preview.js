/**
 * The file picker's hover preview (⌘O): rest the pointer on a file's row
 * for a second and a card flies out to the left of the palette showing
 * where the work on it left off — the same previews the sidebar's
 * expanded view draws (sidebar/inbox-preview.js: a document's last
 * words, a notebook's snapshot, a stack's files), and for a project its
 * documents in order. A file with nothing to show (a PDF, an empty
 * document, a notebook never opened on this device) shows none.
 *
 * Mouse only, as the palette's hover highlight is; the card goes with
 * the pointer, a re-render of the list, or the palette.
 */
import { inboxPreviewFor } from "./sidebar/inbox-preview.js";
import { leafIcon, escHtml } from "./sidebar/files-panel-shared.js";
import { getIcon } from "./sidebar/files-panel-rows.js";
import { findNode } from "./state/tree-helpers.js";

const HOVER_MS = 1000;
const WIDTH = 260;
const GAP = 12;
const MARGIN = 8;

let timer = null;
let card = null;

export function hidePalettePreview() {
  clearTimeout(timer);
  timer = null;
  card?.remove();
  card = null;
}

/** A project's documents, in order, each with its type's icon — the
 *  stack preview's outline. */
function projectPreview(state, leaf) {
  const node = findNode(state.fileTree || [], leaf.fileId);
  const kids = (node?.children || []).filter((c) => c.fileId && c.type === "document");
  if (!kids.length) return null;
  const el = document.createElement("div");
  el.className = "inbox-preview inbox-preview-stack";
  el.innerHTML = kids.map((c) => `<div class="inbox-preview-stack-file">${getIcon(c, state)}`
    + `<span class="inbox-preview-stack-name">${escHtml(c.name || "Untitled")}</span></div>`).join("");
  return el;
}

function buildCard(state, leaf) {
  const body = leaf.type === "project" ? projectPreview(state, leaf) : inboxPreviewFor(state, leaf);
  if (!body) return null;
  const el = document.createElement("div");
  el.className = "cmd-palette-preview";
  const other = leaf.deskId && leaf.deskId !== state.settings?.activeDeskId;
  el.innerHTML = `<div class="cmd-palette-preview-title">${leafIcon(leaf)}`
    + `<span class="cmd-palette-preview-name">${escHtml(leaf.name || "Untitled")}</span></div>`
    + (other ? `<div class="cmd-palette-preview-desk">${escHtml(leaf.deskName || "")}</div>` : "");
  el.appendChild(body);
  return el;
}

function place(el, row) {
  const palette = row.closest(".cmd-palette");
  if (!palette) return false;
  const p = palette.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const width = Math.min(WIDTH, p.left - GAP - MARGIN);
  if (width < 160) return false; // no room to the left (a narrow window)
  el.style.width = width + "px";
  el.style.left = (p.left - GAP - width) + "px";
  el.style.top = r.top + "px";
  return true;
}

/** Give a picker row its preview. `leaf` is the picker's file. */
export function attachRowPreview(row, leaf, state) {
  row.addEventListener("pointerenter", (e) => {
    if (e.pointerType && e.pointerType !== "mouse") return;
    hidePalettePreview();
    timer = setTimeout(() => {
      timer = null;
      if (!row.isConnected) return;
      const el = buildCard(state, leaf);
      if (!el) return;
      (row.closest(".cmd-palette-overlay") || document.body).appendChild(el);
      if (!place(el, row)) { el.remove(); return; }
      // Keep it on screen: a row near the foot of the window lifts it.
      const h = el.offsetHeight;
      const top = parseFloat(el.style.top);
      if (top + h > window.innerHeight - MARGIN) el.style.top = Math.max(MARGIN, window.innerHeight - MARGIN - h) + "px";
      card = el;
    }, HOVER_MS);
  });
  row.addEventListener("pointerleave", hidePalettePreview);
}
