/**
 * Modal helpers for the Sync settings tab: the Clear Local Versions
 * preview-confirm-progress flow and the Force Sync progress flow.
 *
 * Both flows live behind a single backdrop element so the user can't
 * dismiss them by clicking outside while the sync is mid-flight. The
 * progress phase only exposes a "Done" button once the underlying
 * `sync-progress` (or `clear-reseed-progress`) event fires `phase === "end"`.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function mountModal(width = 520) {
  const backdrop = document.createElement("div");
  backdrop.className = "dbx-browser-backdrop";
  const modal = document.createElement("div");
  modal.className = "dbx-browser-modal";
  modal.style.maxWidth = `${width}px`;
  modal.style.maxHeight = "80vh";
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  return { backdrop, modal };
}

function renderLoading(modal, title) {
  modal.innerHTML = `
    <div class="dbx-browser-header">
      <span class="dbx-browser-path">${escHtml(title)}</span>
    </div>
    <div style="padding: 24px 18px; font-size: 13px; line-height: 1.5;">
      <p style="margin: 0 0 12px 0;">Scanning Dropbox…</p>
      <div style="height: 8px; background: rgba(128,128,128,0.15); border-radius: 4px; overflow: hidden;">
        <div style="height: 100%; width: 30%; background: var(--accent, #4a90e2);
                    animation: dbx-indeterminate 1.2s ease-in-out infinite;"></div>
      </div>
    </div>
    <style>
      @keyframes dbx-indeterminate {
        0%   { transform: translateX(-100%); }
        50%  { transform: translateX(120%); }
        100% { transform: translateX(120%); }
      }
    </style>
  `;
}

function renderError(modal, title, message, onClose) {
  modal.innerHTML = `
    <div class="dbx-browser-header">
      <span class="dbx-browser-path">${escHtml(title)}</span>
      <button class="dbx-browser-close">✕</button>
    </div>
    <div style="padding: 18px;">
      <p style="margin: 0 0 16px 0; line-height: 1.5; color: #ff4444;">${escHtml(message)}</p>
      <div style="display: flex; justify-content: flex-end;">
        <button class="settings-sync-modal-close" style="padding: 8px 16px; cursor: pointer;">Close</button>
      </div>
    </div>
  `;
  modal.querySelector(".dbx-browser-close").addEventListener("click", onClose);
  modal.querySelector(".settings-sync-modal-close").addEventListener("click", onClose);
}

function renderClearPreview(modal, preview, onCancel, onConfirm) {
  const totalAll = preview.totalFiles + preview.totalImages;
  const deskRows = preview.desks.map((d) => `
    <li class="sync-preview-item">
      <span class="sync-preview-name">${escHtml(d.name)}</span>
      <span class="sync-preview-counts">${formatCounts(d)}</span>
    </li>`).join("");
  const looseRows = preview.loose.map((d) => `
    <li class="sync-preview-item">
      <span class="sync-preview-name">${escHtml(d.name)}</span>
      <span class="sync-preview-counts">${formatCounts(d)}</span>
    </li>`).join("");

  const rootCount = preview.rootFiles?.total || 0;
  const desksNote = preview.hasDesksJson
    ? `Dropbox declares <strong>${preview.declaredDesks.length}</strong> desk${preview.declaredDesks.length === 1 ? "" : "s"} in <code>.hush/desks.json</code>. These will be restored on reseed.`
    : `No <code>.hush/desks.json</code> on Dropbox. Top-level folders below will be loaded under a single <strong>Personal</strong> desk.`;

  modal.innerHTML = `
    <div class="dbx-browser-header">
      <span class="dbx-browser-path">Clear local versions</span>
      <button class="dbx-browser-close">✕</button>
    </div>
    <div class="sync-preview-body" style="padding: 16px 18px; overflow-y: auto; font-size: 13px; line-height: 1.55;">
      <p style="margin: 0 0 10px 0;">
        Every doc, notebook, image, and sync record on this device will be wiped
        and re-downloaded from Dropbox.
      </p>
      <p style="margin: 0 0 14px 0; color: #ff4444;">
        Anything that exists only on this device and hasn't been pushed yet
        will be lost.
      </p>
      <div class="sync-preview-summary">
        <div><strong>${totalAll}</strong> file${totalAll === 1 ? "" : "s"} on Dropbox</div>
        <div class="sync-preview-summary-detail">${preview.totalFiles} doc/notebook · ${preview.totalImages} image${preview.totalImages === 1 ? "" : "s"}${preview.metaCount ? ` · ${preview.metaCount} meta` : ""}</div>
      </div>
      <p style="margin: 14px 0 6px 0;">${desksNote}</p>
      ${deskRows ? `<ul class="sync-preview-list">${deskRows}</ul>` : `<p class="sync-preview-empty">No desks detected.</p>`}
      ${looseRows ? `
        <p style="margin: 14px 0 6px 0;">Other top-level folders on Dropbox (no matching desk):</p>
        <ul class="sync-preview-list">${looseRows}</ul>
      ` : ""}
      ${rootCount > 0 ? `<p style="margin: 12px 0 0 0;">Plus <strong>${rootCount}</strong> file${rootCount === 1 ? "" : "s"} at the sync root.</p>` : ""}
      <p style="margin: 18px 0 8px 0;">Type <code>clear</code> below to confirm.</p>
      <input id="clear-confirm-input" type="text" autocomplete="off" spellcheck="false"
             style="width: 100%; padding: 6px 8px; font-family: inherit; font-size: 13px;
                    border: 1px solid var(--panel-border, rgba(0,0,0,0.2));
                    background: transparent; color: var(--fg); border-radius: 4px;" />
    </div>
    <div class="dbx-browser-footer" style="justify-content: flex-end; gap: 8px;">
      <button class="settings-sync-modal-cancel" style="padding: 8px 16px; cursor: pointer;">Cancel</button>
      <button class="settings-sync-modal-confirm sync-danger-btn" disabled style="opacity: 0.4;">
        Clear and reseed
      </button>
    </div>
  `;
  const input = modal.querySelector("#clear-confirm-input");
  const confirmBtn = modal.querySelector(".settings-sync-modal-confirm");
  input.addEventListener("input", () => {
    const ready = input.value.trim().toLowerCase() === "clear";
    confirmBtn.disabled = !ready;
    confirmBtn.style.opacity = ready ? "1" : "0.4";
  });
  setTimeout(() => input.focus(), 0);
  modal.querySelector(".dbx-browser-close").addEventListener("click", onCancel);
  modal.querySelector(".settings-sync-modal-cancel").addEventListener("click", onCancel);
  confirmBtn.addEventListener("click", () => { if (!confirmBtn.disabled) onConfirm(); });
}

function formatCounts(d) {
  if (d.total === 0) return `<span style="opacity:0.5;">empty</span>`;
  const bits = [];
  if (d.docs) bits.push(`${d.docs} doc${d.docs === 1 ? "" : "s"}`);
  if (d.notebooks) bits.push(`${d.notebooks} notebook${d.notebooks === 1 ? "" : "s"}`);
  if (d.images) bits.push(`${d.images} image${d.images === 1 ? "" : "s"}`);
  return bits.join(" · ");
}

function renderProgress(modal, title) {
  modal.innerHTML = `
    <div class="dbx-browser-header">
      <span class="dbx-browser-path">${escHtml(title)}</span>
    </div>
    <div style="padding: 22px 20px;">
      <div class="sync-progress-label" style="margin: 0 0 12px 0; font-size: 13px;">Starting…</div>
      <div style="height: 8px; background: rgba(128,128,128,0.15); border-radius: 4px; overflow: hidden; position: relative;">
        <div class="sync-progress-bar" style="height: 100%; width: 0%; background: var(--accent, #4a90e2); transition: width 0.2s ease;"></div>
      </div>
      <div class="sync-progress-count" style="margin-top: 10px; font-size: 12px; opacity: 0.7; min-height: 1em;">&nbsp;</div>
    </div>
    <div class="dbx-browser-footer" style="justify-content: flex-end;">
      <button class="sync-progress-done" disabled style="padding: 8px 16px; cursor: not-allowed; opacity: 0.4;">Done</button>
    </div>
  `;
}

/**
 * Drive the progress modal from `clear-reseed-progress` events. The
 * caller passes a `kickoff` function that fires the request — we set
 * the listener up FIRST so the first progress tick isn't missed.
 * Resolves once the user presses Done (only enabled after `phase === "end"`).
 */
async function driveProgress(modal, kickoff) {
  if (!IS_TAURI) return;
  const { listen } = await import("@tauri-apps/api/event");
  const labelEl = modal.querySelector(".sync-progress-label");
  const barEl = modal.querySelector(".sync-progress-bar");
  const countEl = modal.querySelector(".sync-progress-count");
  const doneBtn = modal.querySelector(".sync-progress-done");

  let ended = false;
  const update = (payload) => {
    const { done = 0, total = 0, phase, label } = payload || {};
    if (label) labelEl.textContent = label;
    else if (phase === "begin" && !labelEl.textContent.trim()) labelEl.textContent = "Working…";
    if (total > 0) {
      const pct = Math.min(100, Math.round((done / total) * 100));
      barEl.style.width = pct + "%";
      countEl.textContent = `${done} / ${total}`;
    } else if (done > 0) {
      countEl.textContent = `${done} processed`;
    }
    if (phase === "end") {
      ended = true;
      barEl.style.width = "100%";
      doneBtn.disabled = false;
      doneBtn.style.cursor = "pointer";
      doneBtn.style.opacity = "1";
    }
  };

  const unlisten = await listen("clear-reseed-progress", (ev) => update(ev?.payload));
  try { if (typeof kickoff === "function") await kickoff(); }
  catch (e) { console.error("sync kickoff failed:", e); }

  await new Promise((resolve) => {
    doneBtn.addEventListener("click", () => { if (ended) resolve(); });
  });
  try { unlisten(); } catch (_) {}
}

/**
 * Full Clear Local Versions flow. Returns true if the user confirmed
 * and the reseed ran to completion; false if they cancelled at any step.
 */
export async function runClearLocalFlow(settings) {
  const { backdrop, modal } = mountModal(540);
  let cancelled = false;
  const close = () => { backdrop.remove(); };

  renderLoading(modal, "Clear local versions");

  let preview = null;
  try {
    const { generateClearLocalPreview } = await import("../sync/sync-state.js");
    preview = await generateClearLocalPreview({ settings });
    if (!preview) {
      renderError(modal, "Clear local versions",
        "Dropbox sync isn't active. Connect Dropbox and pick a folder before clearing local versions.",
        close);
      return false;
    }
  } catch (e) {
    renderError(modal, "Clear local versions",
      `Could not list Dropbox: ${e?.message || e}`,
      close);
    return false;
  }

  const confirmed = await new Promise((resolve) => {
    renderClearPreview(modal, preview,
      () => { cancelled = true; resolve(false); },
      () => resolve(true));
  });
  if (!confirmed) { close(); return false; }
  if (cancelled) { close(); return false; }

  renderProgress(modal, "Reseeding from Dropbox");
  await driveProgress(modal, async () => {
    if (!IS_TAURI) return;
    const { emit } = await import("@tauri-apps/api/event");
    await emit("clear-local-data-request");
  });
  close();
  return true;
}

/**
 * Force Sync flow. Triggers a reconcile + cursor pull in the main
 * window and watches `clear-reseed-progress` to drive the bar.
 */
export async function runForceSyncFlow(settings) {
  if (!settings?.dropboxEnabled || !settings?.dropboxSyncPath) return false;
  const { backdrop, modal } = mountModal(480);
  const close = () => { backdrop.remove(); };

  renderProgress(modal, "Force sync");
  await driveProgress(modal, async () => {
    if (!IS_TAURI) return;
    const { emit } = await import("@tauri-apps/api/event");
    await emit("force-sync-request");
  });
  close();
  return true;
}
