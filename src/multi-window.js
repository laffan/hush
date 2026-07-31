/**
 * Multi-window support — desktop only.
 *
 * Each Hush window registers itself with the Rust-side WindowRegistry
 * (`commands/multi_window.rs`) on startup, claims a sequential number,
 * and tells the registry whenever its active doc/notebook changes.
 * Sibling windows listen for `windows-updated` and `cross-window-state-
 * changed` so the sidebar can paint per-window numeral badges and
 * settings / file-tree mutations propagate.
 *
 * The "Open in new window" command palette action calls
 * `openInNewWindow()` here, which spawns a `WebviewWindow` whose URL
 * hash carries the file the user was viewing — `main.js` reads the hash
 * during init and seeds that window's `currentFileId` from it.
 */

import { isIOSTauri } from "./command-palette-helpers.js";
import { applyExternalDocContent } from "./sync/apply-external.js";
import { findNode, findNodeByFileId } from "./state/tree-helpers.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

let currentLabel = null;
let parsedHash = null;

/** Read `#file=...&type=...` once at module-eval time and stash it so
 *  every consumer (init, sidebar, etc.) sees the same payload. */
function getInitialHashParams() {
  if (parsedHash !== null) return parsedHash;
  parsedHash = {};
  if (typeof window === "undefined") return parsedHash;
  const raw = window.location?.hash || "";
  const trimmed = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!trimmed) return parsedHash;
  for (const pair of trimmed.split("&")) {
    const [k, v] = pair.split("=");
    if (k) parsedHash[decodeURIComponent(k)] = v != null ? decodeURIComponent(v) : "";
  }
  return parsedHash;
}

/** Returns `{ fileId, fileType }` if this window was launched with a
 *  pinned initial document, otherwise `null` (the window restores from
 *  `lastFileId` like the main window does). */
export function getInitialFileFromHash() {
  const h = getInitialHashParams();
  if (h.file && h.type) return { fileId: h.file, fileType: h.type };
  return null;
}

/** Desk id this window was launched into, or `null`. "Open in new
 *  window" seeds it with the opener's active desk so the new window
 *  starts where the user was — desks are per-window after that (the
 *  opener's later switches don't follow it). */
export function getInitialDeskFromHash() {
  const h = getInitialHashParams();
  return h.desk || null;
}

async function getLabel() {
  if (currentLabel != null) return currentLabel;
  if (!IS_TAURI) {
    currentLabel = "main";
    return currentLabel;
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    currentLabel = getCurrentWindow().label;
  } catch (_) {
    currentLabel = "main";
  }
  return currentLabel;
}

export async function getCurrentWindowLabel() {
  return getLabel();
}

/** Register this window with the backend registry. Returns the assigned
 *  WindowInfo (`{ label, number, fileId, fileType }`). */
export async function registerThisWindow() {
  if (!IS_TAURI) return { label: "main", number: 1, fileId: null, fileType: null };
  const { invoke } = await import("@tauri-apps/api/core");
  const label = await getLabel();
  return invoke("register_window", { label });
}

/** Push the current window's open file to the registry so other windows
 *  can render the right numeral badge. Pass `null` for both fields when
 *  no file is open. */
export async function pushCurrentFile(fileId, fileType) {
  if (!IS_TAURI) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const label = await getLabel();
    await invoke("set_window_file", { label, fileId, fileType });
  } catch (e) {
    console.warn("set_window_file failed:", e);
  }
}

/** Tell the backend to remove this window from the registry. The Rust
 *  side also runs this on `WindowEvent::Destroyed`, but JS unloading
 *  beats us there for "closed via UI" so we explicitly call on hide too. */
export async function unregisterThisWindow() {
  if (!IS_TAURI) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const label = await getLabel();
    await invoke("unregister_window", { label });
  } catch (_) { /* window probably tearing down */ }
}

/** Fetch the current full window list. Used at init time — subsequent
 *  updates arrive via the `windows-updated` event. */
export async function fetchWindowList() {
  if (!IS_TAURI) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke("list_windows")) || [];
  } catch (e) {
    console.warn("list_windows failed:", e);
    return [];
  }
}

/** Open the given file in a brand-new window. `fileType` is one of
 *  `"document"`, `"notebook"`, or `"project"`. The new window is loaded
 *  from `index.html#file=<id>&type=<type>`; its `main.js` picks the
 *  hash up via `getInitialFileFromHash()` and overrides the usual
 *  "restore last file" behaviour. */
export async function openInNewWindow(fileId, fileType, deskId = null) {
  if (!IS_TAURI) return;
  if (!fileId || !fileType) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  // Unique label so the registry can distinguish windows opened in quick
  // succession. Crypto's randomUUID is widely available in WebViews.
  const id = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  const label = `window-${id}`;
  const url =
    `index.html#file=${encodeURIComponent(fileId)}&type=${encodeURIComponent(fileType)}`
    + (deskId ? `&desk=${encodeURIComponent(deskId)}` : "");
  // iPad multi-window is native since Tauri 2.11: `new WebviewWindow` spawns
  // a real UIScene with full IPC, seeded by the same URL hash the desktop
  // path uses. iOS scenes are sized/decorated by the system, so the desktop
  // chrome options (size, decorations, overlay title bar, transparency)
  // don't apply there — pass only the URL.
  const opts = isIOSTauri()
    ? { url }
    : {
        url,
        title: "",
        width: 720,
        height: 720,
        resizable: true,
        decorations: true,
        transparent: true,
        titleBarStyle: "Overlay",
        hiddenTitle: true,
        dragDropEnabled: false,
        center: true,
      };
  const win = new WebviewWindow(label, opts);
  // Surface creation errors but don't throw — the palette already closed.
  win.once("tauri://error", (e) => {
    console.error("Failed to open new window:", e);
  });
}


/** Notify other windows that a piece of cross-window state mutated.
 *  `kind` is `"settings"` or `"files"`. The originator label is embedded
 *  so each receiver can ignore its own echo. */
export async function broadcastStateChange(kind) {
  if (!IS_TAURI) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const originator = await getLabel();
    await invoke("broadcast_state_change", { kind, originator });
  } catch (e) {
    console.warn("broadcast_state_change failed:", e);
  }
}

/** Push a live document edit to other windows. Debounced by callers —
 *  see `setupMultiWindow`'s 250 ms doc-content-changed throttle. */
export async function broadcastDocChanged(fileId, content) {
  if (!IS_TAURI) return;
  if (!fileId) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const originator = await getLabel();
    await invoke("broadcast_doc_changed", { fileId, content, originator });
  } catch (e) {
    console.warn("broadcast_doc_changed failed:", e);
  }
}

/** Notify other windows that a notebook was saved so siblings showing
 *  it can reload from disk. Id-only on purpose: the envelope is
 *  multi-MB for stroke-heavy notebooks, and marshalling it through the
 *  invoke + event fan-out blocked the saving window's JS thread for
 *  ~60 ms/MB on every autosave — the mid-writing frame stall the perf
 *  harness kept catching. The save has already landed when this fires,
 *  so disk is authoritative for receivers. */
export async function broadcastNotebookChanged(fileId) {
  if (!IS_TAURI) return;
  if (!fileId) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const originator = await getLabel();
    await invoke("broadcast_notebook_changed", { fileId, originator });
  } catch (e) {
    console.warn("broadcast_notebook_changed failed:", e);
  }
}

/** Subscribe to cross-window events. Returns an unsubscribe function
 *  that detaches every listener. */
export async function subscribeCrossWindow({
  onWindowsUpdated,
  onStateChanged,
  onDocChanged,
  onNotebookChanged,
}) {
  if (!IS_TAURI) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const myLabel = await getLabel();
  const us = [];
  us.push(await listen("windows-updated", (event) => {
    if (typeof onWindowsUpdated === "function") onWindowsUpdated(event.payload || []);
  }));
  us.push(await listen("cross-window-state-changed", (event) => {
    const { kind, originator } = event.payload || {};
    if (originator === myLabel) return; // our own echo
    if (typeof onStateChanged === "function") onStateChanged(kind);
  }));
  us.push(await listen("cross-window-doc-changed", (event) => {
    const { fileId, content, originator } = event.payload || {};
    if (originator === myLabel) return;
    if (typeof onDocChanged === "function") onDocChanged(fileId, content);
  }));
  us.push(await listen("cross-window-notebook-changed", (event) => {
    const { fileId, originator } = event.payload || {};
    if (originator === myLabel) return;
    if (typeof onNotebookChanged === "function") onNotebookChanged(fileId);
  }));
  return () => { for (const u of us) { try { u(); } catch (_) {} } };
}

/** Resolve `(state) → { fileId, fileType }` for whichever surface is
 *  currently active in the given AppState. Notebooks win over projects
 *  win over docs (mirroring how state.openX functions clear the others). */
function currentFileFromState(state) {
  if (state.currentNotebookFileId) return { fileId: state.currentNotebookFileId, fileType: "notebook" };
  if (state.currentProjectId) return { fileId: state.currentProjectId, fileType: "project" };
  if (state.currentFileId) return { fileId: state.currentFileId, fileType: "document" };
  return { fileId: null, fileType: null };
}

/** "[Desk Name]-[File Name]" for the native window title. The in-window
 *  chrome hides titles, but Mission Control (macOS) and the app
 *  switcher / Stage Manager pickers (iPadOS) read them. Falls back to
 *  the desk alone with nothing open, and to "Hush" before boot. */
function computeWindowTitle(state) {
  const deskName = state.getActiveDesk?.()?.name || "";
  const tree = state.fileTree || [];
  let fileName = "";
  if (state.currentProjectId) {
    fileName = findNode(tree, state.currentProjectId)?.name || "";
  } else {
    const fileId = state.currentStackFileId || state.currentPdfFileId
      || state.currentNotebookFileId || state.currentFileId;
    if (fileId) fileName = findNodeByFileId(tree, fileId)?.name || "";
    else if (state.currentLocalSync?.name) fileName = state.currentLocalSync.name;
  }
  return [deskName, fileName].filter(Boolean).join("-") || "Hush";
}

let _lastPushedTitle = null;

/** Push the computed title to the native window (deduped — most of the
 *  triggering events fire far more often than the title changes). */
export async function updateWindowTitle(state) {
  if (!IS_TAURI) return;
  const title = computeWindowTitle(state);
  if (title === _lastPushedTitle) return;
  _lastPushedTitle = title;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const label = await getLabel();
    await invoke("set_window_display_title", { label, title });
  } catch (e) {
    console.warn("set_window_display_title failed:", e);
  }
}

/** End-to-end multi-window wiring for `main.js`. Subscribes to every
 *  cross-window event first (so the upcoming register/push echoes feed
 *  back through the same pipe and `state.windowList` populates without
 *  a separate fetchWindowList round-trip), then claims this window's
 *  number from the Rust registry and pushes the currently-open file.
 *
 *  Beyond registry maintenance, this helper also drives live content
 *  sync: doc keystrokes broadcast (debounced 250 ms) so siblings can
 *  apply the buffer in place; notebook autosaves broadcast the saved
 *  file's id so siblings can reload the fresh envelope from disk. The
 *  helper lives in this module rather than inline in `main.js` to keep
 *  the entry point under the project's 700-line cap. */
export async function setupMultiWindow(state) {
  if (!IS_TAURI) return;

  const myLabel = await getLabel();

  // Subscribe BEFORE register/push so the broadcasts that those calls
  // emit are picked up as our own initial windowList population.
  await subscribeCrossWindow({
    onWindowsUpdated: (list) => {
      state.windowList = list || [];
      // Numbers are derived ordinals now (renumbered 1..N on every
      // membership change), so our own can shift when a sibling closes.
      const mine = state.windowList.find((w) => w.label === myLabel);
      if (mine?.number) state.currentWindowNumber = mine.number;
      state.emit("windows-changed");
    },
    onStateChanged: async (kind) => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        if (kind === "settings") {
          const fresh = await invoke("get_settings");
          const yahBefore = JSON.stringify(state.settings.youAreHere || {});
          // Preserve this window's per-window keys — the sender stripped
          // them on its way out, but we re-pin them here defensively so
          // a buggy sender can't blow away our session state in memory.
          const keep = {
            lastFileId: state.settings.lastFileId,
            lastNotebookId: state.settings.lastNotebookId,
            lastProjectId: state.settings.lastProjectId,
            scrollPosition: state.settings.scrollPosition,
            typewriterMode: state.settings.typewriterMode,
            dryMode: state.settings.dryMode,
            // Desks are per-window: a sibling switching desks (or saving
            // settings while on another desk) must not flip this window's
            // sidebar / style / shortcut-target desk out from under it.
            activeDeskId: state.settings.activeDeskId,
          };
          Object.assign(state.settings, fresh, keep);
          state.emit("settings-changed");
          state.emit("theme-changed");
          // A sibling planting/clearing a YOUAREHERE marker must repaint
          // this window's sidebar row too — scoped to actual registry
          // changes so ordinary settings echoes don't rebuild the panel.
          if (JSON.stringify(state.settings.youAreHere || {}) !== yahBefore) {
            state.emit("you-are-here-changed");
          }
        } else if (kind === "files") {
          state.fileTree = await invoke("get_file_tree");
          state.files = await invoke("list_files");
          state.emit("files-changed");
        }
      } catch (e) {
        console.warn("Failed to apply cross-window state change:", e);
      }
    },
    onDocChanged: (fileId, content) => applyRemoteDocChange(state, fileId, content),
    onNotebookChanged: (fileId) => applyRemoteNotebookChange(state, fileId),
  });

  try {
    const info = await registerThisWindow();
    state.currentWindowNumber = info?.number || 1;
    const { fileId, fileType } = currentFileFromState(state);
    await pushCurrentFile(fileId, fileType);
  } catch (e) {
    console.warn("Multi-window registration failed:", e);
  }

  const syncWindowFile = () => {
    const { fileId, fileType } = currentFileFromState(state);
    pushCurrentFile(fileId, fileType);
  };
  state.on("file-opened", syncWindowFile);
  state.on("notebook-open", syncWindowFile);

  // Native window title — "[Desk Name]-[File Name]". Recomputed on
  // anything that can change either half: opening any surface,
  // switching desks, and renames (files-changed / desks-changed).
  const syncTitle = () => { void updateWindowTitle(state); };
  for (const ev of [
    "file-opened", "notebook-open", "pdf-open", "stack-open",
    "active-desk-changed", "files-changed", "desks-changed",
  ]) state.on(ev, syncTitle);
  syncTitle();

  // Live doc broadcast — fires on the doc-content-changed pulse main.js
  // adds to markDirty(). Debounced so a fast typist doesn't flood the
  // event bus, but well under the 2 s autosave so the other window
  // sees the buffer mid-paragraph rather than only on save.
  let docBroadcastTimer = null;
  state.on("doc-content-changed", () => {
    if (state.runtime.syncPulling) return; // we're applying a sibling's edit
    if (!state.currentFileId) return;
    if (state.currentProjectId) return; // project view = joined virtual buffer
    if (!state.editor) return;
    const fileId = state.currentFileId;
    clearTimeout(docBroadcastTimer);
    docBroadcastTimer = setTimeout(() => {
      try { broadcastDocChanged(fileId, state.editor.getContent()); }
      catch (_) { /* editor torn down */ }
    }, 250);
  });

  // Notebook saves ride the existing 2 s autosave — main.js calls
  // `saveNotebook()` on the `notebook-autosave` event and re-emits the
  // saved file's id through `notebook-cross-window-broadcast` for us to
  // pick up (id-only; siblings reload from disk).
  state.on("notebook-cross-window-broadcast", ({ fileId }) => {
    if (state.runtime.syncPulling) return;
    if (!fileId) return;
    broadcastNotebookChanged(fileId);
  });

  // Best-effort cleanup — Rust drops us from the registry on
  // `WindowEvent::Destroyed`, but the JS unload path beats that for the
  // "user closed the window" case. `pagehide` rides along because iOS
  // WebKit frequently skips `beforeunload` entirely (unregister is
  // idempotent, so both firing is harmless).
  window.addEventListener("beforeunload", () => { unregisterThisWindow(); });
  window.addEventListener("pagehide", (e) => {
    if (e.persisted) return; // backgrounded, not closing
    unregisterThisWindow();
  });

  // Liveness heartbeat. iPad scene teardown can be completely silent —
  // no destroy event, no unload — so the registry expires entries that
  // stop beating (mobile-side, 15 s) and this ping is what keeps ours
  // alive. A `true` reply means we had been expired while suspended and
  // were just re-registered: re-push our file so our badge comes back
  // on the right row. Timers stop while iOS suspends us, which is
  // exactly the point — a scene that isn't running drops off siblings'
  // sidebars, then reappears here the moment it resumes.
  const heartbeat = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const reRegistered = await invoke("window_heartbeat", { label: myLabel });
      if (reRegistered) syncWindowFile();
    } catch (_) { /* backend unavailable mid-teardown */ }
  };
  setInterval(heartbeat, 4000);

  // Coming back to the foreground: re-assert ourselves (our entry may
  // have been expired while we slept), re-push our file, and re-fetch
  // the pruned list so any badge left by a close we slept through
  // clears immediately instead of on the next heartbeat.
  const resyncWindowList = async () => {
    try {
      await registerThisWindow();
      syncWindowFile();
    } catch (_) {}
    const list = await fetchWindowList();
    const current = JSON.stringify(state.windowList || []);
    if (JSON.stringify(list) === current) return;
    state.windowList = list;
    const mine = list.find((w) => w.label === myLabel);
    if (mine?.number) state.currentWindowNumber = mine.number;
    state.emit("windows-changed");
  };
  window.addEventListener("focus", () => { void resyncWindowList(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void resyncWindowList();
  });
}

/** Apply a sibling window's live doc edit to the local editor when our
 *  current file matches. Preserves the cursor / selection across the
 *  setContent dispatch (clamped to the new content length) and uses the
 *  existing pull-lock plumbing so the resulting docChanged round-trip
 *  doesn't mark the editor dirty (and doesn't re-broadcast). */
function applyRemoteDocChange(state, fileId, content) {
  if (!state.editor) return;
  if (state.currentFileId !== fileId) return;
  // Shared apply layer: pull-locked, diff-based — the local cursor maps
  // through the sibling's edit rather than being clamped to doc bounds.
  applyExternalDocContent(state, { content, lockKey: fileId });
}

/** Apply a sibling notebook save to our open canvas via the lazy
 *  notebook bridge. The broadcast is id-only (see
 *  broadcastNotebookChanged) — the sibling's save has already landed,
 *  so read the fresh envelope from disk here. Acquires the pull lock so
 *  the reload doesn't loop back through the autosave path. */
async function applyRemoteNotebookChange(state, fileId) {
  if (state.currentNotebookFileId !== fileId) return;
  state.acquirePullLock(fileId);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const file = await invoke("load_file", { id: fileId });
    const m = await import("./notebook/notebook-bridge.js");
    if (file && typeof m.reloadNotebookShapes === "function") {
      await m.reloadNotebookShapes(file.content);
    }
  } catch (e) {
    console.warn("Failed to apply remote notebook change:", e);
  } finally {
    state.releasePullLock();
  }
}
