/**
 * Link bar — the floating chrome above the editor that surfaces a
 * document's Google Doc link. Visible only when the current Hush doc
 * has a link in `settings.googleDocLinks`.
 *
 * Layout:
 *   [ Google Doc title chip ────────── ] [Pull] [Push] [Unlink]
 *
 * The title chip is a link to the Google Doc in the user's browser.
 * Pull/Push each prompt for confirmation (both are destructive whole-
 * document replaces — Hush's versioning is the safety net) and run via
 * the link-command flows.
 */
import { getLink, appendLog } from "./link-store.js";
import { viewUrl } from "./api.js";

const HOST_ID = "gdoc-link-bar";

let _state = null;
let _lastFileId = null;
let _busy = false;

export function initLinkBar(state) {
  _state = state;
  // First-time mount: hide.
  ensureHostHidden();
  state.on("file-opened", refresh);
  state.on("settings-changed", refresh);
  // Pull lock release / file content set should also re-evaluate (the
  // link doesn't change, but the chip's title is read from settings —
  // refresh covers all the cases).
  state.on("doc-content-changed", refreshChrome);
  refresh();
}

function ensureHost() {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.className = "gdoc-link-bar";
    host.style.display = "none";
    const editorContainer = document.getElementById("editor-container");
    if (editorContainer && editorContainer.parentNode) {
      editorContainer.parentNode.insertBefore(host, editorContainer);
    } else {
      document.body.appendChild(host);
    }
  }
  return host;
}

function ensureHostHidden() {
  const host = ensureHost();
  host.style.display = "none";
}

// Re-render the bar based on the current file's link state. Called on
// every file switch and settings change; idempotent.
function refresh() {
  if (!_state) return;
  const host = ensureHost();
  const fileId = _state.currentFileId;
  // Hide while a notebook or project is open — neither maps to a single
  // GDoc, and a project's joined buffer would push the wrong content.
  if (!fileId || _state.currentNotebookFileId || _state.currentProjectId) {
    host.style.display = "none";
    host.innerHTML = "";
    _lastFileId = null;
    return;
  }
  const link = getLink(_state, fileId);
  if (!link) {
    host.style.display = "none";
    host.innerHTML = "";
    _lastFileId = fileId;
    return;
  }
  _lastFileId = fileId;
  host.style.display = "";
  host.innerHTML = `
    <a class="gdoc-link-bar-chip" href="#" target="_blank" rel="noopener">
      <span class="gdoc-link-bar-icon" aria-hidden="true">${ICON_DOC}</span>
      <span class="gdoc-link-bar-title">${escHtml(link.title || "Linked Google Doc")}</span>
    </a>
    <div class="gdoc-link-bar-actions">
      <button class="gdoc-link-bar-btn" data-action="pull" title="Replace Hush document with Google Doc content">Pull</button>
      <button class="gdoc-link-bar-btn" data-action="push" title="Replace Google Doc with Hush document content">Push</button>
      <button class="gdoc-link-bar-btn gdoc-link-bar-btn-secondary" data-action="unlink" title="Forget the link (does not change either document)">Unlink</button>
    </div>
  `;
  const chipEl = host.querySelector(".gdoc-link-bar-chip");
  chipEl.href = viewUrl(link.docId);
  chipEl.addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      const opener = await import("@tauri-apps/plugin-opener");
      await opener.openUrl(viewUrl(link.docId));
    } catch (_) {
      window.open(viewUrl(link.docId), "_blank");
    }
  });
  host.querySelectorAll(".gdoc-link-bar-btn").forEach((btn) => {
    btn.addEventListener("click", () => onAction(btn.dataset.action, link));
  });
}

// Lighter-weight refresh — used on `doc-content-changed` so the chrome
// doesn't keep rebinding on every keystroke. Currently a no-op since
// the chip displays the static linked title; kept for forward-compat.
function refreshChrome() { /* intentionally empty */ }

async function onAction(action, link) {
  if (!_state || _busy) return;
  if (action === "unlink") {
    if (!confirmDialog("Unlink this document from Google Docs?\n\nThe Hush document and the Google Doc are both kept; only the link between them is forgotten.")) return;
    const { clearLink } = await import("./link-store.js");
    await clearLink(_state, _state.currentFileId);
    appendLog(_state, `Unlinked "${link.title}"`);
    showToast("Unlinked");
    return;
  }
  if (action === "push") {
    if (!confirmDialog(`Replace the Google Doc "${link.title}" with the current Hush document?\n\nGoogle Docs version history is your undo.`)) return;
    setBusy(true);
    try {
      const { pushToGoogleDoc } = await import("./link-command.js");
      await pushToGoogleDoc(_state, link);
      showToast("Pushed to Google Doc");
    } catch (e) {
      showToast(`Push failed: ${e.message || e}`, /* error= */ true);
      appendLog(_state, `Push failed: ${e.message || e}`);
    } finally { setBusy(false); }
    return;
  }
  if (action === "pull") {
    if (!confirmDialog(`Replace the current Hush document with the Google Doc "${link.title}"?\n\nHush version history is your undo.`)) return;
    setBusy(true);
    try {
      const { pullFromGoogleDoc } = await import("./link-command.js");
      await pullFromGoogleDoc(_state, link);
      showToast("Pulled from Google Doc");
    } catch (e) {
      showToast(`Pull failed: ${e.message || e}`, /* error= */ true);
      appendLog(_state, `Pull failed: ${e.message || e}`);
    } finally { setBusy(false); }
    return;
  }
}

function setBusy(b) {
  _busy = b;
  const host = ensureHost();
  host.classList.toggle("gdoc-link-bar-busy", b);
  host.querySelectorAll(".gdoc-link-bar-btn").forEach((btn) => { btn.disabled = b; });
}

function confirmDialog(message) {
  // Plain `window.confirm` keeps the modal accessible, matches Hush's
  // existing pattern (delete prompts, etc.), and stays out of the link
  // bar's own bounds so it can sit above any pane chrome.
  return window.confirm(message);
}

function showToast(label, isError = false) {
  document.querySelectorAll(".gdoc-link-toast").forEach((el) => el.remove());
  const toast = document.createElement("div");
  toast.className = `style-locked-toast gdoc-link-toast${isError ? " error" : ""}`;
  toast.textContent = label;
  document.body.appendChild(toast);
  toast.offsetHeight; // eslint-disable-line no-unused-expressions
  toast.classList.add("visible");
  setTimeout(() => { toast.classList.remove("visible"); setTimeout(() => toast.remove(), 300); }, isError ? 4000 : 1800);
}

function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Inline SVG — same stroke-only style as the rest of Hush's chrome.
const ICON_DOC = `<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 1.5h6.5L13 5v9a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 14V1.5zM9 1.5V5h4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
