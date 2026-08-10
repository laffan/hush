/**
 * Stack lifecycle bridge — mount, unmount, autosave, settings sync.
 * Mirrors the pattern used by notebook-bridge.js and pdf-bridge.js.
 */

import { decodeStackContent, encodeStackContent } from "./stack-content.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

let currentInstance = null;
let currentFileId = null;
let autosaveTimer = null;
let currentState = null; // AppState ref, for the local-sync write echo flag
let currentContainer = null; // for rebuilding in place on an external change
// Last content actually written, keyed implicitly by currentFileId (reset
// on mount). Lets the autosave tick skip the disk write + sync push when
// the stack hasn't changed, instead of churning IPC/network every 2 s.
let lastSavedContent = null;

export async function mountStack(container, fileId, state) {
  if (currentInstance) {
    await saveStack();
    currentInstance.destroy();
    currentInstance = null;
  }
  container.innerHTML = "";
  currentFileId = fileId;
  currentState = state;
  currentContainer = container;

  let content = null;
  const { parseLocalSentinel } = await import("../sync/local-sync.js");
  const local = parseLocalSentinel(fileId);
  if (local) {
    try {
      const { readFile } = await import("../sync/local-sync.js");
      content = await readFile(local.folderId, local.relPath);
    } catch (e) {
      console.error("Failed to load local-sync stack:", e);
    }
  } else if (IS_TAURI) {
    try {
      const file = await tauriInvoke("load_file", { id: fileId });
      content = file.content;
    } catch (e) {
      console.error("Failed to load stack:", e);
    }
  }

  const data = decodeStackContent(content);
  const { StackComponent } = await import("./stack-component.js");
  currentInstance = new StackComponent(container, data, state);

  // Seed the dirty baseline so the first autosave tick doesn't rewrite
  // the content we just loaded. Re-serialize through the same encoder the
  // save path uses so the strings compare apples-to-apples.
  lastSavedContent = encodeLive(currentInstance);

  startAutosave(state);
}

export async function unmountStack() {
  stopAutosave();
  const result = await saveStack();
  if (currentInstance) {
    currentInstance.destroy();
    currentInstance = null;
  }
  currentFileId = null;
  currentContainer = null;
  return result;
}

export function getStackInstance() {
  return currentInstance;
}

export function getStackFileId() {
  return currentFileId;
}

/** Serialize the live component through the same encoder the save path
 *  uses, so its result compares apples-to-apples with `lastSavedContent`
 *  and with content read back off disk. */
function encodeLive(instance) {
  const s = instance.serialize();
  return encodeStackContent(s.items, s.scrollX, {
    scrollY: s.scrollY,
    scrollDirection: s.scrollDirection,
  });
}

/** The part of a `.hushstack` that is the *stack*, as opposed to where
 *  this screen happens to be looking at it.
 *
 *  Scroll offsets, per-item scroll, notebook cameras and PDF zoom all
 *  ride in the same envelope, and the autosave rewrites the file when
 *  any of them move — so a far device merely scrolling produces a
 *  changed file every couple of seconds. Rebuilding on that would tear
 *  down and re-mount every live column while the user was reading. Only
 *  a change in this signature is a change worth reacting to. */
function structureOf(raw) {
  const data = decodeStackContent(raw);
  return JSON.stringify({
    dir: data.scrollDirection || "horizontal",
    items: (data.items || []).map((i) => [
      i.id, i.fileId, i.fileType, i.width, i.height, i.open, i.spineColor,
    ]),
  });
}

/** Apply an externally-produced `.hushstack` to the open stack.
 *
 *  The stack file is *structure* — which files are columns, in what
 *  order, at what width — so there is no in-place mirror the way a
 *  notebook has: the component is rebuilt around the incoming layout.
 *  That is a heavy enough operation to be worth three guards, and the
 *  reasons are the same ones the doc and notebook paths use:
 *
 *  - our own write coming back is a no-op;
 *  - a stack with unsaved local changes is strictly newer than disk, so
 *    it keeps what it has and the next autosave reasserts it;
 *  - a difference that is only *viewport* — their scroll, their camera —
 *    is not a change to this stack at all.
 *
 *  What survives the rebuild is this device's viewport: the scroll
 *  offsets and each surviving column's scroll / camera / zoom are
 *  carried across, so a far-side reorder doesn't also yank the reader
 *  back to the top. Same reasoning as the notebook mirror deliberately
 *  dropping the incoming camera. */
export async function reloadStackContent(jsonContent) {
  if (!currentInstance || !currentFileId || !currentContainer) return;
  if (typeof jsonContent !== "string" || jsonContent === lastSavedContent) return;
  const forFileId = currentFileId;
  const live = encodeLive(currentInstance);
  if (live !== lastSavedContent) return; // unsaved local changes win
  if (structureOf(jsonContent) === structureOf(live)) return;

  // Resolve the module *before* tearing anything down, so the swap below
  // runs in one synchronous stretch. An `await` in the middle of it lets
  // the 2 s autosave tick land on a destroyed component, serialize the
  // items it still holds, and write the pre-reload layout straight back
  // over the change that prompted the reload.
  const { StackComponent } = await import("./stack-component.js");
  // The stack could have been closed or swapped across that await.
  if (currentFileId !== forFileId || !currentInstance || !currentContainer) return;
  const incoming = decodeStackContent(jsonContent);
  const snapshot = currentInstance.serialize();
  const mine = new Map((snapshot.items || []).map((i) => [i.id, i]));
  for (const item of incoming.items) {
    const local = mine.get(item.id);
    if (!local) continue;
    item.scrollY = local.scrollY ?? item.scrollY;
    item.cameraState = local.cameraState ?? item.cameraState;
    item.pdfZoom = local.pdfZoom ?? item.pdfZoom;
  }
  incoming.scrollX = snapshot.scrollX ?? incoming.scrollX;
  incoming.scrollY = snapshot.scrollY ?? incoming.scrollY;

  currentInstance.destroy(); // column teardown flushes pending column edits
  currentContainer.innerHTML = "";
  currentInstance = new StackComponent(currentContainer, incoming, currentState);
  lastSavedContent = encodeLive(currentInstance);
}

/** Re-read every mounted column's file and apply it.
 *
 *  The `.hushstack` is only the layout; the text in a column is an
 *  ordinary doc (or notebook) syncing on its own, and a column editor
 *  never re-reads by itself. Without this the stack would show the far
 *  device's columns wrapped around this device's stale text — which
 *  looks exactly like "stacks don't sync". Each column applies under its
 *  own dirty guard (see `stack-item-mount.js`), so a column being typed
 *  into is left alone. Project columns are skipped: their buffer is
 *  several files concatenated behind separators, and splicing an
 *  external change into that is not a thing to do blind. */
export async function refreshStackColumns() {
  if (!currentInstance || !IS_TAURI) return;
  const sinks = currentInstance.liveColumnSinks?.() || [];
  for (const { fileId, apply } of sinks) {
    if (!fileId || String(fileId).startsWith("localsync:")) continue;
    try {
      const file = await tauriInvoke("load_file", { id: fileId });
      if (file) apply(file.content);
    } catch (_) { /* removed or unreadable — leave the column as it is */ }
  }
}

async function saveStack(force = false) {
  if (!currentInstance || !currentFileId) return null;
  const content = encodeLive(currentInstance);
  // Idle stacks re-serialize to byte-identical content every tick; skip
  // the write + the caller's sync push unless something actually changed.
  if (!force && content === lastSavedContent) return null;
  const { parseLocalSentinel } = await import("../sync/local-sync.js");
  const local = parseLocalSentinel(currentFileId);
  if (local) {
    // Local Sync stack — write the `.hushstack` JSON straight to disk.
    try {
      const { writeFile } = await import("../sync/local-sync.js");
      // Flag our own write so the desktop fs watcher skips the echo.
      if (currentState?.runtime) currentState.runtime.localSyncWriteFlag = Date.now();
      await writeFile(local.folderId, local.relPath, content);
    } catch (e) {
      console.error("Local-sync stack save failed:", e);
    }
    lastSavedContent = content;
    return null; // no VC fileId to sync
  }
  if (IS_TAURI) {
    try {
      await tauriInvoke("save_file", { id: currentFileId, content });
    } catch (e) {
      console.error("Stack save failed:", e);
    }
  }
  lastSavedContent = content;
  return { fileId: currentFileId, content };
}

function startAutosave(state) {
  stopAutosave();
  autosaveTimer = setInterval(async () => {
    const result = await saveStack();
    if (result) {
      state.syncFileToExternal?.(result.fileId, result.content);
    }
  }, 2000);
}

function stopAutosave() {
  if (autosaveTimer) {
    clearInterval(autosaveTimer);
    autosaveTimer = null;
  }
}
