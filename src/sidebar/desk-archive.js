/**
 * Archive a desk, and the archived-desks browser.
 *
 * Archiving replaces deleting. The desk's whole folder is zipped into an
 * internal archive first; only once that has come back successfully is
 * the desk taken out of the app. The order matters — a failed zip must
 * never be able to cost someone a desk — and it's why this is a flow
 * rather than a single call.
 *
 * A **local** desk's own folder is the user's, so archiving copies it and
 * unregisters the root; the folder itself is left exactly where it is.
 * The confirmation says so.
 *
 * "Create New Desk From Archive" builds a *new* desk rather than
 * resurrecting the old one — fresh desk id, fresh fileIds (see
 * desk_archive.rs) — so an archive can be restored as many times as you
 * like, including alongside the desk it came from.
 */

import { showConfirmModal, showDeleteConfirmModal, escHtml } from "./files-panel-shared.js";
import { logActivity } from "../activity-log.js";
import { isIOS } from "../settings/settings-ui.js";

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

async function invoke(cmd, args) {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(cmd, args);
}

/** Ask, then archive. Returns true when the desk was archived. */
export function confirmArchiveDesk(state, deskId, onDone) {
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId)
    || (state.settings?.desks || []).find((d) => d.id === deskId);
  const name = desk?.name || "this desk";
  const isLocal = !!state.deskRoots?.[deskId];
  const remaining = (state.fileTree || []).filter((n) => n.type === "desk").length;
  if (remaining <= 1) {
    window.alert("This is your only desk — make another one before archiving it.");
    return;
  }
  showConfirmModal({
    title: `Archive "${name}"`,
    message: isLocal
      ? `Archive "${name}"?\n\nEverything in it is saved into a single archive file inside Hush, and the desk closes. The folder on disk stays exactly where it is — nothing there is moved or deleted.\n\nYou can build a new desk from the archive at any time.`
      : `Archive "${name}"?\n\nEverything in it is saved into a single archive file inside Hush, and the desk closes.\n\nYou can build a new desk from the archive at any time.`,
    confirmLabel: "Archive",
    onConfirm: async () => {
      try {
        await archiveDesk(state, deskId);
        if (typeof onDone === "function") onDone();
      } catch (e) {
        window.alert(`Couldn't archive "${name}":\n${e?.message || e}`);
      }
    },
  });
}

/** Zip the desk, verify, then take it out of the app. */
export async function archiveDesk(state, deskId) {
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  if (!desk) throw new Error("that desk is no longer open");
  if (!IS_TAURI) throw new Error("archiving is only available in the app");

  // 1. Zip first. Nothing is removed until this returns.
  const info = await invoke("desk_archive", { deskId, deskName: desk.name || "Untitled desk" });
  logActivity("desks", "info", `Archived desk "${desk.name}"`, info);

  // 2. Now unhook the desk: the same tree/registry removal deletion used
  //    to do, minus the retire (the archive already holds the folder).
  await state.deleteDesk(deskId, { archived: true });

  // 3. Drop the live folder, which the archive now duplicates. A no-op
  //    for a local desk — that folder belongs to the user.
  try { await invoke("desk_discard_archived", { deskId }); }
  catch (e) { logActivity("desks", "warn", "Archived desk folder could not be removed", { deskId, error: String(e) }); }
  return info;
}

// ===== The archived-desks browser =====

let _overlay = null;

export async function openArchivedDesksModal(state) {
  if (!IS_TAURI) return;
  closeModal();
  const overlay = document.createElement("div");
  overlay.className = "desk-archive-overlay";
  overlay.innerHTML = `
    <div class="desk-archive-modal">
      <div class="desk-archive-title">Archived desks</div>
      <div class="desk-archive-list" id="desk-archive-list">
        <p class="desk-archive-empty">Loading…</p>
      </div>
      <div class="desk-archive-actions">
        <button class="desk-archive-close" type="button">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  _overlay = overlay;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  overlay.querySelector(".desk-archive-close").addEventListener("click", closeModal);
  document.addEventListener("keydown", onKey, true);
  await paintList(state);
}

function onKey(e) {
  if (e.key === "Escape") { closeModal(); e.stopPropagation(); }
}

function closeModal() {
  if (_overlay?.parentNode) _overlay.parentNode.removeChild(_overlay);
  _overlay = null;
  document.removeEventListener("keydown", onKey, true);
}

function fmtBytes(n) {
  if (!n) return "0 KB";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(secs) {
  if (!secs) return "";
  return new Date(secs * 1000).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

async function paintList(state) {
  const host = _overlay?.querySelector("#desk-archive-list");
  if (!host) return;
  let archives = [];
  try { archives = await invoke("desk_archives_list") || []; }
  catch (e) {
    host.innerHTML = `<p class="desk-archive-empty">Couldn't read the archives: ${escHtml(String(e))}</p>`;
    return;
  }
  if (archives.length === 0) {
    host.innerHTML = `<p class="desk-archive-empty">No archived desks yet. Archiving a desk from its menu puts it here.</p>`;
    return;
  }
  host.innerHTML = archives.map((a) => `
    <div class="desk-archive-row" data-file="${escHtml(a.file)}">
      <div class="desk-archive-row-head">
        <span class="desk-archive-name">${escHtml(a.name)}</span>
        <span class="desk-archive-meta">${escHtml(fmtDate(a.archivedAt))} · ${a.files} file${a.files === 1 ? "" : "s"} · ${escHtml(fmtBytes(a.bytes))}</span>
      </div>
      <div class="desk-archive-row-actions">
        <button class="desk-archive-btn" data-archive-action="restore">Create New Desk From Archive</button>
        <button class="desk-archive-btn" data-archive-action="share">Share</button>
        <button class="desk-archive-btn desk-archive-btn-danger" data-archive-action="delete">Delete</button>
      </div>
    </div>
  `).join("");

  host.querySelectorAll("[data-archive-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".desk-archive-row");
      const file = row?.dataset.file;
      const entry = archives.find((a) => a.file === file);
      if (!entry) return;
      const action = btn.dataset.archiveAction;
      if (action === "restore") void restoreArchive(state, entry, btn);
      else if (action === "share") void shareArchive(entry, btn);
      else if (action === "delete") deleteArchive(state, entry);
    });
  });
}

async function restoreArchive(state, entry, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Creating…";
  try {
    const deskId = await invoke("desk_archive_restore", { file: entry.file });
    // The desk landed on disk; pull it into this window's tree and
    // registry, then switch to it so the result is visible immediately.
    state.fileTree = await invoke("get_file_tree");
    state.files = await invoke("list_files");
    const { syncDesksRegistryWithTree } = await import("../state/state-desks.js");
    await syncDesksRegistryWithTree(state);
    state.emit("desks-changed");
    state.emit("files-changed");
    logActivity("desks", "info", `Created a desk from archive "${entry.name}"`, { deskId });
    closeModal();
    await state.setActiveDesk(deskId);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    window.alert(`Couldn't create a desk from that archive:\n${e?.message || e}`);
  }
}

/** Hand the archive to the OS: the share sheet on iPad, a save dialog on
 *  desktop. */
async function shareArchive(entry, btn) {
  try {
    if (isIOS()) {
      const bytes = new Uint8Array(await invoke("desk_archive_bytes", { file: entry.file }));
      const file = new File([bytes], entry.file, { type: "application/zip" });
      if (!(navigator.canShare && navigator.canShare({ files: [file] }))) {
        window.alert("This device can't share files from Hush.");
        return;
      }
      await navigator.share({ files: [file] });
      return;
    }
    const { save } = await import("@tauri-apps/plugin-dialog");
    const target = await save({
      defaultPath: entry.file,
      filters: [{ name: "Hush Desk Archive", extensions: ["husharchive"] }],
    });
    if (!target) return;
    const bytes = new Uint8Array(await invoke("desk_archive_bytes", { file: entry.file }));
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(target, bytes);
    btn.textContent = "Saved";
    setTimeout(() => { btn.textContent = "Share"; }, 1600);
  } catch (e) {
    if (e && (e.name === "AbortError" || /aborted|cancel/i.test(e.message || ""))) return;
    logActivity("desks", "error", "Sharing a desk archive failed", { file: entry.file, error: String(e) });
    window.alert(`Couldn't share that archive:\n${e?.message || e}`);
  }
}

function deleteArchive(state, entry) {
  showDeleteConfirmModal(
    `Delete "${entry.name}" archive`,
    `Permanently delete the archive of "${entry.name}"?\n\nThis is the only copy inside Hush. It cannot be undone.`,
    async () => {
      try {
        await invoke("desk_archive_delete", { file: entry.file });
        await paintList(state);
      } catch (e) {
        window.alert(`Couldn't delete that archive:\n${e?.message || e}`);
      }
    },
  );
}
