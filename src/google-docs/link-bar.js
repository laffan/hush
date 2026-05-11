/**
 * Link bar — the slim, transparent chrome anchored to the top of the
 * editor whenever the current Hush doc is linked to a Google Doc.
 *
 *   ⤴⤵ Linked doc title                       Pull · Push · Unlink
 *
 * Mounting: the bar is a child of `#editor-container` (sibling of
 * `.cm-editor`), positioned `absolute; top: 0`. CodeMirror's
 * `.cm-scroller` already reserves `padding-top: calc(var(--padding) +
 * 30px)` at the top of the editor so the bar sits in that gutter
 * without overlapping text. `#editor-container` is the editor's
 * stacking context, so the sidebar — which lives outside that context
 * — can't paint over it.
 *
 * Content width is synced to the text column on every `layout-changed`
 * event by copying `.cm-scroller`'s padding-left/right onto the bar,
 * so the chip and buttons line up with the first and last columns of
 * text. Hides automatically while a notebook or project is open
 * (neither maps to a single GDoc).
 */
import { getLink, appendLog } from "./link-store.js";
import { viewUrl } from "./api.js";

const HOST_ID = "gdoc-link-bar";
let _state = null;
let _busy = false;

export function initLinkBar(state) {
  _state = state;
  state.on("file-opened", refresh);
  state.on("settings-changed", refresh);
  state.on("layout-changed", syncColumnPadding);
  window.addEventListener("resize", syncColumnPadding);
  refresh();
}

function ensureHost() {
  let el = document.getElementById(HOST_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = HOST_ID;
  el.className = "gdoc-link-bar";
  el.style.display = "none";
  const container = document.getElementById("editor-container");
  if (container) container.appendChild(el);
  return el;
}

function syncColumnPadding() {
  const el = document.getElementById(HOST_ID);
  if (!el) return;
  const scroller = document.querySelector("#editor-container .cm-scroller");
  if (!scroller) return;
  el.style.paddingLeft = scroller.style.paddingLeft || "";
  el.style.paddingRight = scroller.style.paddingRight || "";
}

function refresh() {
  if (!_state) return;
  const el = ensureHost();
  const fileId = _state.currentFileId;
  if (!fileId || _state.currentNotebookFileId || _state.currentProjectId) {
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }
  const link = getLink(_state, fileId);
  if (!link) {
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }
  el.style.display = "";
  el.innerHTML = `
    <a class="gdoc-link-bar-chip" href="#" target="_blank" rel="noopener" title="Open in Google Docs">${ICON_LINK}<span class="gdoc-link-bar-title">${escHtml(link.title || "Linked Google Doc")}</span></a>
    <span class="gdoc-link-bar-status"></span>
    <div class="gdoc-link-bar-actions">
      <button class="gdoc-link-bar-btn" data-action="pull" title="Replace Hush document with Google Doc content">Pull</button>
      <button class="gdoc-link-bar-btn" data-action="push" title="Replace Google Doc with Hush document content">Push</button>
      <button class="gdoc-link-bar-btn" data-action="unlink" title="Forget the link (does not change either document)">Unlink</button>
    </div>
  `;
  const chipEl = el.querySelector(".gdoc-link-bar-chip");
  chipEl.addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      const opener = await import("@tauri-apps/plugin-opener");
      await opener.openUrl(viewUrl(link.docId));
    } catch (_) {
      window.open(viewUrl(link.docId), "_blank");
    }
  });
  el.querySelectorAll(".gdoc-link-bar-btn").forEach((btn) => {
    btn.addEventListener("click", () => onAction(btn.dataset.action, link));
  });
  syncColumnPadding();
}

async function onAction(action, link) {
  if (!_state || _busy) return;
  if (action === "unlink") {
    if (!window.confirm("Unlink this document from Google Docs?\n\nThe Hush document and the Google Doc are both kept; only the link between them is forgotten.")) return;
    setBusy(true);
    setStatus("Unlinking…", "working");
    try {
      const { clearLink } = await import("./link-store.js");
      await clearLink(_state, _state.currentFileId);
      appendLog(_state, `Unlinked "${link.title}"`);
      // No need to clear status — refresh() runs on settings-changed
      // and the bar is gone now anyway.
    } catch (e) {
      setStatus(`Failed: ${e.message || e}`, "error", 4000);
      appendLog(_state, `Unlink failed: ${e.message || e}`);
    } finally { setBusy(false); }
    return;
  }
  if (action === "push") {
    if (!window.confirm(`Replace the Google Doc "${link.title}" with the current Hush document?\n\nGoogle Docs version history is your undo.`)) return;
    setBusy(true);
    setStatus("Sending…", "working");
    try {
      const { pushToGoogleDoc } = await import("./link-command.js");
      await pushToGoogleDoc(_state, link);
      setStatus("Sent ✓", "success", 2000);
    } catch (e) {
      setStatus(`Failed: ${e.message || e}`, "error", 5000);
      appendLog(_state, `Push failed: ${e.message || e}`);
    } finally { setBusy(false); }
    return;
  }
  if (action === "pull") {
    if (!window.confirm(`Replace the current Hush document with the Google Doc "${link.title}"?\n\nHush version history is your undo.`)) return;
    setBusy(true);
    setStatus("Receiving…", "working");
    try {
      const { pullFromGoogleDoc } = await import("./link-command.js");
      await pullFromGoogleDoc(_state, link);
      setStatus("Received ✓", "success", 2000);
    } catch (e) {
      setStatus(`Failed: ${e.message || e}`, "error", 5000);
      appendLog(_state, `Pull failed: ${e.message || e}`);
    } finally { setBusy(false); }
    return;
  }
}

function setBusy(b) {
  _busy = b;
  const el = document.getElementById(HOST_ID);
  if (!el) return;
  el.classList.toggle("gdoc-link-bar-busy", b);
  el.querySelectorAll(".gdoc-link-bar-btn").forEach((btn) => { btn.disabled = b; });
}

let _statusTimer = null;
/** Update the inline status line. `mode` is "working" | "success" |
 *  "error". When `autoClearMs` is set, the status fades out after that
 *  many milliseconds so success/failure messages don't linger. */
function setStatus(text, mode, autoClearMs) {
  const el = document.getElementById(HOST_ID);
  if (!el) return;
  const statusEl = el.querySelector(".gdoc-link-bar-status");
  if (!statusEl) return;
  if (_statusTimer) { clearTimeout(_statusTimer); _statusTimer = null; }
  statusEl.textContent = text || "";
  statusEl.classList.toggle("visible", !!text);
  statusEl.classList.toggle("success", mode === "success");
  statusEl.classList.toggle("error", mode === "error");
  if (autoClearMs && text) {
    _statusTimer = setTimeout(() => {
      statusEl.classList.remove("visible", "success", "error");
      statusEl.textContent = "";
      _statusTimer = null;
    }, autoClearMs);
  }
}

function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Two-arrow link icon (one up, one down) — mirrors the sidebar
 *  decorator that marks files with a Google Doc link. */
const ICON_LINK = `<svg class="gdoc-link-bar-icon" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 10.5 V1.5 M1.5 3.5 L3.5 1.5 L5.5 3.5"/><path d="M8.5 1.5 V10.5 M6.5 8.5 L8.5 10.5 L10.5 8.5"/></svg>`;
