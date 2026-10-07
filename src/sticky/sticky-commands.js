/**
 * The command palette's Sticky Notes section: adding a sticky of each
 * scope, and two desk-wide actions —
 *
 *   - **Arrange Desk Stickies** lays the active desk's stickies out in
 *     columns from the top right of the window, oldest first: down the
 *     rightmost column, then down the next one to its left, each in a
 *     cell as big as the largest of them, as many rows as fit.
 *   - **Convert Desk Stickies to Cards** sends each of the active desk's
 *     stickies with any text to its Inbox as a card (the CARDS notebook,
 *     cards/card-courier.js), in the same order, and closes it. The cards
 *     start yellow, the sticky's own colour. An empty sticky is left where
 *     it is.
 *   - **Convert Current Sticky to Card** does the same for the one desk or
 *     document sticky being worked on (the active one): a desk sticky goes
 *     to its desk's Inbox, a document sticky to the Inbox of the desk the
 *     document is on.
 */
import {
  addSticky, canAddFileSticky, canAddProjectSticky,
  deskStickies, moveStickies, closeStickies, currentSticky,
} from "./sticky-notes.js";
import { findNodeByFileId, findAncestorIds } from "../state/tree-helpers.js";
import { HEADER_HEIGHT } from "./sticky-shared.js";
import { BOOKMARK_COLORS } from "../ui/bookmark-ui.js";

const GRID_GAP = 16;
const GRID_RIGHT = 24;
const GRID_TOP = 56;
const GRID_BOTTOM = 24;
// The card palette's yellow (the colour button's third swatch).
const STICKY_CARD_COLOR = BOOKMARK_COLORS[2];

const activeDeskId = (s) => s.getActiveDesk?.()?.id || null;
const hasDeskStickies = (s) => { const id = activeDeskId(s); return !!id && deskStickies(id).length > 0; };

async function toast(message) {
  const { showImportToast } = await import("../editor/import-toast.js");
  showImportToast(message, "info");
}

/** Lay the active desk's stickies out in columns from the top right. */
export function arrangeDeskStickies(state) {
  const id = activeDeskId(state);
  if (!id) return;
  const list = deskStickies(id);
  if (!list.length) return;
  const cellW = Math.max(...list.map((n) => n.width));
  const cellH = Math.max(...list.map((n) => (n.collapsed ? HEADER_HEIGHT : n.height)));
  const usable = window.innerHeight - GRID_TOP - GRID_BOTTOM;
  const rows = Math.max(1, Math.floor((usable + GRID_GAP) / (cellH + GRID_GAP)));
  // Each sticky's right edge sits on its column's right edge, so a
  // narrower one hugs the window side rather than the cell's left.
  const right = window.innerWidth - GRID_RIGHT;
  moveStickies(list.map((n, i) => ({
    id: n.id,
    x: right - Math.floor(i / rows) * (cellW + GRID_GAP) - n.width,
    y: GRID_TOP + (i % rows) * (cellH + GRID_GAP),
  })));
}

/** Turn the active desk's stickies into cards in its Inbox. */
export async function convertDeskStickiesToCards(state) {
  const id = activeDeskId(state);
  if (!id) return;
  const list = deskStickies(id).filter((n) => n.text.trim());
  if (!list.length) { void toast("No desk stickies with text to convert"); return; }
  const { sendCardToInbox } = await import("../cards/card-courier.js");
  const { specialNodeId } = await import("../state/state-desks.js");
  const inboxId = specialNodeId("__inbox__", id);
  const done = [];
  let home = "CARDS";
  try {
    // One at a time: each lands in the next free slot of the grid.
    for (const n of list) {
      home = await sendCardToInbox(state, n.text.replace(/\s+$/, ""), { bgColor: STICKY_CARD_COLOR }, inboxId);
      done.push(n.id);
    }
  } catch (err) {
    console.error("Convert desk stickies to cards failed:", err);
  }
  closeStickies(done);
  const left = list.length - done.length;
  void toast(`${done.length} ${done.length === 1 ? "sticky" : "stickies"} sent to Inbox / ${home}`
    + (left ? ` · ${left} couldn't be sent` : ""));
}

/** The desk a desk or document sticky belongs to, or null. A document
 *  sticky's target is `<ctx>:<fileId>`; the file's top ancestor is its
 *  desk. */
function deskOfSticky(state, note) {
  if (note.kind === "desk") return note.target || null;
  if (note.kind !== "file" || !note.target) return null;
  const fileId = note.target.slice(note.target.indexOf(":") + 1);
  const node = findNodeByFileId(state.fileTree || [], fileId);
  const path = node ? findAncestorIds(state.fileTree || [], node.id) : null;
  const top = path?.[0] && (state.fileTree || []).find((n) => n.id === path[0]);
  return top?.type === "desk" ? top.id : null;
}

/** The active sticky, when it is one this can convert. */
function convertibleSticky(state) {
  const note = currentSticky();
  return note && deskOfSticky(state, note) ? note : null;
}

/** Send the active desk / document sticky to its desk's Inbox as a card. */
export async function convertCurrentStickyToCard(state) {
  const note = convertibleSticky(state);
  if (!note) return;
  const text = note.text.replace(/\s+$/, "");
  if (!text.trim()) { void toast("This sticky is empty"); return; }
  const { confirmLongCard } = await import("../cards/card-confirm.js");
  if (!(await confirmLongCard(text))) return;
  const { sendCardToInbox } = await import("../cards/card-courier.js");
  const { specialNodeId } = await import("../state/state-desks.js");
  const deskId = deskOfSticky(state, note);
  const desk = (state.fileTree || []).find((n) => n.id === deskId);
  try {
    const home = await sendCardToInbox(state, text, null, specialNodeId("__inbox__", deskId));
    closeStickies([note.id]);
    void toast(`Sticky sent to ${desk?.name ? `${desk.name} / ` : ""}Inbox / ${home}`);
  } catch (err) {
    console.error("Convert sticky to card failed:", err);
    void toast("Couldn't send the sticky to the Inbox");
  }
}

export function buildStickyCommands({ icons }) {
  return [
    // Temporary reminders floating above every surface. File + project
    // stickies show while their target (or any file in the project) is
    // open; desk stickies while their desk is active; global always.
    { id: "sticky-file", section: "Sticky Notes", label: "Add File Sticky", icon: icons.sticky, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !canAddFileSticky(s),
      action: (s) => addSticky(s, "file") },
    { id: "sticky-project", section: "Sticky Notes", label: "Add Project Sticky", icon: icons.sticky, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !canAddProjectSticky(s),
      action: (s) => addSticky(s, "project") },
    { id: "sticky-desk", section: "Sticky Notes", label: "Add Desk Sticky", icon: icons.sticky, shortcutKey: null, ctx: "shared",
      hiddenIf: (s) => !s.getActiveDesk?.(),
      action: (s) => addSticky(s, "desk") },
    { id: "sticky-global", section: "Sticky Notes", label: "Add Global Sticky", icon: icons.sticky, shortcutKey: null, ctx: "shared",
      action: (s) => addSticky(s, "global") },
    { id: "sticky-arrange-desk", section: "Sticky Notes", label: "Arrange Desk Stickies", icon: icons.sticky, shortcutKey: null, ctx: "shared",
      keywords: "grid tidy layout",
      hiddenIf: (s) => !hasDeskStickies(s),
      action: (s) => arrangeDeskStickies(s) },
    { id: "sticky-current-to-card", section: "Sticky Notes", label: "Convert Current Sticky to Card", icon: icons.sticky, shortcutKey: null, ctx: "shared",
      keywords: "inbox",
      hiddenIf: (s) => !convertibleSticky(s),
      action: (s) => convertCurrentStickyToCard(s) },
    { id: "sticky-desk-to-cards", section: "Sticky Notes", label: "Convert Desk Stickies to Cards", icon: icons.sticky, shortcutKey: null, ctx: "shared",
      keywords: "inbox",
      hiddenIf: (s) => !hasDeskStickies(s),
      action: (s) => convertDeskStickiesToCards(s) },
  ];
}
