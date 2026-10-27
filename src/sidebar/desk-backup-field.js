/**
 * The "Use Backups" field, and the small prompt built around it.
 *
 * The field sits under the desk name in the New desk prompt
 * (new-desk-flow.js): a checkbox, on by default, that reveals the backup
 * folder and a Browse button. The folder starts as the last one chosen,
 * else Documents/Hush Backups (desk_backup.rs#default_backup_folder).
 *
 * The prompt is the same field on its own, for the places a desk needs
 * its backups set without a name to ask for: a local desk just made
 * (its folder is its name), the palette's Desk Backup Folder…, and
 * Backup Desk Now / Recover Desk Version on a desk that has none yet.
 */

import { escHtml } from "./files-panel-shared.js";
import {
  backupsAvailable, chooseBackupFolder, defaultBackupFolder, getBackupTarget, setDeskBackupTarget,
} from "../sync/desk-backups.js";

/** Build the field. `value()` is `{ path, bookmark|null }` when checked
 *  with a folder, else null. Returns null outside the app (no folders
 *  to write to). */
export function createBackupField({ checked = true, target = null } = {}) {
  if (!backupsAvailable()) return null;
  const el = document.createElement("div");
  el.className = "backup-field";
  el.innerHTML = `
    <label class="backup-field-toggle">
      <input type="checkbox" class="backup-field-check" ${checked ? "checked" : ""} />
      <span>Use Backups</span>
    </label>
    <div class="backup-field-folder">
      <span class="backup-field-path"></span>
      <button type="button" class="backup-field-browse">Browse…</button>
    </div>
    <div class="backup-field-note">Hourly zips of the whole desk, PDFs left out.</div>`;
  const check = el.querySelector(".backup-field-check");
  const folderRow = el.querySelector(".backup-field-folder");
  const pathEl = el.querySelector(".backup-field-path");
  let chosen = target ? { path: target.path, bookmark: target.bookmark || null } : null;

  const paint = () => {
    folderRow.hidden = !check.checked;
    el.querySelector(".backup-field-note").hidden = !check.checked;
    pathEl.textContent = chosen?.path ? shortPath(chosen.path) : "Choose a folder…";
    pathEl.title = chosen?.path || "";
  };
  if (!chosen) {
    void defaultBackupFolder().then((path) => {
      if (!chosen && path) { chosen = { path, bookmark: null }; paint(); }
    });
  }
  check.addEventListener("change", paint);
  el.querySelector(".backup-field-browse").addEventListener("click", async () => {
    try {
      const picked = await chooseBackupFolder();
      if (picked) { chosen = picked; paint(); }
    } catch (e) {
      window.alert(`Couldn't open the folder picker:\n${e?.message || e}`);
    }
  });
  paint();
  return {
    el,
    value: () => (check.checked && chosen?.path ? chosen : null),
    focusCheck: () => check.focus(),
  };
}

/** "~/Documents/Hush Backups" for a path under the home folder, and
 *  only its last two folders when it is long — the end of a path is the
 *  part that says which folder it is. */
function shortPath(path) {
  const m = String(path).match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  const p = m ? `~${m[1] || ""}` : String(path);
  if (p.length <= 44) return p;
  return `…/${p.split("/").filter(Boolean).slice(-2).join("/")}`;
}

/** Ask for a desk's backup setting and save it. Resolves to the target
 *  saved (null when backups were turned off), or undefined if the
 *  prompt was dismissed. */
export async function openDeskBackupPrompt(deskId, {
  title = "Desk backups", message = "", confirmLabel = "Save", cancelLabel = "Cancel", checked,
} = {}) {
  if (!backupsAvailable()) return undefined;
  const current = await getBackupTarget(deskId);
  const field = createBackupField({ checked: checked ?? true, target: current });
  return new Promise((resolve) => {
    document.querySelectorAll(".tree-delete-modal-backdrop").forEach((el) => el.remove());
    const backdrop = document.createElement("div");
    backdrop.className = "tree-delete-modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "tree-delete-modal desk-backup-prompt";
    modal.innerHTML = `
      <div class="tree-delete-modal-title">${escHtml(title)}</div>
      ${message ? `<p class="desk-backup-prompt-message">${escHtml(message)}</p>` : ""}
      <div class="desk-backup-prompt-field"></div>
      <div class="tree-delete-modal-btns">
        <button class="tree-delete-cancel">${escHtml(cancelLabel)}</button>
        <button class="tree-delete-confirm tree-prompt-modal-confirm">${escHtml(confirmLabel)}</button>
      </div>`;
    modal.querySelector(".desk-backup-prompt-field").appendChild(field.el);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = (result) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    function onKey(e) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close(undefined);
    }
    modal.querySelector(".tree-delete-cancel").addEventListener("click", () => close(undefined));
    modal.querySelector(".tree-delete-confirm").addEventListener("click", async () => {
      const target = field.value();
      try {
        await setDeskBackupTarget(deskId, target);
        close(target);
      } catch (e) {
        window.alert(`Couldn't use that folder for backups:\n${e?.message || e}`);
      }
    });
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(undefined); });
    document.addEventListener("keydown", onKey, true);
    field.focusCheck();
  });
}
