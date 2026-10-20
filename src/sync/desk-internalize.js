/**
 * Convert Local Desk to Internal — the way back from a local desk, in two
 * forms, because "internal" can mean two different things for a folder
 * a sync provider is also carrying:
 *
 *   - **Keep the folder** (`desk_copy_internal`): a new internal desk is
 *     built from a copy of the folder — the same zip-and-re-identify pass
 *     an archive restore takes, so the copy shares no desk id or fileId
 *     with the folder — and the local desk is then detached from this
 *     device the way archiving detaches one. Nothing in the folder is
 *     written, so another device still using it carries on undisturbed.
 *   - **Move the files into Hush** (`desk_make_internal`, the older Make
 *     Desk Internal): the desk keeps its identity and its folder's
 *     contents move into app data. The folder is emptied — and removed if
 *     nothing else was in it — so it is no longer a desk for anyone.
 */

import { logActivity } from "../activity-log.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

async function invoke(cmd, args) {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(cmd, args);
}

/** Ask which kind of conversion, then run it. */
export async function convertLocalDeskToInternal(state, deskId) {
  if (!IS_TAURI || !state.deskRoots?.[deskId]) return;
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  const name = desk?.name || "this desk";
  const { showChoiceModal } = await import("../sidebar/files-panel-shared.js");
  showChoiceModal({
    title: `Make “${name}” internal`,
    message: "An internal desk lives inside Hush rather than in a folder on disk.",
    options: [
      {
        id: "copy",
        label: "Copy into Hush, leave the folder",
        detail: "A new internal desk with everything in this one. The folder on disk stays exactly as it is, "
          + "for any other device still using it; this device simply stops using it.",
      },
      {
        id: "move",
        label: "Move the files into Hush",
        detail: "The desk's files move out of the folder into Hush. The folder is no longer a desk — "
          + "on this device or any other.",
      },
    ],
    onPick: (choice) => {
      void (choice === "copy" ? copyIntoHush(state, deskId, name) : moveIntoHush(state, deskId));
    },
  });
}

/** Everything unsaved goes to disk before the folder is read. */
async function flushOpenSurfaces(state) {
  try {
    if (state.dirty) await state.saveCurrentFile();
    if (state.currentNotebookFileId) {
      const { saveNotebook } = await import("../notebook/notebook-bridge.js");
      await saveNotebook();
    }
  } catch (e) {
    logActivity("desks", "warn", "Flush before making a desk internal failed", { error: String(e) });
  }
}

async function copyIntoHush(state, deskId, name) {
  await flushOpenSurfaces(state);
  let newId;
  try {
    newId = await invoke("desk_copy_internal", { deskId, newName: name });
  } catch (e) {
    window.alert(`Couldn't copy the desk into Hush:\n${e?.message || e}`);
    return;
  }
  // The copy is on disk; bring it into this window's tree and registry,
  // where it lands at the end — put it where the local desk was.
  state.fileTree = await invoke("get_file_tree");
  state.files = await invoke("list_files");
  const { syncDesksRegistryWithTree } = await import("../state/state-desks.js");
  await syncDesksRegistryWithTree(state);
  const order = (state.settings?.desks || []).map((d) => d.id).filter((id) => id !== newId);
  const at = order.indexOf(deskId);
  if (at >= 0 && typeof state.reorderDesks === "function") {
    order.splice(at, 0, newId);
    try { await state.reorderDesks(order); } catch (_) {}
  }
  try {
    const { pullDeskMeta } = await import("./desk-meta.js");
    await pullDeskMeta(state, newId);
  } catch (_) {}
  await state.setActiveDesk(newId);
  // Detach the local desk — the archive path's removal: the root is
  // unregistered and the folder left alone.
  await state.deleteDesk(deskId, { archived: true });
  state.emit("desks-changed");
  state.emit("files-changed");
  logActivity("desks", "info", `Copied local desk "${name}" into an internal desk`, { from: deskId, to: newId });
  const { showImportToast } = await import("../editor/import-toast.js");
  showImportToast(`“${name}” is now an internal desk — the folder on disk was left as it was`, "info");
}

async function moveIntoHush(state, deskId) {
  await flushOpenSurfaces(state);
  const { makeDeskInternal } = await import("./desk-roots.js");
  if (await makeDeskInternal(state, deskId)) {
    state.emit("desks-changed");
    state.emit("files-changed");
  }
}
