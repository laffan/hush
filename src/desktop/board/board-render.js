/**
 * The board's pieces, as DOM: a document's **stack** of pages, its
 * **outline** of headings, a placeholder's dashed stack, and the
 * **connector** between two rows — the sidebar's project I-beam, drawn
 * large, carrying the add-a-placeholder button at its middle.
 *
 * A stack is the pile the canvas Desktop drew (a sheet more for every
 * WORDS_PER_PAGE words), with the top sheet carrying the first page's
 * text in miniature. `reveal(i)` lifts page i to the top — the outline's
 * hover — and `reveal(null)` drops it back.
 */
import { escHtml } from "../../sidebar/files-panel-shared.js";
import { stripInlineMarkdown } from "../../outline/outline-model.ts";
import { paginate, headingsOf, leadOf, pageOf } from "./board-model.js";

/** Sheets drawn behind the top one, at most. */
const MAX_BEHIND = 5;
/** Characters of a page drawn in its miniature — more than a page shows. */
const PAGE_CHARS = 2600;

/** A page's text as miniature markup: headings, list items and
 *  paragraphs, inline markdown and cards taken out. */
function pageMarkup(content, from, to) {
  const slice = String(content || "").slice(from, Math.min(to, from + PAGE_CHARS))
    .replace(/<<<[\s\S]*?(>>>|$)/g, "")
    .replace(/%%[\s\S]*?%%/g, "");
  const out = [];
  for (const raw of slice.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim() || /^---hush-separator---$/.test(line)) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out.push(`<div class="bp-h bp-h${Math.min(3, h[1].length)}">${escHtml(stripInlineMarkdown(h[2]))}</div>`); continue; }
    const li = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.*)$/.exec(line);
    if (li) { out.push(`<div class="bp-li">${escHtml(stripInlineMarkdown(li[1]))}</div>`); continue; }
    out.push(`<div class="bp-p">${escHtml(stripInlineMarkdown(line.replace(/^>\s?/, "")))}</div>`);
  }
  return out.join("");
}

/** A document's stack. Returns `{ el, reveal(index|null), pages }`. */
export function buildStack(content, { onClick, onOpen } = {}) {
  const { starts, words } = paginate(content);
  const pages = starts.length;
  const el = document.createElement("div");
  el.className = "board-stack";
  el.style.setProperty("--behind", String(Math.min(MAX_BEHIND, pages - 1)));
  for (let i = Math.min(MAX_BEHIND, pages - 1); i >= 1; i--) {
    const sheet = document.createElement("div");
    sheet.className = "board-sheet board-sheet-behind";
    sheet.style.setProperty("--i", String(i));
    el.appendChild(sheet);
  }
  const pageText = (i) => pageMarkup(content, starts[i], i + 1 < starts.length ? starts[i + 1] : Infinity);
  const top = document.createElement("div");
  top.className = "board-sheet board-sheet-top";
  top.innerHTML = `<div class="board-page">${pageText(0)}</div>`;
  el.appendChild(top);
  // The lifted page, drawn over the top one while the outline points
  // into a later page.
  const lifted = document.createElement("div");
  lifted.className = "board-sheet board-sheet-lifted";
  lifted.innerHTML = `<div class="board-page"></div><span class="board-page-badge"></span>`;
  el.appendChild(lifted);
  let shown = null;
  const reveal = (i) => {
    if (i == null || i <= 0 || i >= pages) {
      shown = null;
      el.classList.remove("revealing");
      return;
    }
    if (shown !== i) {
      lifted.querySelector(".board-page").innerHTML = pageText(i);
      lifted.querySelector(".board-page-badge").textContent = `p. ${i + 1} of ${pages}`;
      shown = i;
    }
    el.classList.add("revealing");
  };
  if (onClick) el.addEventListener("click", onClick);
  if (onOpen) el.addEventListener("dblclick", onOpen);
  return { el, reveal, pages, words, pageOfOffset: (off) => pageOf(starts, off) };
}

/** A document's outline: its headings, nested by level, each hovering to
 *  its page and clicking to its place. Without headings it shows the
 *  document's first words, which hover to page 1 and click to the top. */
export function buildOutline(content, { onHover, onPick, name = "" }) {
  const heads = headingsOf(content);
  // A title heading that only repeats the document's name (the row says
  // it already) is left out.
  if (heads.length && heads[0].text.trim().toLowerCase() === String(name).trim().toLowerCase()) heads.shift();
  const el = document.createElement("div");
  el.className = "board-outline";
  if (!heads.length) {
    const lead = leadOf(content);
    el.innerHTML = `<div class="board-outline-empty">${lead ? `${escHtml(lead)}…` : "Empty document"}</div>`;
    el.firstChild.addEventListener("click", () => onPick({ from: 0, to: 0 }));
    return el;
  }
  const minLevel = Math.min(...heads.map((h) => h.level));
  for (const h of heads) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `board-outline-item level-${Math.min(3, h.level - minLevel + 1)}`;
    row.style.setProperty("--depth", String(h.level - minLevel));
    row.textContent = h.text || "Untitled";
    row.addEventListener("pointerenter", () => onHover(h));
    row.addEventListener("focus", () => onHover(h));
    row.addEventListener("click", () => onPick(h));
    el.appendChild(row);
  }
  el.addEventListener("pointerleave", () => onHover(null));
  return el;
}

const PLUS_BOX = `<svg viewBox="0 0 20 20"><rect x="3" y="2.5" width="14" height="15" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.4 2"/><path d="M10 7v6M7 10h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

/** The link between two rows — the sidebar's I-beam, drawn large — with
 *  the add-a-placeholder button midway down it. `last` draws the stem
 *  down from the last row with no foot below it. */
export function buildConnector({ onAdd, last = false, title = "Add a placeholder document here" }) {
  const el = document.createElement("div");
  el.className = "board-connector" + (last ? " last" : "");
  el.innerHTML = `<div class="board-ibeam"></div>`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "board-add";
  btn.innerHTML = PLUS_BOX;
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.addEventListener("click", onAdd);
  el.appendChild(btn);
  return el;
}

/** A placeholder's dashed stack: its title to name it by, and Create. */
export function buildPlaceholderStack(ph, { onTitle, onCreate, onRemove }) {
  const el = document.createElement("div");
  el.className = "board-stack board-stack-placeholder";
  el.innerHTML = `<button type="button" class="board-ph-remove" title="Remove placeholder" aria-label="Remove placeholder">×</button>`
    + `<input class="board-ph-title" type="text" spellcheck="false" placeholder="Untitled" />`
    + `<button type="button" class="board-ph-create">Create</button>`;
  const input = el.querySelector(".board-ph-title");
  input.value = ph.title || "";
  input.addEventListener("input", () => onTitle(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onCreate(); } });
  el.querySelector(".board-ph-create").addEventListener("click", onCreate);
  el.querySelector(".board-ph-remove").addEventListener("click", onRemove);
  return el;
}
