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
import { paginate, headingsOf, pageOf } from "./board-model.js";

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
 *  its page and clicking to its place. Without headings there is nothing
 *  to point into, so an **Open as Pane** button stands in its place and
 *  opens the row's pane at the top. */
export function buildOutline(content, { onHover, onPick, name = "" }) {
  const heads = headingsOf(content);
  // A title heading that only repeats the document's name (the row says
  // it already) is left out.
  if (heads.length && heads[0].text.trim().toLowerCase() === String(name).trim().toLowerCase()) heads.shift();
  const el = document.createElement("div");
  el.className = "board-outline";
  if (!heads.length) {
    el.innerHTML = `<button type="button" class="board-open-pane">Open as Pane</button>`;
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

/** The stack column's width and the indent per nested project — the
 *  connector is drawn in pixels, so these are the stylesheet's
 *  `--board-stack-col` / `--board-indent` as numbers. */
export const STACK_COL = 360;
export const INDENT = 56;
const FOOT = 13;
const xAt = (depth) => STACK_COL / 2 + depth * INDENT;

/** The link between two rows — the sidebar's I-beam, drawn large: a
 *  foot under the upper stack, a stem, a foot over the lower one. When
 *  the rows sit at different depths (a nested project begins or ends)
 *  the stem bends across between them, and entering a nested project it
 *  names it (`groups`, each a click to that project's own Desktop).
 *  Midway down the lower stretch is the add-a-placeholder button.
 *  `last` runs the stem down past the last row — back out to the
 *  board's own depth — with no foot below. */
export function buildConnector({ from = 0, to = 0, last = false, groups = [], onAdd, onGroup, title = "Add a placeholder document here" }) {
  const bend = from !== to;
  const h = last ? (bend ? 76 : 52) : (bend ? 96 : 64);
  const x1 = xAt(from), x2 = xAt(to);
  const turn = 26;
  const end = last ? h - 6 : h - 8;
  let d = `M${x1 - FOOT} 8H${x1 + FOOT}M${x1} 8`;
  if (bend) {
    const r = Math.min(8, Math.abs(x2 - x1) / 2), dir = Math.sign(x2 - x1);
    d += `V${turn - r}Q${x1} ${turn} ${x1 + dir * r} ${turn}H${x2 - dir * r}Q${x2} ${turn} ${x2} ${turn + r}`;
  }
  d += `V${end}`;
  if (!last) d += `M${x2 - FOOT} ${end}H${x2 + FOOT}`;
  const el = document.createElement("div");
  el.className = "board-connector" + (last ? " last" : "") + (bend ? " bend" : "");
  el.style.height = h + "px";
  el.innerHTML = `<svg class="board-ibeam" width="${Math.max(x1, x2) + FOOT + 2}" height="${h}" aria-hidden="true"><path d="${d}"/></svg>`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "board-add";
  btn.innerHTML = PLUS_BOX;
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.style.left = x2 + "px";
  btn.style.top = (last ? (bend ? turn + 22 : 34) : ((bend ? turn : 8) + end) / 2) + "px";
  btn.addEventListener("click", onAdd);
  el.appendChild(btn);
  if (groups.length) {
    const label = document.createElement("button");
    label.type = "button";
    label.className = "board-group-label";
    label.style.left = (x2 + FOOT + 14) + "px";
    label.style.top = (bend ? turn : 8) + "px";
    label.innerHTML = groups.map((g) => `<span>${escHtml(g.name || "Project")}</span>`).join(`<span class="sep">/</span>`);
    label.title = "Open this project's own Desktop";
    label.addEventListener("click", () => onGroup?.(groups[groups.length - 1]));
    el.appendChild(label);
  }
  return el;
}

/** A placeholder's dashed stack: the name its document will take — its
 *  outline's first item — and Create, which waits for one. Returns
 *  `{ el, setName(name) }` so the outline's edits can update it. */
export function buildPlaceholderStack(name, { onCreate, onRemove }) {
  const el = document.createElement("div");
  el.className = "board-stack board-stack-placeholder";
  el.innerHTML = `<button type="button" class="board-ph-remove" title="Remove placeholder" aria-label="Remove placeholder">×</button>`
    + `<div class="board-ph-name"></div>`
    + `<button type="button" class="board-ph-create">Create</button>`;
  const nameEl = el.querySelector(".board-ph-name");
  const create = el.querySelector(".board-ph-create");
  const setName = (n) => {
    nameEl.textContent = n || "Untitled";
    nameEl.classList.toggle("empty", !n);
    create.disabled = !n;
    create.title = n ? `Create “${n}” here` : "The outline's first item names the document — write one to create it";
  };
  setName(name);
  create.addEventListener("click", () => { if (!create.disabled) onCreate(); });
  el.querySelector(".board-ph-remove").addEventListener("click", onRemove);
  return { el, setName };
}
