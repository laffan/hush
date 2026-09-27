/**
 * The open document changed on disk under an unsaved buffer.
 *
 * Every save used to be unconditional: whatever the editor held went to
 * disk, whatever the disk held was gone. Inside a synced desk folder that
 * is how the other device's edit disappears — most often in the document
 * that was open last, because it is read at launch, before the provider
 * has delivered the newer version, and the first keystroke makes the
 * stale buffer dirty. Nobody was asked; nothing said it happened.
 *
 * So the editor now remembers what its buffer was loaded from (the
 * *base*: the content, and the hash Rust gave it), and a save carries
 * that hash. When the file no longer holds it, Rust writes nothing and
 * hands back what it found (`desk_write::write_checked`). From here:
 *
 *  1. Both versions go into Versions first. Whatever happens next,
 *     neither is lost.
 *  2. Edits that don't overlap merge by themselves (`merge3.js`) and are
 *     saved on top of the version that's on disk now.
 *  3. Edits that do overlap are the user's call — keep both (the other
 *     device's version stays in the document, this device's becomes a
 *     new document beside it), keep this device's, or take the other's.
 *     The original file is never written until they choose, and never
 *     with anything but the version they chose.
 *
 * A file that vanished under the buffer (deleted or moved on the other
 * device) is re-checked against a fresh reconcile before anyone is asked,
 * because "moved, and our index hasn't heard yet" looks the same for a
 * moment.
 */

import { merge3, lineChanges } from "./merge3.js";
import { findNodeByFileId, findParentOfNode } from "../state/tree-helpers.js";
import { logActivity } from "../activity-log.js";

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** How long "decide later" holds saves of the file before asking again. */
const HOLD_MS = 60_000;
/** Upper bound on a hold while the question is on screen or a merge is in
 *  flight. A modal can be swept away by another one without its cancel
 *  firing; a hold with no end would stop the document saving at all. */
const OPEN_HOLD_MS = 10 * 60_000;
/** Merge-and-save rounds before a moving target is handed to the user. */
const MAX_ROUNDS = 3;

/** Record what the open doc's buffer is based on — the content as it was
 *  loaded or last saved, and Rust's hash of it. */
export function setDocBase(state, fileId, content, hash) {
  state.runtime.docBase = fileId && typeof content === "string"
    ? { fileId, content, hash: hash || null }
    : null;
}

function baseFor(state, fileId) {
  const b = state.runtime.docBase;
  return b && b.fileId === fileId ? b : null;
}

/** True while a conflict for `fileId` is waiting on the user. Saves of
 *  it are held meanwhile — the disk holds the other device's version,
 *  and nothing overwrites it before the user has said so. */
export function conflictPending(state, fileId) {
  const c = state.runtime.docConflict;
  if (!c || c.fileId !== fileId) return false;
  if (Date.now() > c.until) {
    state.runtime.docConflict = null;
    return false;
  }
  return true;
}

/** A held save still has to leave the buffer somewhere safe: into
 *  Versions, whenever it has moved on since the last time. */
export async function keepHeldBuffer(state, fileId) {
  const c = state.runtime.docConflict;
  if (!c || c.fileId !== fileId || state.currentFileId !== fileId || !state.editor) return;
  const text = state.editor.getContent();
  if (text === c.kept) return;
  c.kept = text;
  await snapshot(fileId, text);
}

/**
 * Save the open doc's buffer against its base. Returns true when the
 * content is on disk; false when the save was held, refused or failed —
 * the caller keeps the buffer dirty.
 */
export async function saveDocChecked(state, fileId, content) {
  const base = baseFor(state, fileId);
  let report;
  try {
    report = await invoke("save_file", { id: fileId, content, baseHash: base?.hash || null });
  } catch (e) {
    console.error("Save failed:", e);
    logActivity("files", "error", "Save failed", { fileId, error: String(e) });
    return false;
  }
  if (report?.conflict) {
    void handleSaveConflict(state, fileId, report);
    return false;
  }
  setDocBase(state, fileId, content, report?.hash);
  return true;
}

async function handleSaveConflict(state, fileId, report) {
  if (conflictPending(state, fileId)) return;
  state.runtime.docConflict = { fileId, until: Date.now() + OPEN_HOLD_MS, kept: null };
  try {
    await settle(state, fileId, report, 0);
  } catch (e) {
    console.error("conflict handling failed:", e);
    logActivity("files", "error", "Conflict handling failed", { fileId, error: String(e) });
    // Stay held for a while rather than fall back to overwriting.
    state.runtime.docConflict = { fileId, until: Date.now() + HOLD_MS, kept: null };
  }
}

function release(state, fileId) {
  if (state.runtime.docConflict?.fileId === fileId) state.runtime.docConflict = null;
}

function docName(state, fileId) {
  return findNodeByFileId(state.fileTree, fileId)?.name || "This document";
}

function buffer(state, fileId) {
  return state.currentFileId === fileId && state.editor ? state.editor.getContent() : null;
}

async function snapshot(fileId, content) {
  if (typeof content !== "string") return;
  try { await invoke("create_snapshot", { documentId: fileId, content }); }
  catch (e) { console.warn("conflict snapshot failed:", e); }
}

async function toast(message) {
  try {
    const { showImportToast } = await import("../editor/import-toast.js");
    showImportToast(message, "info");
  } catch (_) {}
}

/** Put `text` in the editor as a programmatic change — per changed run of
 *  lines, so the caret stays where the user left it. */
function showInEditor(state, fileId, text) {
  if (state.currentFileId !== fileId || !state.editor) return false;
  const cur = state.editor.getContent();
  if (cur === text) return true;
  state.acquirePullLock(fileId);
  try {
    if (typeof state.editor.applyExternalChanges === "function") {
      state.editor.applyExternalChanges(lineChanges(cur, text));
    }
    if (state.editor.getContent() !== text) state.editor.applyExternalContent(text);
  } finally {
    state.releasePullLock();
  }
  return true;
}

async function settle(state, fileId, report, round) {
  const name = docName(state, fileId);
  const mine = buffer(state, fileId);
  if (mine == null) return release(state, fileId); // the editor moved on
  await snapshot(fileId, mine);
  state.runtime.docConflict.kept = mine;

  if (report.conflict.kind === "missing") return settleMissing(state, fileId, name, round);

  const theirs = report.conflict.diskContent ?? "";
  await snapshot(fileId, theirs);
  logActivity("files", "warn", `"${name}" changed on disk while it had unsaved edits here`, { fileId, round });

  const base = baseFor(state, fileId);
  const now = buffer(state, fileId);
  if (now == null) return release(state, fileId);
  const merged = base && round < MAX_ROUNDS ? merge3(base.content, now, theirs) : { clean: false };
  if (merged.clean) {
    // The disk holds `theirs` now; that is what the merged text is based on.
    setDocBase(state, fileId, theirs, report.hash);
    showInEditor(state, fileId, merged.text);
    state.dirty = false;
    const next = await invoke("save_file", { id: fileId, content: merged.text, baseHash: report.hash });
    if (next?.conflict) return settle(state, fileId, next, round + 1);
    setDocBase(state, fileId, merged.text, next?.hash);
    release(state, fileId);
    logActivity("files", "info", `Merged another device's edits into "${name}"`, { fileId });
    try {
      const { appendSyncLog } = await import("./sync-feedback.js");
      appendSyncLog(`Merged edits from another device into "${name}" — both originals are in Versions`);
    } catch (_) {}
    return toast(`Merged edits from another device into “${name}”`);
  }
  return ask(state, fileId, name, theirs, report.hash);
}

async function ask(state, fileId, name, theirs, theirsHash) {
  const { showChoiceModal } = await import("../sidebar/files-panel-shared.js");
  await new Promise((done) => {
    showChoiceModal({
      title: `“${name}” changed on another device`,
      message: "It was edited here and on another device, and the edits overlap. "
        + "Both versions are already saved in Versions, whichever you choose.",
      options: [
        { id: "both", label: "Keep both",
          detail: `“${name}” takes the other device's version; this device's is saved beside it as a new document.` },
        { id: "mine", label: "Keep this device's version", detail: "It replaces the other device's edits." },
        { id: "theirs", label: "Use the other device's version", detail: "It replaces the edits made here." },
      ],
      onPick: (choice) => { void choose(state, fileId, name, choice, theirs, theirsHash).finally(done); },
      onCancel: () => {
        // Decide later: keep holding saves, keep the buffer in Versions,
        // ask again after a while.
        state.runtime.docConflict = { fileId, until: Date.now() + HOLD_MS, kept: state.runtime.docConflict?.kept ?? null };
        logActivity("files", "info", `Left the conflict in "${name}" for later`, { fileId });
        void toast(`“${name}” isn't saved over the other device's version until you choose — Hush will ask again`);
        done();
      },
    });
  });
}

async function choose(state, fileId, name, choice, theirs, theirsHash) {
  logActivity("files", "info", `Conflict in "${name}": ${choice}`, { fileId });
  if (choice === "mine") {
    const mine = buffer(state, fileId);
    if (mine == null) return release(state, fileId);
    const next = await invoke("save_file", { id: fileId, content: mine, baseHash: theirsHash });
    if (next?.conflict) {
      release(state, fileId);
      return handleSaveConflict(state, fileId, next);
    }
    setDocBase(state, fileId, mine, next?.hash);
    state.dirty = false;
    return release(state, fileId);
  }
  if (choice === "both") {
    const mine = buffer(state, fileId);
    if (mine != null) await saveAsNewDoc(state, fileId, name, mine);
  }
  // "theirs", and the second half of "both": the document shows what the
  // other device saved, which is what the disk already holds.
  showInEditor(state, fileId, theirs);
  setDocBase(state, fileId, theirs, theirsHash);
  state.dirty = false;
  release(state, fileId);
}

/** This device's text as a new document beside the original — created
 *  through the ordinary create path (staged, then placed by the tree
 *  save, which never writes onto an occupied name), so it can't land on
 *  top of anything. */
async function saveAsNewDoc(state, fileId, name, text) {
  const node = findNodeByFileId(state.fileTree, fileId);
  const parent = node ? findParentOfNode(state.fileTree, node.id) : null;
  await state.newFile(parent?.id || null, { openImmediately: false, initialContent: text, initialName: name });
  await toast(`This device's version of “${name}” was saved beside it as a new document`);
}

/** The file is gone from where the index says it lives. Give the
 *  reconcile one pass to learn where it went — a move on the other
 *  device looks exactly like this until our index hears of it — then
 *  retry; only a file that is still gone gets a question. */
async function settleMissing(state, fileId, name, round) {
  if (round === 0) {
    try {
      const { reconcileDesk } = await import("./desk-roots.js");
      for (const desk of state.fileTree || []) {
        if (desk.type === "desk" && state.deskRoots?.[desk.id]) await reconcileDesk(state, desk.id);
      }
    } catch (_) {}
    const mine = buffer(state, fileId);
    if (mine == null) return release(state, fileId);
    const base = baseFor(state, fileId);
    const next = await invoke("save_file", { id: fileId, content: mine, baseHash: base?.hash || null });
    if (!next?.conflict) {
      setDocBase(state, fileId, mine, next?.hash);
      state.dirty = false;
      return release(state, fileId);
    }
    return settle(state, fileId, next, round + 1);
  }
  const { showChoiceModal } = await import("../sidebar/files-panel-shared.js");
  await new Promise((done) => {
    showChoiceModal({
      title: `“${name}” is gone from the desk folder`,
      message: "It was deleted or moved on another device while it had unsaved edits here. "
        + "Your version is saved in Versions.",
      options: [
        { id: "new", label: "Keep my version as a new document", detail: "Saved in the same place, under the same name." },
        { id: "drop", label: "Let it go", detail: "Nothing is written. Your version stays in Versions." },
      ],
      onPick: async (choice) => {
        logActivity("files", "info", `"${name}" was gone from disk: ${choice}`, { fileId });
        if (choice === "new") {
          const mine = buffer(state, fileId);
          if (mine != null) await saveAsNewDoc(state, fileId, name, mine);
        }
        state.dirty = false;
        release(state, fileId);
        done();
      },
      onCancel: () => {
        state.runtime.docConflict = { fileId, until: Date.now() + HOLD_MS, kept: state.runtime.docConflict?.kept ?? null };
        done();
      },
    });
  });
}
