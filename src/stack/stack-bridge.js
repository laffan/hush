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

export async function mountStack(container, fileId, state) {
  if (currentInstance) {
    await saveStack();
    currentInstance.destroy();
    currentInstance = null;
  }
  container.innerHTML = "";
  currentFileId = fileId;

  let content = null;
  if (IS_TAURI) {
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

async function saveStack() {
  if (!currentInstance || !currentFileId) return null;
  const snapshot = currentInstance.serialize();
  const content = encodeStackContent(snapshot.items, snapshot.scrollX, {
    scrollY: snapshot.scrollY,
    scrollDirection: snapshot.scrollDirection,
  });
  if (IS_TAURI) {
    try {
      await tauriInvoke("save_file", { id: currentFileId, content });
    } catch (e) {
      console.error("Stack save failed:", e);
    }
  }
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
