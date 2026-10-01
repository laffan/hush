/**
 * A CARDS notebook (card-courier.js) is the cards' home, and with no
 * cards left it stands hidden in the sidebar until the next one is sent
 * (sidebar/files-panel-cards.js#cardsHomeIsEmpty). That is only safe
 * while cards are all it holds: one the user has also written or drawn
 * in would take that work out of sight with its last card.
 *
 * So when the last card leaves a CARDS notebook that holds anything else
 * (card-index.js#CARDS_EMPTIED_EVENT), it stops being the cards' home:
 * it moves to the top of its desk's Inbox, named for the date and time.
 * Nothing is copied and nothing deleted — the notebook keeps its file,
 * so a canvas showing it carries on — and the next card sent to that
 * container makes a fresh CARDS notebook.
 */

import { findNode, findNodeByFileId, removeNode, insertNode, uniqueChildName, isCardsHome } from "../state/tree-helpers.js";
import { CARDS_EMPTIED_EVENT } from "./card-index.js";

/** "2026-10-01 14.05": the time it was set aside (a colon can't go in a
 *  file name). */
export function stampName(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

/** The Inbox of the desk holding `nodeId`. */
async function inboxFor(state, nodeId) {
  const { specialNodeId } = await import("../state/state-desks.js");
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && findNode(n.children || [], nodeId));
  const id = desk ? specialNodeId("__inbox__", desk.id) : null;
  return id && findNode(state.fileTree, id) ? id : state.getInboxId();
}

/** Move the CARDS notebook behind `fileId` to its Inbox under a
 *  timestamp. Returns the name it now has, or null when it isn't a
 *  CARDS notebook (any more). */
export async function keepEmptiedCardsHome(state, fileId) {
  const node = findNodeByFileId(state.fileTree, fileId);
  if (!node || !isCardsHome(node)) return null;
  const inboxId = await inboxFor(state, node.id);
  const inbox = findNode(state.fileTree, inboxId);
  if (!inbox) return null;
  const oldName = node.name;
  const name = uniqueChildName(inbox, stampName(), "notebook", node.id);
  removeNode(state.fileTree, node.id);
  node.name = name;
  insertNode(state.fileTree, node, inboxId, findNode, true); // newest-first, like any new arrival
  const { renameFileRecord } = await import("../state/state-tree.js");
  await renameFileRecord(state, fileId, name);
  await state.saveFileTree();
  state.syncRenameNode?.(node.id, oldName, node.type);
  state.emit("files-changed");
  const { showImportToast } = await import("../editor/import-toast.js");
  showImportToast(`CARDS held more than cards, so it's in the Inbox now as "${name}"`, "info");
  return name;
}

/** Boot: act on every CARDS notebook whose last card leaves it. */
export function watchEmptiedCardsHomes() {
  window.addEventListener(CARDS_EMPTIED_EVENT, (e) => {
    const state = window.__hushState__;
    const fileId = e.detail?.fileId;
    if (!state || !fileId) return;
    keepEmptiedCardsHome(state, fileId).catch((err) => console.error("Keeping the emptied CARDS notebook failed:", err));
  });
}
