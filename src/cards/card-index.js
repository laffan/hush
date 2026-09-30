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

export function publishNotebookCards(fileId, cards) {
  if (!fileId) return;
  const next = (cards || []).map((c) => ({ id: c.id, title: c.title, ...(c.bgColor ? { bgColor: c.bgColor } : {}) }));
  const prev = index[fileId];
  if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
  if (!prev && !next.length) return;
  index = { ...index, [fileId]: next };
  save();
  announce();
}

export function notebookCards(fileId) {
  return index[fileId] || [];
}
