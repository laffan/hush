/**
 * Which cards a notebook holds, for the sidebar's card rows.
 *
 * A Doc's cards are read straight from its text (the library listing
 * carries document content). A notebook's live inside its file, and
 * unpacking a notebook to list its cards on every sidebar render is out
 * of the question — a proof is tens of MB. So every canvas publishes its
 * cards as they change (`publishNotebookCards`, from the card layer), and
 * every write that adds or takes one from a notebook on disk does the
 * same; the record is kept per device in localStorage, like the notebook
 * bookmark colours (links/bookmark-colors.js). A notebook this device has
 * never opened lists its cards once it has been.
 */

export const CARD_INDEX_EVENT = "hush-card-index-changed";
/** A notebook's last card just left it, and it holds other things too
 *  (`detail.fileId`) — cards/card-home-rescue.js keeps a CARDS notebook
 *  in that state from going out of sight. */
export const CARDS_EMPTIED_EVENT = "hush-cards-emptied";
const STORE_KEY = "hush-nb-card-index";

/** { [notebookFileId]: [{ id, title, bgColor? }] } */
let index = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(index)); } catch { /* storage unavailable */ }
}

let pending = false;
function announce() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    window.dispatchEvent(new Event(CARD_INDEX_EVENT));
  });
}

/** A Doc's cards changed where it is open (cards/card-doc-plugin.js):
 *  the sidebar re-reads them from its text. */
export function announceCardsChanged() {
  announce();
}

/** `otherContent`: the notebook holds something besides its cards
 *  (notebook/card-shape.ts#hasNonCardShapes). */
export function publishNotebookCards(fileId, cards, { otherContent = false } = {}) {
  if (!fileId) return;
  const next = (cards || []).map((c) => ({ id: c.id, title: c.title, ...(c.bgColor ? { bgColor: c.bgColor } : {}) }));
  const prev = index[fileId];
  if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
  if (!prev && !next.length) return;
  index = { ...index, [fileId]: next };
  save();
  announce();
  if (prev?.length && !next.length && otherContent) {
    window.dispatchEvent(new CustomEvent(CARDS_EMPTIED_EVENT, { detail: { fileId } }));
  }
}

/** Whether this device knows what cards notebook `fileId` holds (its
 *  canvas has published, or a write here recorded them). */
export function notebookCardsKnown(fileId) {
  return Object.prototype.hasOwnProperty.call(index, fileId);
}

export function notebookCards(fileId) {
  return index[fileId] || [];
}
