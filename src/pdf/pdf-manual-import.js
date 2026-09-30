/**
 * Bringing a PDF in by hand, for when Zotero can't hand it over: no
 * network, or a download that failed.
 *
 * "Download to Hush" needs Zotero's servers twice — nothing about the
 * reference itself does. Its title, authors, year, citekey and the keys
 * of the item and its PDF attachment are all in the library cache on
 * this device (`zotero_references.json`), so a linked entry can be made
 * offline; only the bytes have to come from somewhere else, and the file
 * is usually already on disk (Zotero's own storage folder, a download, a
 * colleague's copy). Two ways in:
 *
 *   - `importPdfFileForReference` — a new entry described by the cached
 *     reference, filled from a file the user picks. It is linked exactly
 *     as a downloaded one is (same registry keys), so the citation opens
 *     it next time and the viewer fetches its annotations once online.
 *   - `importFileIntoPdf` — fill an entry that is already there but
 *     never got its bytes (a placeholder whose download is pending or
 *     failed).
 *
 * Nothing here touches the network.
 */

import { showImportToast } from "../editor/import-toast.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Ask for one PDF from disk: `{ name, bytes }`, or null on cancel. A
 *  file input rather than the dialog plugin — it is the system open panel
 *  on the Mac and the Files picker on the iPad, hands the bytes over
 *  without a filesystem permission for the path, and is what the style
 *  editor's JSON import already uses. */
export function pickPdfFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.style.display = "none";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) { done(null); return; }
      try { done({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }); }
      catch { done(null); }
    });
    input.addEventListener("cancel", () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

/** A PDF starts `%PDF-`, give or take a little junk in front. */
function looksLikePdf(bytes) {
  const head = String.fromCharCode(...bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

function sanitizeName(s) {
  return String(s || "PDF")
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60) || "PDF";
}

/** Put `bytes` behind registry entry `fileId`. */
async function writePdfBytes(state, fileId, bytes) {
  await tauriInvoke("save_pdf", { fileId, bytes: Array.from(bytes) });
  // Ask the disk rather than assert it, as Save to Desk does: a write
  // that silently failed must not leave a row claiming its file.
  const { checkPdfExists } = await import("../sync/pdf-sync.js");
  await checkPdfExists(fileId);
  import("./pdf-covers.js")
    .then(({ ensurePdfCover }) => ensurePdfCover(fileId, { bytes }))
    .then(() => state.emit("pdf-cover-ready", fileId))
    .catch(() => {});
  state.emit("files-changed");
}

/** Pick a file and check it can be used. Null (with the reason said)
 *  when it can't, or on cancel. */
async function pickUsablePdf() {
  if (!IS_TAURI) {
    showImportToast("Importing a PDF needs the desktop app", "error");
    return null;
  }
  const picked = await pickPdfFile();
  if (!picked) return null;
  if (!looksLikePdf(picked.bytes)) {
    showImportToast(`${picked.name} isn't a PDF`, "error");
    return null;
  }
  return picked;
}

/**
 * Fill the entry `fileId` from a file on disk. Returns true once the
 * bytes are in place.
 */
export async function importFileIntoPdf(state, fileId) {
  const picked = await pickUsablePdf();
  if (!picked) return false;
  try {
    await writePdfBytes(state, fileId, picked.bytes);
  } catch (e) {
    showImportToast(`Couldn't import ${picked.name}: ${e?.message || e}`, "error");
    return false;
  }
  showImportToast(`Imported ${picked.name}`, "success");
  return true;
}

/**
 * A new PDF entry linked to a Zotero reference, filled from a file on
 * disk. `meta` carries the reference as `registerPdfPlaceholder` takes it
 * (`zoteroTitle`, `zoteroItemKey`, `zoteroAttKey`, …) — from the cached
 * library, or just a key when the cache has never seen the item. Returns
 * `{ fileId, name }`, or null.
 */
export async function importPdfFileForReference(state, meta = {}) {
  const picked = await pickUsablePdf();
  if (!picked) return null;
  let result = null;
  try {
    const baseName = sanitizeName(meta.zoteroTitle || picked.name);
    result = await state.registerPdfPlaceholder(baseName, {
      ...meta,
      zoteroTitle: meta.zoteroTitle || picked.name.replace(/\.pdf$/i, ""),
    });
    if (!result) throw new Error("the entry couldn't be made");
    await writePdfBytes(state, result.fileId, picked.bytes);
  } catch (e) {
    showImportToast(`Couldn't import ${picked.name}: ${e?.message || e}`, "error");
    return null;
  }
  showImportToast(`Imported ${picked.name}`, "success");
  return result;
}

/** A cached Zotero reference (and its PDF attachment, if the cache knows
 *  one) as `registerPdfPlaceholder`'s options. */
export function referencePdfMeta(ref, pdfAtt) {
  return {
    zoteroAttKey: pdfAtt?.key || "",
    zoteroItemKey: ref?.key || "",
    zoteroTitle: ref?.title || "",
    zoteroAuthors: ref?.authors || "",
    zoteroFirstAuthor: ref?.firstAuthor || "",
    zoteroYear: ref?.year || "",
    zoteroCitekey: ref?.citekey || "",
  };
}
