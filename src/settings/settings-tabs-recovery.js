/**
 * Sync > Recovery sub-tab — the rolling local-desk snapshot browser.
 *
 * While a **local** desk (one operating from a user-picked folder —
 * iCloud Drive, Dropbox, any synced directory) is being edited, a
 * background scheduler in Rust (desk_recovery.rs) zips the whole desk
 * folder every 30 minutes — content, `.hushdesk` identity, `.hush/`
 * index, tree and per-file version history — keeping the newest 16
 * snapshots per desk. This tab lists them, newest first.
 *
 * **Recover** builds a brand-new *internal* desk from a snapshot — fresh
 * desk id and fileIds via the archive re-identify pass, named
 * `<Desk> Recovery - <1232pm Jan 12, 2023>` — and never writes to the
 * user's own folder, so it's safe to run beside the live desk. The main
 * window finishes the job (tree + registry refresh, switch to the new
 * desk) on the `desk-recovery-restored` event, since this panel may be
 * running in the separate settings window. **Delete** removes the
 * snapshot file after confirmation.
 */

import { escHtml } from "./settings-tabs.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function invoke(cmd, args) {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call(cmd, args);
}

// Feather-style outline icons, sized for the 24×24 viewBox.
const ICON_RESTORE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`;
const ICON_TRASH = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;

export function renderRecoverySubTab() {
  return `
    <div class="settings-section">
      <h2>Desk Recovery</h2>
      <p class="settings-help">
        While a Local desk is being edited, Hush automatically archives the
        whole desk every 30 minutes (keeping the newest 16 snapshots per
        desk). Each snapshot carries everything — documents, notebooks,
        images, and the desk's per-file version history — so a desk that a
        sync provider damages can be brought back wholesale.
      </p>
      <p class="settings-help">
        Recovering builds a <strong>new</strong> desk from the snapshot;
        the folder on disk and the desk it came from are never touched.
      </p>
      <div class="recovery-list" id="recovery-list">
        <p class="recovery-empty">Loading…</p>
      </div>
      <div id="recovery-status" class="sync-status"></div>
    </div>
  `;
}

/** Bind the sub-tab when it's on screen — a no-op on other tabs. */
export function bindRecoverySubTab() {
  if (!document.getElementById("recovery-list")) return;
  void paintList();
}

/** The datetime format the recovered desk's name carries:
 *  "1232pm Jan 12, 2023". */
function recoveryStamp(secs) {
  const d = new Date(secs * 1000);
  const h12 = d.getHours() % 12 || 12;
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ap = d.getHours() < 12 ? "am" : "pm";
  const mon = d.toLocaleString("en-US", { month: "short" });
  return `${h12}${mm}${ap} ${mon} ${d.getDate()}, ${d.getFullYear()}`;
}

/** List-column time: the same readable form the archive browser uses. */
function fmtDate(secs) {
  if (!secs) return "";
  return new Date(secs * 1000).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function fmtBytes(n) {
  if (!n) return "0 KB";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function setStatus(msg, kind = "") {
  const el = document.getElementById("recovery-status");
  if (!el) return;
  el.textContent = msg;
  el.className = `sync-status${kind ? ` ${kind}` : ""}`;
}

async function paintList() {
  const host = document.getElementById("recovery-list");
  if (!host) return;
  if (!IS_TAURI) {
    host.innerHTML = `<p class="recovery-empty">Recovery snapshots are only available in the app.</p>`;
    return;
  }
  let snapshots = [];
  try {
    snapshots = (await invoke("desk_recovery_list")) || [];
  } catch (e) {
    host.innerHTML = `<p class="recovery-empty">Couldn't read the snapshots: ${escHtml(String(e))}</p>`;
    return;
  }
  if (snapshots.length === 0) {
    host.innerHTML = `<p class="recovery-empty">No snapshots yet. Editing a Local desk creates one automatically within a minute, then every 30 minutes while the editing continues.</p>`;
    return;
  }
  host.innerHTML = `
    <div class="recovery-row recovery-head">
      <span>Desk</span>
      <span>Snapshot</span>
      <span></span>
    </div>
    ${snapshots.map((s) => `
      <div class="recovery-row" data-desk="${escHtml(s.deskId)}" data-file="${escHtml(s.file)}">
        <span class="recovery-name" title="${escHtml(s.name)}">${escHtml(s.name)}</span>
        <span class="recovery-time">${escHtml(fmtDate(s.archivedAt))} · ${s.files} file${s.files === 1 ? "" : "s"} · ${escHtml(fmtBytes(s.bytes))}</span>
        <span class="recovery-actions">
          <button class="recovery-icon-btn" data-recovery-action="restore" title="Recover — create a new desk from this snapshot">${ICON_RESTORE}</button>
          <button class="recovery-icon-btn recovery-icon-danger" data-recovery-action="delete" title="Delete this snapshot">${ICON_TRASH}</button>
        </span>
      </div>
    `).join("")}
  `;

  host.querySelectorAll("[data-recovery-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".recovery-row");
      const entry = snapshots.find(
        (s) => s.deskId === row?.dataset.desk && s.file === row?.dataset.file,
      );
      if (!entry) return;
      if (btn.dataset.recoveryAction === "restore") void restoreSnapshot(entry, btn);
      else void deleteSnapshot(entry);
    });
  });
}

async function restoreSnapshot(entry, btn) {
  btn.disabled = true;
  const newName = `${entry.name} Recovery - ${recoveryStamp(entry.archivedAt)}`;
  setStatus(`Creating "${newName}"…`);
  try {
    const deskId = await invoke("desk_recovery_restore", {
      deskId: entry.deskId,
      file: entry.file,
      newName,
    });
    // The desk landed on disk; the main window owns the live tree, so it
    // finishes the job — registry mirror, sidebar refresh, desk switch.
    const { emit } = await import("@tauri-apps/api/event");
    await emit("desk-recovery-restored", { deskId, name: newName });
    setStatus(`Created "${newName}".`, "success");
  } catch (e) {
    setStatus(`Couldn't recover from that snapshot: ${e?.message || e}`, "error");
  }
  btn.disabled = false;
}

async function deleteSnapshot(entry) {
  const ok = window.confirm(
    `Delete the ${fmtDate(entry.archivedAt)} snapshot of "${entry.name}"?\n\nThis cannot be undone.`,
  );
  if (!ok) return;
  try {
    await invoke("desk_recovery_delete", { deskId: entry.deskId, file: entry.file });
    setStatus("Snapshot deleted.");
    await paintList();
  } catch (e) {
    setStatus(`Couldn't delete that snapshot: ${e?.message || e}`, "error");
  }
}
