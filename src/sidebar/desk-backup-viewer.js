/**
 * The limited viewer inside Recover Desk Version (desk-backup-browser.js):
 * one backup's files as a tree, and a read-only preview of a document's
 * text. Nothing is unpacked — the tree comes from the backup's own
 * `.hush/tree.json` and each preview reads one file out of the zip
 * (desk_backup_restore.rs). Notebooks, stacks and PDFs are listed but
 * not drawn; recovering the desk is how to open those.
 */

import { escHtml, typeIcons } from "./files-panel-shared.js";

/** Special containers by the kind their id starts with. */
const SPECIAL_ICONS = {
  __inbox__: "inbox", __images__: "images", __pdfs__: "pdf", __archive__: "archive", __trash__: "trash",
};
/** Shown folded at first: rarely what a recovery is after. */
const FOLDED_SPECIALS = new Set(["__images__", "__pdfs__", "__archive__", "__trash__"]);

function specialKind(node) {
  const m = /^(__[a-z]+__):/.exec(node.id || "");
  return m ? m[1] : null;
}

function iconFor(node) {
  const kind = specialKind(node);
  if (kind && SPECIAL_ICONS[kind]) return typeIcons[SPECIAL_ICONS[kind]] || typeIcons.folder;
  return typeIcons[node.type] || typeIcons.document;
}

const isContainer = (node) => Array.isArray(node.children) && node.children.length > 0
  && ["folder", "project", "desk"].includes(node.type);

function countDocs(node) {
  let n = 0;
  for (const c of node.children || []) n += (c.type === "document" ? 1 : 0) + countDocs(c);
  return n;
}

function wordCount(text) {
  const words = String(text).trim().match(/\S+/g);
  return words ? words.length : 0;
}

/** Draw `contents` (`{ tree, index, pdfs }`) into `host`. `readFile`
 *  resolves a fileId to its text in this backup. */
export function renderBackupViewer(host, { contents, readFile }) {
  host.innerHTML = `
    <div class="desk-backup-tree" role="tree"></div>
    <div class="desk-backup-preview">
      <p class="desk-backup-hint">Choose a document to read it as it was in this backup.</p>
    </div>`;
  const treeEl = host.querySelector(".desk-backup-tree");
  const previewEl = host.querySelector(".desk-backup-preview");
  const docCount = countDocs(contents.tree);
  if (!docCount && !(contents.tree.children || []).some((c) => c.children?.length)) {
    treeEl.innerHTML = `<p class="desk-backup-hint">This backup holds an empty desk.</p>`;
    return;
  }
  let selectedRow = null;
  let previewToken = 0;

  const preview = async (node, row) => {
    selectedRow?.classList.remove("selected");
    selectedRow = row;
    row.classList.add("selected");
    const token = ++previewToken;
    if (node.type !== "document") {
      const what = { notebook: "Notebooks", stack: "Stacks", pdf: "PDFs" }[node.type] || "Files like this";
      previewEl.innerHTML = `
        <div class="desk-backup-preview-title">${escHtml(node.name)}</div>
        <p class="desk-backup-hint">${what} can't be shown here. Recover the desk to open it.</p>`;
      return;
    }
    if (!node.fileId || !contents.index?.[node.fileId]) {
      previewEl.innerHTML = `
        <div class="desk-backup-preview-title">${escHtml(node.name)}</div>
        <p class="desk-backup-hint">This document's text isn't in the backup.</p>`;
      return;
    }
    previewEl.innerHTML = `<p class="desk-backup-hint">Reading…</p>`;
    let text;
    try { text = await readFile(node.fileId); }
    catch (e) {
      if (token === previewToken) previewEl.innerHTML = `<p class="desk-backup-hint">Couldn't read it: ${escHtml(String(e?.message || e))}</p>`;
      return;
    }
    if (token !== previewToken) return;
    const words = wordCount(text);
    previewEl.innerHTML = `
      <div class="desk-backup-preview-head">
        <div>
          <div class="desk-backup-preview-title">${escHtml(node.name)}</div>
          <div class="desk-backup-preview-meta">${words} word${words === 1 ? "" : "s"}</div>
        </div>
        <button type="button" class="desk-archive-btn desk-backup-copy">Copy Text</button>
      </div>
      <pre class="desk-backup-preview-text"></pre>`;
    previewEl.querySelector(".desk-backup-preview-text").textContent = text;
    const copyBtn = previewEl.querySelector(".desk-backup-copy");
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = "Copied";
        setTimeout(() => { copyBtn.textContent = "Copy Text"; }, 1400);
      } catch { copyBtn.textContent = "Couldn't copy"; }
    });
  };

  const renderLevel = (nodes, parent, depth) => {
    for (const node of nodes) {
      const container = isContainer(node);
      // An empty special (no Archive in use, an empty Trash) is noise.
      if (specialKind(node) && !container) continue;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "desk-backup-node";
      row.style.paddingLeft = `${6 + depth * 14}px`;
      row.setAttribute("role", "treeitem");
      row.innerHTML = `
        <span class="desk-backup-caret">${container ? "▸" : ""}</span>
        <span class="desk-backup-node-icon">${iconFor(node)}</span>
        <span class="desk-backup-node-name">${escHtml(node.name || "Untitled")}</span>`;
      parent.appendChild(row);
      if (!container) {
        row.addEventListener("click", () => void preview(node, row));
        continue;
      }
      const kids = document.createElement("div");
      kids.className = "desk-backup-children";
      parent.appendChild(kids);
      renderLevel(node.children, kids, depth + 1);
      const setOpen = (open) => {
        kids.hidden = !open;
        row.setAttribute("aria-expanded", String(open));
        row.querySelector(".desk-backup-caret").textContent = open ? "▾" : "▸";
      };
      setOpen(depth > 0 || !FOLDED_SPECIALS.has(specialKind(node)));
      row.addEventListener("click", () => setOpen(kids.hidden));
    }
  };
  renderLevel(contents.tree.children || [], treeEl, 0);
}
