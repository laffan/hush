/**
 * The command palette's Sticky Notes section: adding a sticky of each
 * scope, and two desk-wide actions —
 *
 *   - **Arrange Desk Stickies** lays the active desk's stickies out in a
 *     grid from the top left of the window, oldest first, each in a cell
 *     as big as the largest of them, as many columns as fit.
 *   - **Convert Desk Stickies to Cards** sends each of the active desk's
 *     stickies with any text to its Inbox as a card (the CARDS notebook,
 *     cards/card-courier.js), in the same order, and closes it. An empty
 *     sticky is left where it is.
 */
import {
  addSticky, canAddFileSticky, canAddProjectSticky,
  deskStickies, moveStickies, closeStickies,
} from "./sticky-notes.js";
import { HEADER_HEIGHT } from "./sticky-shared.js";

const GRID_GAP = 16;
const GRID_LEFT = 24;
const GRID_TOP = 56;

const activeDeskId = (s) => s.getActiveDesk?.()?.id || null;
const hasDeskStickies = (s) => { const id = activeDeskId(s); return !!id && deskStickies(id).length > 0; };

async function toast(message) {
  const { showImportToast } = await import("../editor/import-toast.js");
  showImportToast(message, "info");
}

/** Lay the active desk's stickies out in a grid. */
export function arrangeDeskStickies(state) {
  const id = activeDeskId(state);
  if (!id) return;
  const list = deskStickies(id);
  if (!list.length) return;
  const cellW = Math.max(...list.map((n) => n.width));
  const cellH = Math.max(...list.map((n) => (n.collapsed ? HEADER_HEIGHT : n.height)));
  const usable = window.innerWidth - GRID_LEFT * 2;
  const columns = Math.max(1, Math.floor((usable + GRID_GAP) / (cellW + GRID_GAP)));
  moveStickies(list.map((n, i) => ({
    id: n.id,
    x: GRID_LEFT + (i % columns) * (cellW + GRID_GAP),
    y: GRID_TOP + Math.floor(i / columns) * (cellH + GRID_GAP),
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
      home = await sendCardToInbox(state, n.text.replace(/\s+$/, ""), null, inboxId);
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
    { id: "sticky-desk-to-cards", section: "Sticky Notes", label: "Convert Desk Stickies to Cards", icon: icons.sticky, shortcutKey: null, ctx: "shared",
      keywords: "inbox",
      hiddenIf: (s) => !hasDeskStickies(s),
      action: (s) => convertDeskStickiesToCards(s) },
  ];
}
