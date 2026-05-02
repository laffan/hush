/**
 * Backup App Data — surfaced from the command palette as
 * "Backup App Data". Opens a modal with a progress bar, asks the user
 * for a destination, and zips the entire data directory into a single
 * archive (versions / snapshot history excluded by the Rust side).
 *
 * iOS uses the system share sheet rather than a save dialog; on macOS
 * / Linux the standard save dialog applies.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

function fmt(n) {
  if (!n || n < 1024) return `${n || 0} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  for (const u of units) {
    if (v < 1024) return `${v.toFixed(1)} ${u}`;
    v /= 1024;
  }
  return `${v.toFixed(1)} PB`;
}

function timestampSlug() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export async function openBackupAppDataModal(_state) {
  document.querySelectorAll(".backup-modal-backdrop").forEach((el) => el.remove());

  const backdrop = document.createElement("div");
  backdrop.className = "backup-modal-backdrop";
  backdrop.innerHTML = `
    <div class="backup-modal" role="dialog" aria-label="Backup App Data">
      <div class="backup-modal-title">Backup App Data</div>
      <p class="backup-modal-help">Bundles your documents, notebooks, images, settings, and Zotero / sync caches into a single zip file. Version history (snapshots) is excluded.</p>
      <div class="backup-modal-progress" hidden>
        <div class="backup-progress-bar"><div class="backup-progress-fill"></div></div>
        <div class="backup-progress-status">Preparing…</div>
      </div>
      <div class="backup-modal-result" hidden></div>
      <div class="backup-modal-btns">
        <button class="backup-modal-cancel">Cancel</button>
        <button class="backup-modal-go">Choose location…</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const cancelBtn = backdrop.querySelector(".backup-modal-cancel");
  const goBtn = backdrop.querySelector(".backup-modal-go");
  const progressWrap = backdrop.querySelector(".backup-modal-progress");
  const fill = backdrop.querySelector(".backup-progress-fill");
  const status = backdrop.querySelector(".backup-progress-status");
  const resultEl = backdrop.querySelector(".backup-modal-result");

  let unlistenProgress = null;
  let inFlight = false;

  function close() {
    if (inFlight) return; // don't yank a running zip
    if (unlistenProgress) { try { unlistenProgress(); } catch (_) {} }
    backdrop.remove();
  }

  cancelBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  goBtn.addEventListener("click", async () => {
    if (!IS_TAURI) {
      resultEl.hidden = false;
      resultEl.textContent = "Backups require the desktop or iOS app.";
      return;
    }
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const defaultName = `hush-backup-${timestampSlug()}.zip`;
      const dest = await save({
        defaultPath: defaultName,
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
      });
      if (!dest) return; // user cancelled

      goBtn.disabled = true;
      cancelBtn.disabled = true;
      progressWrap.hidden = false;
      resultEl.hidden = true;
      inFlight = true;

      // Listen for progress events emitted by the Rust command.
      const { listen } = await import("@tauri-apps/api/event");
      unlistenProgress = await listen("backup-progress", (e) => {
        const p = e.payload || {};
        const pct = p.total > 0 ? Math.min(100, Math.round((p.processed / p.total) * 100)) : 0;
        fill.style.width = pct + "%";
        status.textContent = p.currentFile
          ? `Packing ${p.currentFile} (${p.processed}/${p.total})`
          : `Packed ${p.processed}/${p.total}`;
      });

      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke("backup_app_data", { destination: dest });

      fill.style.width = "100%";
      status.textContent = "Done";
      resultEl.hidden = false;
      resultEl.textContent = `Saved ${result.fileCount ?? result.file_count ?? 0} files (${fmt(result.bytes || 0)}) to ${result.path}`;
      cancelBtn.disabled = false;
      cancelBtn.textContent = "Close";
      goBtn.hidden = true;
    } catch (e) {
      console.error("backup failed:", e);
      resultEl.hidden = false;
      resultEl.textContent = "Backup failed: " + (e?.message || e);
      goBtn.disabled = false;
      cancelBtn.disabled = false;
    } finally {
      inFlight = false;
      if (unlistenProgress) { try { unlistenProgress(); } catch (_) {} unlistenProgress = null; }
    }
  });
}
