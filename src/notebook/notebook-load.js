/**
 * Notebook snapshot loading — extracted from notebook-bridge.js
 * (700-line cap). Reads the backing file (Local Folder `.hushnote` zip
 * or internal store) and decodes it to the envelope snapshot.
 *
 * Besides the snapshot, reports `loadedShapeCount` for the bridge's
 * empty-save guard:
 *   N >= 0 — decoded successfully with N shapes (0 covers a genuinely
 *            new/empty file, including no-file-on-disk-yet);
 *   -1     — the load threw, or the file had content that failed to
 *            decode. The bridge blocks saves from a pristine empty
 *            canvas while the count isn't 0, so a failed load can
 *            never overwrite a real notebook with an empty envelope.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

export async function loadNotebookSnapshot(fileId) {
  let snapshot = null;
  let loadedShapeCount = -1;
  try {
    const { parseLocalSentinel } = await import("../sync/local-sync.js");
    const local = parseLocalSentinel(fileId);
    if (local) {
      // Local Sync notebook — read the `.hushnote` zip straight off disk,
      // unpack it to the JSON envelope, then decode like any notebook.
      const { readFileBytes } = await import("../sync/local-sync.js");
      const bytes = await readFileBytes(local.folderId, local.relPath);
      if (bytes) {
        const { unpackNotebook } = await import("../sync/notebook-sync.js");
        const json = await unpackNotebook(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
        const { decodeNotebookContent } = await import("./notebook-content.ts");
        snapshot = decodeNotebookContent(json);
        // Non-empty bytes that decode to nothing = corrupt, keep -1.
        if (!snapshot && !(json && json.trim())) loadedShapeCount = 0;
      } else {
        // No file on disk yet — a genuinely new notebook.
        loadedShapeCount = 0;
      }
    } else if (IS_TAURI) {
      const { invoke } = await import("@tauri-apps/api/core");
      const file = await invoke("load_file", { id: fileId });
      const { decodeNotebookContent } = await import("./notebook-content.ts");
      snapshot = decodeNotebookContent(file.content);
      // Empty file content = genuinely new notebook; non-empty content
      // that fails to decode = corrupt, keep -1 so saves stay blocked.
      if (!snapshot && !(file.content && file.content.trim())) loadedShapeCount = 0;
    }
  } catch (e) {
    console.error("Failed to load notebook shapes:", e);
  }
  if (snapshot) {
    loadedShapeCount = Array.isArray(snapshot.shapes) ? snapshot.shapes.length : 0;
  }
  return { snapshot, loadedShapeCount };
}
