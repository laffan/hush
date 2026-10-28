/**
 * Card previews in the files sidebar. Resting the pointer on a card's
 * row shows the whole card — header and every word — over the main
 * content, just right of the sidebar, its header level with the row.
 *
 * The preview is the card, so it can be carried: drag its header and let
 * go over a Doc or a canvas and the card moves there (as a row dragged
 * out of the panel does — files-panel-cards.js#dropCardOutside), or, with
 * ⌘ held, its words land as text; ⌘⇧ leaves the card where it was. Let
 * go over a document, notebook, Inbox or project row and it goes into
 * that file (`dropCardOnRow`). While carried it shows what the header
 * drag of a card in a document shows (cards/card-drag-feedback.js).
 *
 * The row's item is on its element (`__cardItem`, set by
 * `renderCardRow`), so one delegated listener on the panel serves every
 * row, across re-renders.
 */
import { cardGhost } from "../cards/card-element.js";
import { dropCardOnRow, dropCardOutside } from "./files-panel-cards.js";

const SHOW_DELAY_MS = 300;
const HIDE_DELAY_MS = 160;
const GAP = 8;

let preview = null;      // { el, item, row }
let showTimer = 0;
let hideTimer = 0;
let dragging = false;

function hide() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  if (dragging) return;
  preview?.el.remove();
  preview = null;
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, HIDE_DELAY_MS);
}

/** Place the preview right of the panel, its top at the row's top,
 *  kept inside the window. */
function place(el, row) {
  const panel = row.closest("#panel-overlay") || row.closest(".sl-list") || row;
  const p = panel.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const h = el.offsetHeight;
  const w = el.offsetWidth;
  const left = Math.min(p.right + GAP, window.innerWidth - w - GAP);
  const top = Math.max(GAP, Math.min(r.top, window.innerHeight - h - GAP));
  el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

async function show(state, shownRow) {
  const item = shownRow.__cardItem;
  if (!item?.cardRef || document.body.classList.contains("sl-dragging")) return;
  const { readCardRef } = await import("../cards/card-transfer.js");
  let card = null;
  try { card = await readCardRef(state, item.cardRef); } catch { card = null; }
  // A Doc's row carries the card's words as the panel last read them.
  if (!card && item.cardRef.body) card = { body: item.cardRef.body, meta: item.bgColor ? { bgColor: item.bgColor } : {} };
  // Still on the row (or the one a re-render put in its place)?
  if (!card || !hovered || hovered.id !== item.id) return;
  const row = currentRow(hovered.row, item.id);
  if (!row) return;
  preview?.el.remove();
  const el = cardGhost(card.body, card.meta);
  el.classList.add("hush-card-preview");
  document.documentElement.appendChild(el);
  place(el, row);
  preview = { el, item, row, card };
  el.addEventListener("pointerenter", () => clearTimeout(hideTimer));
  el.addEventListener("pointerleave", () => { if (!dragging) scheduleHide(); });
  el.querySelector(".hush-card-header")?.addEventListener("pointerdown", (e) => startDrag(state, e));
}

/** Carry the previewed card by its header. */
async function startDrag(state, down) {
  if (!preview || down.button !== 0) return;
  down.preventDefault();
  down.stopPropagation();
  const { el, item, card } = preview;
  const box = el.getBoundingClientRect();
  const grab = { x: down.clientX - box.left, y: down.clientY - box.top };
  const [{ createDragFeedback }, { resolveCardTarget, dropsAsText }] = await Promise.all([
    import("../cards/card-drag-feedback.js"),
    import("../cards/card-drop.js"),
  ]);
  dragging = true;
  clearTimeout(hideTimer);
  const feedback = createDragFeedback([{ body: card.body, meta: card.meta }], grab, [el]);
  el.style.opacity = "0";
  const move = (e) => {
    feedback.show(resolveCardTarget(state, e.clientX, e.clientY), e.clientX, e.clientY, true, dropsAsText(e));
  };
  const end = (e) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
    feedback.clear();
    dragging = false;
    hide();
    if (e.type !== "pointerup") return;
    const moved = Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) > 4;
    if (!moved) return;
    const overPanel = document.elementsFromPoint(e.clientX, e.clientY).some((n) => n.closest?.("#panel-overlay"));
    if (overPanel) dropCardOnRow(state, item, e);
    else dropCardOutside(state, item, e.clientX, e.clientY, e);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
  move(down);
}

/** The card row now standing for `id` — the same element, or the one a
 *  re-render of the panel put in its place. */
function currentRow(row, id) {
  if (row.isConnected) return row;
  for (const el of document.querySelectorAll("#panel-overlay .tree-card-row, .tree-card-row")) {
    if (el.__cardItem?.id === id) return el;
  }
  return null;
}

let hovered = null;      // { row, id } while the pointer is on a card row

/** Preview card rows under `root` (the files panel) on hover. Listened
 *  for on the panel itself, once, with pointer events rather than
 *  `:hover` or a hover media query, so any row in the panel and any
 *  mouse-driven webview gets it; touch never does. */
export function attachCardPreview(root, state) {
  if (!root || root.__cardPreview) return;
  root.__cardPreview = true;
  root.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const row = e.target instanceof Element ? e.target.closest(".tree-card-row") : null;
    if (!row) return;
    hovered = { row, id: row.__cardItem?.id };
    clearTimeout(hideTimer);
    if (preview?.row === row) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => void show(state, row), preview ? 60 : SHOW_DELAY_MS);
  });
  root.addEventListener("pointerout", (e) => {
    const row = e.target instanceof Element ? e.target.closest(".tree-card-row") : null;
    if (!row || row.contains(e.relatedTarget)) return;
    if (hovered?.row === row) hovered = null;
    clearTimeout(showTimer);
    if (preview) scheduleHide();
  });
  // Dragging the row itself, or clicking it, puts the preview away.
  root.addEventListener("pointerdown", (e) => {
    if (e.target instanceof Element && e.target.closest(".tree-card-row")) { hovered = null; hide(); }
  });
}
