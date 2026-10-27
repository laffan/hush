/**
 * Recover Desk Version — browse the active desk's backups and recover
 * one as a new desk; plus the palette's Backup Desk Now and Desk Backup
 * Folder… (see sync/desk-backups.js for the plumbing, desk_backup.rs for
 * what a backup is).
 *
 * The modal is the version list on the left, newest first and grouped
 * by day, and the selected backup's files on the right in a limited
 * viewer (desk-backup-viewer.js) — enough to find the version that
 * still has the paragraph you lost, and to copy it out without
 * recovering anything. **Recover as New Desk** builds a new internal
 * desk, `<Desk> Backup - <1232pm Jan 12, 2023>`, beside the live one,
 * which is never touched. A backup carries no PDF binaries, so the
 * checkbox at the foot decides whether its PDFs come back (re-registered
 * under fresh ids, downloaded from Zotero unless this device has them)
 * or are left out.
 */

import { escHtml } from "./files-panel-shared.js";
import { logActivity } from "../activity-log.js";
import { showImportToast } from "../editor/import-toast.js";
import { backupDeskNow, getBackupTarget } from "../sync/desk-backups.js";
import { openDeskBackupPrompt } from "./desk-backup-field.js";
import { renderBackupViewer } from "./desk-backup-viewer.js";

async function invoke(cmd, args) {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(cmd, args);
}

/** The desk has a backup folder, asking for one when it hasn't. Resolves
 *  to the target, or null if the user backed out or turned them off. */
async function ensureTarget(desk, prompt) {
  const current = await getBackupTarget(desk.id);
  if (current) return current;
  return (await openDeskBackupPrompt(desk.id, { ...prompt, checked: true })) || null;
}

export async function backupActiveDeskNow(state) {
  const desk = state.getActiveDesk?.();
  if (!desk) return;
  const target = await ensureTarget(desk, {
    title: `Back up "${desk.name}"`,
    message: "Choose where this desk's backups go. After this one, Hush backs it up every hour while it changes.",
    confirmLabel: "Back Up",
  });
  if (target) await backupDeskNow(state, desk.id);
}

export async function editDeskBackupFolder(state) {
  const desk = state.getActiveDesk?.();
  if (!desk) return;
  const current = await getBackupTarget(desk.id);
  const result = await openDeskBackupPrompt(desk.id, {
    title: `Backups for "${desk.name}"`,
    message: current ? "" : "Backups are off for this desk.",
    checked: !!current,
  });
  if (result !== undefined) showImportToast(result ? "Desk backups on" : "Desk backups off", "success");
}

export async function openRecoverDeskVersion(state) {
  const desk = state.getActiveDesk?.();
  if (!desk) return;
  const target = await ensureTarget(desk, {
    title: `Recover "${desk.name}"`,
    message: "This desk isn't being backed up yet. Choose a folder for its backups — the first is made now, then one every hour while the desk changes.",
    confirmLabel: "Turn On Backups",
  });
  if (!target) return;
  openModal(state, desk, target);
}

// ===== The modal =====

let _ui = null;

function closeModal() {
  if (!_ui) return;
  _ui.overlay.remove();
  document.removeEventListener("keydown", _ui.onKey, true);
  _ui = null;
}

function fmtBytes(n) {
  if (!n) return "0 KB";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function dayLabel(secs) {
  const d = new Date(secs * 1000);
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: days < 7 ? "long" : undefined, year: "numeric", month: "short", day: "numeric" });
}

function timeLabel(secs) {
  return new Date(secs * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "1232pm Jan 12, 2023" — the stamp a recovered desk's name carries,
 *  as recovery snapshots name theirs. */
function nameStamp(secs) {
  const d = new Date(secs * 1000);
  const h12 = d.getHours() % 12 || 12;
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ap = d.getHours() < 12 ? "am" : "pm";
  const mon = d.toLocaleString("en-US", { month: "short" });
  return `${h12}${mm}${ap} ${mon} ${d.getDate()}, ${d.getFullYear()}`;
}

function shortPath(path) {
  const m = String(path).match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  return m ? `~${m[1] || ""}` : path;
}

function openModal(state, desk, target) {
  closeModal();
  const overlay = document.createElement("div");
  overlay.className = "desk-backup-overlay";
  overlay.innerHTML = `
    <div class="desk-backup-modal" role="dialog" aria-label="Recover desk version">
      <div class="desk-backup-head">
        <div class="desk-backup-heading">
          <div class="desk-backup-title">Recover Desk Version</div>
          <div class="desk-backup-sub">${escHtml(desk.name)} · <span title="${escHtml(target.path)}">${escHtml(shortPath(target.path))}</span></div>
        </div>
        <button type="button" class="desk-archive-btn desk-backup-now">Back Up Now</button>
      </div>
      <div class="desk-backup-body">
        <div class="desk-backup-versions" tabindex="0" aria-label="Backups"></div>
        <div class="desk-backup-viewer"></div>
      </div>
      <div class="desk-backup-foot">
        <label class="desk-backup-pdfs" hidden>
          <input type="checkbox" checked />
          <span class="desk-backup-pdfs-label"></span>
        </label>
        <div class="desk-backup-foot-btns">
          <button type="button" class="desk-archive-close">Close</button>
          <button type="button" class="desk-backup-recover" disabled>Recover as New Desk</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const ui = {
    state, desk, overlay, backups: [], selected: null, contents: null, token: 0,
    list: overlay.querySelector(".desk-backup-versions"),
    viewer: overlay.querySelector(".desk-backup-viewer"),
    pdfs: overlay.querySelector(".desk-backup-pdfs"),
    recoverBtn: overlay.querySelector(".desk-backup-recover"),
    onKey: (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeModal(); }
      else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && document.activeElement === ui.list) {
        e.preventDefault();
        stepSelection(ui, e.key === "ArrowDown" ? 1 : -1);
      }
    },
  };
  _ui = ui;
  document.addEventListener("keydown", ui.onKey, true);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  overlay.querySelector(".desk-archive-close").addEventListener("click", closeModal);
  ui.recoverBtn.addEventListener("click", () => void recoverSelected(ui));
  const nowBtn = overlay.querySelector(".desk-backup-now");
  nowBtn.addEventListener("click", async () => {
    nowBtn.disabled = true;
    const info = await backupDeskNow(state, desk.id);
    nowBtn.disabled = false;
    if (info && _ui === ui) await loadList(ui, info.file);
  });
  void loadList(ui, null, { backUpIfEmpty: true });
}

async function loadList(ui, selectFile, { backUpIfEmpty = false } = {}) {
  ui.list.innerHTML = `<p class="desk-backup-hint">Loading…</p>`;
  try { ui.backups = (await invoke("desk_backup_list", { deskId: ui.desk.id })) || []; }
  catch (e) {
    ui.list.innerHTML = `<p class="desk-backup-hint">Couldn't read the backups: ${escHtml(String(e))}</p>`;
    return;
  }
  // Backups just turned on (or a folder emptied by hand): make the first
  // one now rather than show an empty list for the next hour.
  if (!ui.backups.length && backUpIfEmpty) {
    const info = await backupDeskNow(ui.state, ui.desk.id);
    if (_ui !== ui) return;
    if (info) return loadList(ui, info.file);
  }
  if (_ui !== ui) return;
  if (!ui.backups.length) {
    ui.list.innerHTML = `<p class="desk-backup-hint">No backups in this folder yet.</p>`;
    ui.viewer.innerHTML = "";
    return;
  }
  let lastDay = "";
  ui.list.innerHTML = ui.backups.map((b) => {
    const day = dayLabel(b.archivedAt);
    const header = day !== lastDay ? `<div class="desk-backup-day">${escHtml(day)}</div>` : "";
    lastDay = day;
    return `${header}
      <button type="button" class="desk-backup-version" data-file="${escHtml(b.file)}" tabindex="-1">
        <span class="desk-backup-version-time">${escHtml(timeLabel(b.archivedAt))}</span>
        <span class="desk-backup-version-meta">${b.files} file${b.files === 1 ? "" : "s"} · ${escHtml(fmtBytes(b.bytes))}</span>
      </button>`;
  }).join("");
  ui.list.querySelectorAll(".desk-backup-version").forEach((btn) => {
    btn.addEventListener("click", () => void selectBackup(ui, btn.dataset.file));
  });
  const first = ui.backups.find((b) => b.file === selectFile) || ui.backups[0];
  await selectBackup(ui, first.file);
}

function stepSelection(ui, delta) {
  const i = ui.backups.findIndex((b) => b.file === ui.selected?.file);
  const next = ui.backups[Math.min(ui.backups.length - 1, Math.max(0, i + delta))];
  if (next && next !== ui.selected) void selectBackup(ui, next.file);
}

async function selectBackup(ui, file) {
  const backup = ui.backups.find((b) => b.file === file);
  if (!backup) return;
  ui.selected = backup;
  ui.contents = null;
  ui.recoverBtn.disabled = true;
  ui.pdfs.hidden = true;
  ui.list.querySelectorAll(".desk-backup-version").forEach((btn) => {
    const on = btn.dataset.file === file;
    btn.classList.toggle("selected", on);
    if (on) btn.scrollIntoView({ block: "nearest" });
  });
  const token = ++ui.token;
  ui.viewer.innerHTML = `<p class="desk-backup-hint">Opening backup…</p>`;
  let contents;
  try { contents = await invoke("desk_backup_contents", { deskId: ui.desk.id, file }); }
  catch (e) {
    if (token === ui.token) ui.viewer.innerHTML = `<p class="desk-backup-hint">Couldn't open this backup: ${escHtml(String(e))}</p>`;
    return;
  }
  if (token !== ui.token || _ui !== ui) return;
  ui.contents = contents;
  renderBackupViewer(ui.viewer, {
    contents,
    readFile: (fileId) => invoke("desk_backup_read_file", { deskId: ui.desk.id, file, fileId }),
  });
  const pdfCount = Object.keys(contents.pdfs || {}).length;
  if (pdfCount) {
    ui.pdfs.hidden = false;
    ui.pdfs.querySelector(".desk-backup-pdfs-label").textContent =
      `Re-connect ${pdfCount} PDF${pdfCount === 1 ? "" : "s"} and download from Zotero`;
  }
  ui.recoverBtn.disabled = false;
}

async function recoverSelected(ui) {
  const backup = ui.selected;
  if (!backup || !ui.contents) return;
  const reconnectPdfs = !ui.pdfs.hidden && ui.pdfs.querySelector("input").checked;
  const newName = `${ui.desk.name} Backup - ${nameStamp(backup.archivedAt)}`;
  ui.recoverBtn.disabled = true;
  ui.recoverBtn.textContent = "Recovering…";
  const { state } = ui;
  try {
    const res = await invoke("desk_backup_restore", {
      deskId: ui.desk.id, file: backup.file, newName, reconnectPdfs,
    });
    // The desk is on disk; pull it into this window's tree and registry
    // and switch to it, as a restored archive does.
    state.fileTree = await invoke("get_file_tree");
    state.files = await invoke("list_files");
    const { syncDesksRegistryWithTree } = await import("../state/state-desks.js");
    await syncDesksRegistryWithTree(state);
    let downloads = 0;
    if (res.pdfs?.length) {
      const { restorePdfEntries } = await import("../sync/pdf-sync.js");
      downloads = await restorePdfEntries(res.pdfs, state);
    }
    state.emit("desks-changed");
    state.emit("files-changed");
    logActivity("desks", "info", `Recovered "${newName}" from a backup`, { from: backup.file, deskId: res.deskId, pdfs: res.pdfs?.length || 0 });
    closeModal();
    await state.setActiveDesk(res.deskId);
    showImportToast(downloads
      ? `Recovered "${newName}" — downloading ${downloads} PDF${downloads === 1 ? "" : "s"}`
      : `Recovered "${newName}"`, "success");
  } catch (e) {
    ui.recoverBtn.disabled = false;
    ui.recoverBtn.textContent = "Recover as New Desk";
    window.alert(`Couldn't recover from that backup:\n${e?.message || e}`);
  }
}
