/**
 * Save rendered PDF bytes into the active desk instead of onto disk.
 *
 * The export modals' normal delivery path hands the bytes to a native
 * save dialog (or the iOS share sheet) and the file leaves Hush. That is
 * the right default for sending something to someone else, and the wrong
 * one for the loop this app is actually built around: export a document
 * to PDF, then read and mark it up — with the PDF viewer, or by turning
 * it into a proofread notebook — without a round trip through Finder and
 * a re-import.
 *
 * The result is an ordinary desk PDF: a registry entry, a node in the
 * desk's PDFs folder, the binary in the per-device store, and a shelf
 * cover. Nothing about it remembers it was exported rather than
 * imported.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/**
 * Register `bytes` as a PDF in the active desk under `baseName`.
 *
 * Returns `{ fileId, name }` — the name may differ from `baseName` if
 * the PDFs folder already held one (`uniqueChildName` suffixes it).
 * Throws on failure so the caller can surface it on its own button.
 */
export async function savePdfBytesToDesk(state, bytes, baseName) {
  if (!IS_TAURI) throw new Error("Saving to the desk needs the desktop app");
  const clean = String(baseName || "PDF").replace(/\.pdf$/i, "").trim() || "PDF";

  // Registry entry + tree node first: the placeholder is what makes the
  // file real to the sidebar, and it is also what the binary is keyed
  // against.
  const result = await state.registerPdfPlaceholder(clean, {});
  if (!result) throw new Error("Could not register the PDF");

  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  await tauriInvoke("save_pdf", { fileId: result.fileId, bytes: Array.from(arr) });

  // Flip the registry's "is it here yet" flag by asking the disk rather
  // than asserting it — same call the open path makes, so a write that
  // silently failed can't leave a row claiming to be downloaded.
  try {
    const { checkPdfExists } = await import("../sync/pdf-sync.js");
    await checkPdfExists(result.fileId);
  } catch { /* the row just shows as pending until the next check */ }

  // Shelf cover, fire-and-forget — cosmetic, and it must never be able
  // to fail the save it decorates.
  import("./pdf-covers.js")
    .then(({ ensurePdfCover }) => ensurePdfCover(result.fileId, { bytes: arr }))
    .then(() => state.emit("pdf-cover-ready", result.fileId))
    .catch(() => {});

  state.emit("files-changed");
  return result;
}
