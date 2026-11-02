/**
 * A board row's pane — the document opened to the right of its outline,
 * scrolled to the heading that was clicked.
 *
 * It is a real pane (pane-manager's `createPane`), so editing, saving,
 * word caps, styles and the pane chrome are the ones every pane has. It
 * is made **inline** — the mode wikilink peeks use — and its element is
 * moved into the row's slot rather than a CodeMirror widget: inline is
 * what makes the pane system leave its position alone, size it from
 * `pane.inline.height` (the bottom handle resizes the slot with it) and
 * turn a drag on its title bar into a floating pane. `desktopPane` keeps
 * it visible while the Desktop hides every other pane; `desktopRow`
 * keeps it out of the saved pane list, since a row's pane only means
 * anything while the board is up. One pane per row: a second heading
 * scrolls the pane that is there.
 */
import { panes } from "../../pane/pane-state.js";

const HEIGHT = 460;

/** fileId → pane, for the rows of the board on screen. */
const rowPanes = new Map();

export function rowPaneFor(fileId) {
  const pane = rowPanes.get(fileId);
  if (pane && panes.get(pane.id) === pane && pane.inline) return pane;
  return null;
}

/** Put the row's pane (if it has one) back into a freshly built slot. */
export function adoptSlot(fileId, slot) {
  const pane = rowPaneFor(fileId);
  if (!pane) return false;
  mount(pane, slot);
  return true;
}

function mount(pane, slot) {
  pane._inlineHost = slot;
  slot.classList.add("open");
  slot.style.height = (pane.inline.height || HEIGHT) + "px";
  slot.closest(".board-row")?.classList.add("has-pane");
  const el = pane.el;
  el.classList.add("inline-pane", "board-row-pane");
  Object.assign(el.style, { position: "absolute", left: "0px", top: "0px", width: "100%", height: "100%", transform: "" });
  if (el.parentNode !== slot) slot.appendChild(el);
  pane.width = slot.clientWidth || pane.width;
  requestAnimationFrame(() => pane.editor?.view?.requestMeasure?.());
}

/** Scroll a pane's editor so `from` sits near the top, caret there.
 *  Only the pane's own scroller moves: CodeMirror's scrollIntoView also
 *  scrolls every scrollable ancestor to line the target up, which pulled
 *  the whole board down until the pane's top (position 0 — the
 *  document's name) sat under the sticky header. The board itself moves
 *  only as far as it takes to show the pane (`nearest`). */
function scrollTo(pane, from) {
  const view = pane.editor?.view;
  if (!view) return;
  const a = Math.max(0, Math.min(view.state.doc.length, from || 0));
  view.dispatch({ selection: { anchor: a } });
  view.requestMeasure({
    read: () => {
      const scroller = view.scrollDOM;
      const target = view.documentTop + view.lineBlockAt(a).top;
      return scroller.scrollTop + target - scroller.getBoundingClientRect().top - 16;
    },
    write: (top) => { view.scrollDOM.scrollTop = Math.max(0, top); },
  });
  view.contentDOM.focus({ preventScroll: true });
  pane._inlineHost?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/** Open the row's pane in `slot`, or scroll the one already there. A
 *  material notebook's row is a pane from the start (`type: "notebook"`,
 *  the way a wikilink peeks one inline), with no place to scroll to. */
export async function openRowPane(state, { fileId, name, slot, containerId, from = 0, type = "document", height = HEIGHT, focus = true }) {
  const existing = rowPaneFor(fileId);
  if (existing) {
    mount(existing, slot);
    if (focus) scrollTo(existing, from);
    return existing;
  }
  // A re-render while the pane is still being made reuses that one.
  if (making.has(fileId)) {
    const pane = await making.get(fileId);
    if (pane) mount(pane, slot);
    return pane;
  }
  const job = makePane(fileId, name, type, containerId, height);
  making.set(fileId, job);
  const pane = await job.finally(() => making.delete(fileId));
  if (!pane) return null;
  mount(pane, slot.isConnected ? slot : pane._inlineHost || slot);
  if (focus) requestAnimationFrame(() => scrollTo(pane, from));
  return pane;
}

const making = new Map();

async function makePane(fileId, name, type, containerId, height) {
  const { createPane } = await import("../../pane/pane-manager.js");
  const pane = await createPane(fileId, name, type, 0, 0, {
    ownerContext: "dt:" + containerId,
    allowDuplicate: true,
    desktopPane: true,
    skipFocus: true,
    inline: { anchorTitle: "", occurrence: 0, height },
  });
  if (!pane) return null;
  pane.desktopRow = true;
  rowPanes.set(fileId, pane);
  return pane;
}

/** Forget panes that were closed, or dragged out of their row (those
 *  are ordinary floating panes now, and are kept like one). Returns the
 *  fileIds whose row lost its pane. */
export function sweepRowPanes() {
  const gone = [];
  for (const [fileId, pane] of rowPanes) {
    if (panes.get(pane.id) === pane && pane.inline) continue;
    if (panes.get(pane.id) === pane) pane.desktopRow = false;
    rowPanes.delete(fileId);
    gone.push(fileId);
  }
  return gone;
}

/** Close every row pane (the board is closing). */
export async function closeRowPanes() {
  if (!rowPanes.size) return;
  const { closePane } = await import("../../pane/pane-manager.js");
  for (const pane of rowPanes.values()) {
    if (panes.get(pane.id) === pane && pane.inline) closePane(pane.id);
  }
  rowPanes.clear();
}
