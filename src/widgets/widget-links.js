/**
 * What a tap on a home screen widget does. Every tap target in the
 * widgets is a `hushwriter://widget` link:
 *
 *   hushwriter://widget?action=open-desk&desk=<deskId>
 *   hushwriter://widget?action=open-file&desk=<deskId>&file=<id>&type=<type>
 *   hushwriter://widget?action=new-doc&desk=<deskId>
 *   hushwriter://widget?action=new-notebook&desk=<deskId>
 *
 * They arrive through the deep-link router (main window only, like every
 * hushwriter:// request). Unlike a companion app's request, a widget's
 * link is fixed — the same URL every time that button is tapped — so it
 * can't carry a nonce, and iPadOS delivers a link more than once (to
 * every window, again from a replayed `getCurrent()` after a webview
 * reload). Opening a file twice is harmless; making two documents is
 * not. So each delivery is *claimed* from Rust (`claim_widget_link`),
 * whose memory lasts exactly as long as the app process: a repeat
 * within a few seconds, or a launch link replayed into a reloaded
 * webview, is refused there, while the same button tapped again later
 * goes through.
 */
import { isIOSTauri } from "../command-palette-helpers.js";

const ACTIONS = new Set(["open-desk", "open-file", "new-doc", "new-notebook"]);
const REPEAT_WINDOW_MS = 4000;

export function isWidgetUrl(url) {
  return typeof url === "string" && /^hushwriter:\/\/widget(?:[/?]|$)/i.test(url);
}

function parse(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const p = (k) => (u.searchParams.get(k) || "").trim();
  const action = p("action").toLowerCase();
  if (!ACTIONS.has(action)) return null;
  return { action, desk: p("desk"), file: p("file"), type: p("type").toLowerCase() };
}

/** One delivery of `url` gets through. `cold` marks a link that was
 *  waiting when this window booted (`getCurrent()`), which is the one a
 *  webview reload replays. Falls back to a short localStorage window on
 *  a binary without the command. */
async function claim(url, cold) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return !!(await invoke("claim_widget_link", { url, cold }));
  } catch (_) {
    try {
      const key = "hush-widget-link-last";
      const last = JSON.parse(localStorage.getItem(key) || "null");
      if (last && last.url === url && Date.now() - last.at < REPEAT_WINDOW_MS) return false;
      localStorage.setItem(key, JSON.stringify({ url, at: Date.now() }));
    } catch (_) { /* storage unavailable — proceed */ }
    return true;
  }
}

/** Bring the (possibly tray-hidden) window forward. `setFocus()` is
 *  desktop-only: on iOS it asks for a new scene (README-TECHNICAL,
 *  "Never call setFocus() on iOS"). */
async function surfaceWindow() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    await w.show();
    if (!isIOSTauri()) await w.setFocus();
  } catch (_) { /* headless contexts */ }
}

/** Wait for a desk to be in the forest — a local desk's folder can load
 *  seconds after a cold launch, which is exactly when a widget tap
 *  arrives. */
async function waitForDesk(state, deskId, timeoutMs = 15000) {
  const has = () => Array.isArray(state.fileTree)
    && state.fileTree.some((n) => n.type === "desk" && n.id === deskId);
  const start = Date.now();
  while (!has() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300));
  }
  return has();
}

/** Make `deskId` the active desk, and wait for the switch's own restore
 *  (it opens the desk's last file) to land, so whatever this tap opens
 *  next isn't superseded by it. main.js emits `desk-overview-restore`
 *  once that open is done. */
async function switchToDesk(state, deskId) {
  if (state.settings?.activeDeskId === deskId) return;
  const restored = new Promise((resolve) => {
    const done = () => { state.off("desk-overview-restore", done); clearTimeout(t); resolve(); };
    const t = setTimeout(done, 8000);
    state.on("desk-overview-restore", done);
  });
  await state.setActiveDesk(deskId);
  await restored;
}

async function openEntry(state, id, type) {
  if (type === "notebook") return state.openNotebook(id);
  if (type === "project") return state.openProject(id);
  if (type === "stack") return state.openStack(id);
  if (type === "pdf") return state.openPdf(id);
  return state.openFile(id);
}

/** Handle one widget link. Returns false when the URL isn't one. */
export async function handleWidgetUrl(state, url, cold = false) {
  const req = parse(url);
  if (!req) return false;
  if (!(await claim(url, cold))) return true;
  await surfaceWindow();

  const deskId = req.desk || state.settings?.activeDeskId;
  if (!deskId || !(await waitForDesk(state, deskId))) {
    const { showImportToast } = await import("../editor/import-toast.js");
    showImportToast("That desk isn't available on this device any more", "error");
    return true;
  }
  await switchToDesk(state, deskId);

  if (req.action === "open-file" && req.file) {
    await openEntry(state, req.file, req.type);
  } else if (req.action === "new-doc") {
    await state.newFile();
  } else if (req.action === "new-notebook") {
    // The same name-first prompt every other New Notebook uses.
    const { promptNewNotebookName } = await import("../command-palette-pickers.js");
    promptNewNotebookName((name) => state.createNotebook(name));
  }
  return true;
}
