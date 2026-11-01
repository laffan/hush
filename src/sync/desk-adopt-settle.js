/**
 * What a plain folder made into a desk (`desk-roots.js#adoptDeskFolder`,
 * initialised in place rather than joined) gets once its files are in:
 *
 * - **Its folders start closed.** A folder brought in from disk can hold
 *   a great deal; the sidebar opens on the desk's top level, and the
 *   user opens what they want.
 * - **An Archive it already had is the user's to have organised.** An
 *   `Archive/` directory folds into the desk's Archive (Rust's
 *   `desk_specials` seeds it before the scan), and the Archive's tidying
 *   (state/archive-groups.js) would sort its contents into month and
 *   year folders on its own 4 s after the next boot. That is a lot of
 *   moving in someone's folder unasked, so it asks: Organize runs the
 *   tidy now, Leave as is marks the Archive `archiveUntidied`, which
 *   every tidy respects until **Organize Archive** in its row menu.
 */
import { collapseRows } from "../sidebar/files-panel-reveal.js";
import { isAnySpecialId } from "../sidebar/files-panel-rows.js";

const deskNode = (state, deskId) => (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);

/** Every folder and project under the desk, at any depth, bar its
 *  specials (the Inbox stays open; the rest are closed by default). */
function foldersUnder(nodes, out = []) {
  for (const n of nodes || []) {
    if ((n.type === "folder" || n.type === "project") && !isAnySpecialId(n.id)) out.push(n.id);
    if (n.children?.length) foldersUnder(n.children, out);
  }
  return out;
}

export function collapseAdoptedFolders(state, deskId) {
  collapseRows(state, foldersUnder(deskNode(state, deskId)?.children));
}

/** Ask about the Archive a newly made desk brought with it, if it holds
 *  anything. Resolves once answered. */
export async function offerArchiveTidy(state, deskId) {
  const archive = (deskNode(state, deskId)?.children || []).find((c) => c.id === `__archive__:${deskId}`);
  if (!archive?.children?.length) return;
  const { showConfirmModal } = await import("../sidebar/files-panel-shared.js");
  const organize = await new Promise((resolve) => showConfirmModal({
    title: "Organize the Archive?",
    message: "This folder already has an Archive. Hush can sort what's in it into folders by month"
      + " (for the last year) and by year (before that), going by when each item was last edited."
      + " Folders inside it are moved whole, never opened up.",
    confirmLabel: "Organize",
    onConfirm: () => resolve(true),
    onCancel: () => resolve(false),
  }));
  if (organize) {
    await organizeArchive(state, archive);
    return;
  }
  archive.archiveUntidied = true;
  await state.saveFileTree();
}

/** Tidy an Archive now, lifting a Leave as is. Also the Archive row
 *  menu's **Organize Archive**. */
export async function organizeArchive(state, archive) {
  delete archive.archiveUntidied;
  const { tidyArchiveNode } = await import("../state/archive-groups.js");
  tidyArchiveNode(archive, new Map((state.files || []).map((f) => [f.id, f.modified])));
  await state.saveFileTree();
  state.emit("files-changed");
}
