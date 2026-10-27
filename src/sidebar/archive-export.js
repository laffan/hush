/**
 * Export Archive — the Archive row's menu action: the desk's Archive
 * folder, month and year folders included, saved as one zip (Rust:
 * desk_archive.rs#archive_folder_zip). A save dialog on the Mac, the
 * share sheet on iPad, as desk archives are shared (desk-archive.js).
 */
import { isIOS } from "../settings/settings-ui.js";
import { logActivity } from "../activity-log.js";
import { showImportToast } from "../editor/import-toast.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

async function invoke(cmd, args) {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(cmd, args);
}

export async function exportArchive(state, archiveNodeId) {
  if (!IS_TAURI) { window.alert("Exporting the Archive is only available in the app."); return; }
  const deskId = String(archiveNodeId).split(":")[1];
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  if (!desk) return;
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const fileName = `${(desk.name || "Desk").replace(/[/\\:*?"<>|]/g, "-")} Archive ${stamp}.zip`;
  try {
    // Save first, so the zip reads what is on screen.
    if (state.dirty) await state.saveCurrentFile();
    if (isIOS()) {
      const bytes = new Uint8Array(await invoke("desk_archive_folder_zip", { deskId }));
      const file = new File([bytes], fileName, { type: "application/zip" });
      if (!(navigator.canShare && navigator.canShare({ files: [file] }))) {
        window.alert("This device can't share files from Hush.");
        return;
      }
      await navigator.share({ files: [file] });
      return;
    }
    const { save } = await import("@tauri-apps/plugin-dialog");
    const target = await save({ defaultPath: fileName, filters: [{ name: "Zip", extensions: ["zip"] }] });
    if (!target) return;
    const bytes = new Uint8Array(await invoke("desk_archive_folder_zip", { deskId }));
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(target, bytes);
    showImportToast("Archive exported", "success");
    logActivity("desks", "info", "Exported a desk's Archive", { deskId, bytes: bytes.length });
  } catch (e) {
    if (e && (e.name === "AbortError" || /aborted|cancel/i.test(e.message || ""))) return;
    logActivity("desks", "error", "Exporting the Archive failed", { deskId, error: String(e) });
    window.alert(`Couldn't export the Archive:\n${e?.message || e}`);
  }
}
