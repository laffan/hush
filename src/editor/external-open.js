/**
 * External file open — handles files handed to the app by the OS.
 *
 * On iPadOS this fires when the user taps a .hushnote / .hushstack /
 * .md file in Files.app and picks Hush from "Open With", or shares one
 * into Hush from another app. The URL arrives via the deep-link plugin
 * (`onOpenUrl`) as a `file://…` (or absolute) path.
 *
 * We read the bytes through Tauri's fs plugin and route them through
 * the same `create*` helpers the sidebar drag-drop import uses, so the
 * imported file lands as a normal entry in the active desk's Inbox.
 */

import { showImportToast } from "./import-toast.js";

const TEXT_EXTENSIONS = [".md", ".txt", ".text", ".markdown"];

function pathFromUrl(rawUrl) {
  let path = rawUrl;
  if (path.startsWith("file://")) {
    try { path = decodeURIComponent(new URL(path).pathname); }
    catch (_) { path = decodeURIComponent(path.slice("file://".length)); }
  }
  return path;
}

function basename(path) {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

export async function importExternalFile(state, rawUrl) {
  const path = pathFromUrl(rawUrl);
  const name = basename(path);
  const baseName = name.replace(/\.[^.]+$/, "") || "Imported";
  const ext = extOf(name);

  const fs = await import("@tauri-apps/plugin-fs");
  const parentId = state.getInboxId();
  if (!parentId) {
    showImportToast(`Couldn't import ${name}: app not ready yet`, "error");
    return;
  }

  try {
    if (ext === ".hushnote") {
      const bytes = await fs.readFile(path);
      const { unpackNotebook } = await import("../sync/notebook-sync.js");
      const content = await unpackNotebook(new Uint8Array(bytes));
      const result = await state.createNotebook(baseName, parentId, { openImmediately: true, initialContent: content });
      showImportToast(`Imported ${name}`, "success");
      return result;
    }

    if (ext === ".hushstack") {
      const text = await fs.readTextFile(path);
      const result = await state.createStack(baseName, parentId, { openImmediately: true, initialContent: text });
      showImportToast(`Imported ${name}`, "success");
      return result;
    }

    if (TEXT_EXTENSIONS.includes(ext)) {
      const text = await fs.readTextFile(path);
      const result = await state.newFile(parentId, { openImmediately: true, initialContent: text, initialName: baseName });
      showImportToast(`Imported ${name}`, "success");
      return result;
    }

    showImportToast(`Unsupported file type: ${name}`, "error");
  } catch (e) {
    showImportToast(`Import failed for ${name}: ${e?.message || e}`, "error");
    throw e;
  }
}
