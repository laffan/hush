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
  const seed = currentInstance.serialize();
  lastSavedContent = encodeStackContent(seed.items, seed.scrollX, {
    scrollY: seed.scrollY,
    scrollDirection: seed.scrollDirection,
  });

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
  return result;
}

export function getStackInstance() {
  return currentInstance;
}

export function getStackFileId() {
  return currentFileId;
}

async function saveStack(force = false) {
  if (!currentInstance || !currentFileId) return null;
  const snapshot = currentInstance.serialize();
  const content = encodeStackContent(snapshot.items, snapshot.scrollX, {
    scrollY: snapshot.scrollY,
    scrollDirection: snapshot.scrollDirection,
  });
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
