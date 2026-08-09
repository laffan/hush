/**
 * Local desk roots — the JS face of Phases 3–4 of LOCAL-DESKS-PLANNING.md.
 *
 * A desk can operate from a folder the user picked instead of app data;
 * the Rust side redirects all storage through `roots.json`, arms a
 * filesystem watcher on each root, and reconciles the tree disk-wins
 * when the folder changes underneath us. This module wraps the commands,
 * keeps `state.deskRoots` (deskId → path) cached for UI badges, and owns
 * the `desk-changed` watcher listener.
 *
 * iOS differs in exactly two ways, both handled here: folders are picked
 * through the icloud-folder plugin (which mints a security-scoped
 * bookmark that boot must re-resolve before Rust can touch the folder),
 * and there is no filesystem watcher — every local desk is reconciled
 * when the app comes to the foreground instead.
 */

import { applyExternalDocContent } from "./apply-external.js";
import { isIOSTauri } from "../command-palette-helpers.js";
import { logActivity } from "../activity-log.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

async function plugin(cmd, args) {
  return invoke(`plugin:icloud-folder|${cmd}`, args);
}

/** Present the platform folder picker. Returns
 *  `{ path, bookmark|null }` or null when cancelled. */
async function pickFolder(title) {
  if (isIOSTauri()) {
    try {
      const picked = await plugin("pick_folder");
      return picked ? { path: picked.path, bookmark: picked.bookmark } : null;
    } catch (e) {
      if (String(e).includes("cancelled")) return null;
      throw e;
    }
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title });
  return picked ? { path: picked, bookmark: null } : null;
}

/** The sidecars that say *which desk* a folder is. Order matters only in
 *  that `.hushdesk` is the one the identity is read from first. */
const DESK_SIDECARS = [".hushdesk", ".hush/tree.json", ".hush/index.json"];

/** iOS: get a folder's desk sidecars onto the device before anything
 *  asks what desk it is.
 *
 *  This is the difference between the two platforms that made the same
 *  gesture safe on a Mac and destructive on an iPad. macOS materialises
 *  a dataless file on `open()`; iOS does not — an evicted file is a
 *  `.<name>.icloud` placeholder and plain `std::fs` (which is the entire
 *  desk store) never triggers a download. So an undelivered `.hushdesk`
 *  read as "not a desk folder", and the answer to that used to be "then
 *  it's a blank folder — mint a new desk here": two devices, two ids,
 *  one folder, and the identity flip-flopping between them on every
 *  save. Rust now refuses to guess (`desk_identity::inspect_folder`),
 *  and this makes sure it usually doesn't have to. The plugin's
 *  coordinated read runs `startDownloadingUbiquitousItem` and waits for
 *  the bytes. */
export async function materialiseDeskSidecars(root) {
  if (!isIOSTauri() || !root) return;
  const base = String(root).replace(/\/+$/, "");
  for (const rel of DESK_SIDECARS) {
    try { await plugin("read_file", { path: `${base}/${rel}` }); }
    catch (_) { /* absent, offline, or genuinely not a desk — the caller decides */ }
  }
}

/** Last path segment of a picked folder — a local desk's name. Handles
 *  both separators and tolerates a trailing slash. */
export function folderName(path) {
  const parts = String(path || "").replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "Desk";
}

/** Point a desk's name at its folder. Local desks are named by the
 *  folder they live in, so this is the only writer of a local desk's
 *  name — hence `force`, which steps past renameDesk's local guard. */
async function adoptFolderName(state, deskId, path) {
  try {
    await state.renameDesk(deskId, folderName(path), { force: true });
  } catch (e) {
    console.warn("naming desk after its folder failed:", e);
  }
}

/** Refresh `state.deskRoots` from Rust and notify listeners.
 *
 *  A change in the *key set* means the identity repair re-keyed a folder
 *  (or a desk came or went), and desk watchers are keyed by desk id — so
 *  re-arm them, or the folder ends up watched under an id nothing
 *  resolves while the live desk is watched by nobody. */
export async function refreshDeskRoots(state) {
  if (!IS_TAURI) { state.deskRoots = {}; return {}; }
  const before = Object.keys(state.deskRoots || {}).sort().join("|");
  try {
    state.deskRoots = await invoke("desk_list_roots") || {};
  } catch (e) {
    console.warn("desk_list_roots failed:", e);
    state.deskRoots = state.deskRoots || {};
  }
  if (Object.keys(state.deskRoots).sort().join("|") !== before) {
    try { await invoke("desk_rearm_watchers"); }
    catch (e) { console.warn("desk_rearm_watchers failed:", e); }
  }
  state.emit("desk-roots-changed");
  return state.deskRoots;
}

export function isLocalDesk(state, deskId) {
  return !!(deskId && state.deskRoots && state.deskRoots[deskId]);
}

/** Reload the tree from disk after Rust mutated it (reconcile/adopt).
 *  The load is also where a desk's registration is repaired against the
 *  id its folder carries, so re-read the roots afterwards — that's what
 *  notices a re-key and re-arms the watchers. */
async function reloadTree(state) {
  try {
    state.fileTree = await invoke("get_file_tree");
    state.emit("files-changed");
  } catch (e) { console.warn("tree reload failed:", e); }
  await refreshDeskRoots(state);
}

/** Pick a folder and move the desk there. */
export async function makeDeskLocal(state, deskId) {
  if (!IS_TAURI) return false;
  const picked = await pickFolder("Choose a folder for this desk");
  if (!picked) return false;
  try {
    await invoke("desk_make_local", { deskId, targetPath: picked.path, bookmark: picked.bookmark });
  } catch (e) {
    window.alert(`Couldn't make the desk local:\n${e}`);
    return false;
  }
  await refreshDeskRoots(state);
  // The desk now lives in the user's folder, so the folder names it.
  await adoptFolderName(state, deskId, picked.path);
  if (isIOSTauri()) {
    try { await plugin("start_watch", { path: picked.path }); } catch (_) {}
  }
  return true;
}

/** Move a local desk's folder back into app data. */
export async function makeDeskInternal(state, deskId) {
  if (!IS_TAURI) return false;
  const oldPath = state.deskRoots?.[deskId];
  if (oldPath && isIOSTauri()) {
    try { await plugin("stop_watch", { path: oldPath }); } catch (_) {}
  }
  try {
    await invoke("desk_make_internal", { deskId });
  } catch (e) {
    window.alert(`Couldn't make the desk internal:\n${e}`);
    return false;
  }
  await refreshDeskRoots(state);
  return true;
}

/** Pick a folder and open it **as** a desk — the folder itself becomes
 *  the desk root. A folder that is already a Hush desk is adopted whole
 *  (identity, ordering, version history) — including the case that
 *  matters most: the folder your *other* device already keeps a desk in,
 *  which joins that desk rather than starting a rival one beside it. A
 *  folder with no trace of a desk is initialised in place, and whatever
 *  docs, notebooks and images are already sitting in it are absorbed as
 *  the desk's contents. Nothing is moved or nested. Returns the desk id,
 *  or null.
 *
 *  Both the **New desk → Use Local Folder as Desk…** branch and the
 *  command palette entry land here; they differ only in the prompt. */
export async function adoptDeskFolder(state, title = "Choose a folder to use as a desk") {
  if (!IS_TAURI) return null;
  const picked = await pickFolder(title);
  if (!picked) return null;
  // Ask iCloud for the folder's identity sidecars first — see
  // materialiseDeskSidecars. Rust refuses to initialise over a desk it
  // can't read, so without this an undelivered folder is a dead end
  // rather than a wrong answer; with it, it usually just works.
  await materialiseDeskSidecars(picked.path);
  let outcome = null;
  try {
    outcome = await invoke("desk_open_folder_as_desk", { path: picked.path, bookmark: picked.bookmark });
  } catch (e) {
    logActivity("desks", "error", "Couldn't open a folder as a desk", { path: picked.path, error: String(e) });
    window.alert(`Couldn't open that folder as a desk:\n${e}`);
    return null;
  }
  // Older builds of the command answered with a bare id string.
  const deskId = typeof outcome === "string" ? outcome : outcome?.deskId || null;
  logActivity("desks", "info",
    outcome?.adopted
      ? `Joined the desk already in "${folderName(picked.path)}"`
      : `Made "${folderName(picked.path)}" a desk in place`,
    { deskId, files: outcome?.absorbed ?? null, path: picked.path });
  await refreshDeskRoots(state);
  await reloadTree(state);
  // Mirror the desk into the settings registry so the switcher, pickers,
  // and per-desk meta all see it. A local desk is named by its folder,
  // so the adopted name comes from the picked path rather than whatever
  // the producing install happened to call it.
  const name = folderName(picked.path);
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  if (desk && !(state.settings.desks || []).some((d) => d.id === deskId)) {
    const desks = [...(state.settings.desks || []), { id: deskId, name, createdAt: desk.createdAt }];
    const meta = { ...(state.settings.desksMeta || {}), [deskId]: { globalStyleId: null } };
    await state.updateSettings({ desks, desksMeta: meta });
  }
  await adoptFolderName(state, deskId, picked.path);
  await ensureSpecials(state, deskId);
  // The adopted .hushdesk carries the desk's portable meta (style
  // choice, last file, stickies) — fold it in over the null seed. A
  // folder we just initialised has none, so this is a no-op there.
  try {
    const { pullDeskMeta } = await import("./desk-meta.js");
    await pullDeskMeta(state, deskId);
  } catch (_) {}
  if (isIOSTauri()) {
    try { await plugin("start_watch", { path: picked.path }); } catch (_) {}
  }
  state.emit("desks-changed");
  if (deskId) await state.setActiveDesk(deskId);
  // One JS-side reconcile so the adoption surfaces what the Rust-side
  // post-adopt scan saw: files the provider hasn't delivered yet get
  // their downloads kicked (iOS) and a sync-log line, instead of the
  // desk quietly opening short. Removals are grace-gated in Rust, so
  // this can only add.
  if (deskId) await reconcileDesk(state, deskId);
  // Say what happened out loud. "I picked my other machine's folder and
  // the desk came up empty" is the report this whole path exists to
  // prevent, so the answer to "did it take my files?" shouldn't be
  // "count the rows in the sidebar".
  try {
    const deskNode = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
    const count = deskNode ? countFiles(deskNode.children) : 0;
    const { showImportToast } = await import("../editor/import-toast.js");
    showImportToast(
      outcome?.adopted
        ? `Joined the desk already in "${name}" — ${count} file${count === 1 ? "" : "s"}`
        : `"${name}" is now a desk — ${count} existing file${count === 1 ? "" : "s"} absorbed`,
      "info",
    );
  } catch (_) {}
  return deskId;
}

/** File-backed rows under a desk, for the "what did I just get?" toast. */
function countFiles(nodes) {
  let n = 0;
  for (const node of nodes || []) {
    if (node?.fileId) n++;
    if (node?.children) n += countFiles(node.children);
  }
  return n;
}

/** Create a desk out of a folder the user picks — the New-desk fork's
 *  **Use Local Folder as Desk…** branch. Same operation as the command
 *  palette entry; only the picker's prompt differs. */
export function createLocalDesk(state) {
  return adoptDeskFolder(state, "Choose a folder to use as this desk");
}

/** Safety net for the desk's Inbox / Images / Archive / Trash. Rust
 *  seeds them when it initialises a folder, and a desk folder from
 *  another install carries its own, so this normally finds nothing to
 *  do — it only fires for a folder whose tree.json predates a special. */
async function ensureSpecials(state, deskId) {
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  if (!desk) return;
  const { ensureDeskSpecials } = await import("../state/state-desks.js");
  if (ensureDeskSpecials(desk).length === 0) return;
  await state.saveFileTree();
  state.emit("files-changed");
}

/** Explicitly disconnect a local desk's folder — the archive-desk path.
 *  `save_forest` never unregisters a root on its own (a desk missing
 *  from one saved tree is indistinguishable from a stale tree), so
 *  removing a desk has to say so out loud before the tree save. The
 *  folder on disk is untouched: archiving a local desk copies it into the
 *  archive and leaves the user's own folder exactly where it is. */
export async function unregisterDeskRoot(state, deskId) {
  if (!IS_TAURI) return;
  const path = state.deskRoots?.[deskId];
  if (!path) return;
  if (isIOSTauri()) {
    try { await plugin("stop_watch", { path }); } catch (_) {}
  }
  try {
    await invoke("desk_unregister_root", { deskId });
  } catch (e) {
    console.warn("desk_unregister_root failed:", e);
  }
  await refreshDeskRoots(state);
}

/** Reveal a local desk's folder in the OS file manager. */
export async function revealDeskRoot(state, deskId) {
  const path = state.deskRoots?.[deskId];
  if (!path) return;
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.revealItemInDir(path);
  } catch (e) { console.error("reveal desk folder failed:", e); }
}

/** How many placeholder downloads one reconcile pass will ask iCloud
 *  for. The next reconcile (watcher / foreground / boot) picks up where
 *  this one left off, so a huge desk drains in slices instead of
 *  queueing hundreds of coordinated reads at once. */
const MAX_DOWNLOAD_KICKS = 25;

/** iOS: ask iCloud to materialise files the reconciler saw only as
 *  `.icloud` placeholders. Plain `std::fs` (the desk I/O path) never
 *  triggers a download, so without this an evicted file would stay
 *  invisible forever. The plugin's coordinated `read_file` runs
 *  `startDownloadingUbiquitousItem` and blocks until the bytes land —
 *  run detached and sequential so reconciles aren't held up and the
 *  daemon isn't hammered. Desktop is a no-op: post-12.3 macOS shows
 *  dataless files under their real names and materialises them on read.
 *
 *  A file only becomes a *tree row* on the next reconcile, so this
 *  re-runs one itself once anything actually landed. The
 *  NSMetadataQuery watch would normally do that — but it is iCloud-only
 *  (a Dropbox or Syncthing folder emits nothing) and it can be
 *  unavailable, in which case the freshly-downloaded file would sit
 *  there unseen until the next time the app came to the foreground.
 *  Gated on a read having *succeeded*, so a file that can't download
 *  can't spin this in a loop. */
function kickPendingDownloads(state, deskId, report) {
  if (!isIOSTauri()) return;
  const paths = (report?.pendingDownloads || []).slice(0, MAX_DOWNLOAD_KICKS);
  if (paths.length === 0) return;
  void (async () => {
    let landed = 0;
    for (const path of paths) {
      try { await plugin("read_file", { path }); landed++; }
      catch (_) { /* offline / gone — next pass retries */ }
    }
    if (landed > 0) await reconcileDesk(state, deskId).catch(() => {});
  })();
}

// Last "N files awaiting download / in removal grace" count logged per
// desk, so the sync log records changes rather than every scan.
const _lastPendingLogged = new Map();

async function notePendingFiles(state, deskId, report) {
  const pending = report?.pending || 0;
  if (pending === (_lastPendingLogged.get(deskId) || 0)) return;
  _lastPendingLogged.set(deskId, pending);
  if (pending === 0) return;
  try {
    const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
    const { appendSyncLog } = await import("./sync-feedback.js");
    appendSyncLog(`${pending} file${pending === 1 ? "" : "s"} in "${desk?.name || deskId}" not downloaded yet — kept in place`);
  } catch (_) {}
}

/** Run the disk-wins reconcile for one desk and refresh the UI when it
 *  changed anything. Also reloads the open doc's buffer when its on-disk
 *  content moved (identical-content and dirty-buffer cases are both
 *  no-ops inside applyExternalDocContent). */
export async function reconcileDesk(state, deskId) {
  if (!IS_TAURI) return;
  let report = null;
  try {
    report = await invoke("desk_reconcile", { deskId });
  } catch (e) {
    console.warn("desk_reconcile failed:", e);
    // "no tree for desk" / "index.json hasn't downloaded yet" on iOS
    // means the folder's own sidecars aren't on the device — nothing
    // else ever asks iCloud for them, so the desk would stay stuck.
    // Detached: the next watcher event or foreground pass picks it up.
    void materialiseDeskSidecars(state.deskRoots?.[deskId]);
    return;
  }
  kickPendingDownloads(state, deskId, report);
  await notePendingFiles(state, deskId, report);
  // `matched` is in here too: it doesn't change the tree, but re-pairing
  // a row with the fileId the far device is writing under is exactly the
  // event worth having on the record when sync goes wrong.
  if (report && (report.added > 0 || report.removed > 0 || report.renamed > 0 || report.matched > 0)) {
    const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
    logActivity("desks", report.removed > 0 ? "warn" : "info",
      `Desk folder reconciled: "${desk?.name || deskId}"`, report);
    await reloadTree(state);
    try {
      const { appendSyncLog } = await import("./sync-feedback.js");
      const bits = [];
      if (report.added) bits.push(`${report.added} added`);
      if (report.removed) bits.push(`${report.removed} removed`);
      if (report.renamed) bits.push(`${report.renamed} renamed`);
      if (report.matched) bits.push(`${report.matched} re-paired`);
      appendSyncLog(`Desk folder reconciled: ${bits.join(", ")}`);
    } catch (_) {}
  }
  if (report && report.conflicts > 0) {
    // A sync provider forked the file; Rust kept the newer side and
    // snapshotted both. Tell the user where the other side went.
    try {
      const { appendSyncLog } = await import("./sync-feedback.js");
      appendSyncLog(`Resolved ${report.conflicts} conflicted cop${report.conflicts === 1 ? "y" : "ies"} — both versions saved to Versions`);
    } catch (_) {}
    try {
      const { showImportToast } = await import("../editor/import-toast.js");
      showImportToast(
        report.conflicts === 1
          ? "A conflicted copy was resolved — both versions are in the Versions panel"
          : `${report.conflicts} conflicted copies were resolved — all versions are in the Versions panel`,
        "info",
      );
    } catch (_) {}
  }
  // An external change may include the desk's portable meta (style,
  // last file, stickies riding in .hushdesk) — pull it, disk wins.
  try {
    const { pullDeskMeta } = await import("./desk-meta.js");
    await pullDeskMeta(state, deskId);
  } catch (_) {}
  await maybeReloadOpenDoc(state, deskId);
  await maybeReloadOpenNotebook(state, deskId);
}

/** If the open doc lives in `deskId`, re-read it from disk and apply the
 *  external content under the standard guards. */
async function maybeReloadOpenDoc(state, deskId) {
  const fileId = state.currentFileId;
  if (!fileId || !state.editor || state.currentProjectId) return;
  if (!fileInDesk(state, deskId, fileId)) return;
  try {
    const file = await invoke("load_file", { id: fileId });
    if (!file || state.currentFileId !== fileId) return;
    applyExternalDocContent(state, {
      content: file.content,
      lockKey: fileId,
      skipWhenDirty: true,
    });
  } catch (_) { /* file may have just been removed by the reconcile */ }
}

/** The same thing for an open notebook — which the reconcile never did,
 *  so a canvas open on this device simply never saw the far device's
 *  strokes. The reconciler reports *structure* (added / removed /
 *  renamed); a `.hushnote` whose bytes changed under it is no event at
 *  all, exactly as with a doc, so the open surface has to re-read on
 *  every pass or it goes stale until it's closed and re-opened.
 *
 *  Routed through the `notebook-external-reload` event rather than an
 *  import, so this module stays clear of the lazily-loaded notebook
 *  bundle. The handler skips an unsaved canvas (the doc path's
 *  `skipWhenDirty` policy) and then `mirror`s the incoming content:
 *  local undo history survives, the remote edit lands as one
 *  checkpoint, content byte-identical to our own last write is a no-op,
 *  and the incoming camera is deliberately ignored — viewports are
 *  per-device. The pull lock keeps the mirror from looping back out
 *  through autosave.
 *
 *  Stacks (`.hushstack`) have no equivalent reload path and still need
 *  a re-open to pick up a far-side edit. */
async function maybeReloadOpenNotebook(state, deskId) {
  const fileId = state.currentNotebookFileId;
  if (!fileId || !fileInDesk(state, deskId, fileId)) return;
  state.acquirePullLock(fileId);
  try {
    const file = await invoke("load_file", { id: fileId });
    if (!file || state.currentNotebookFileId !== fileId) return;
    state.emit("notebook-external-reload", file.content);
  } catch (_) { /* file may have just been removed by the reconcile */ }
  finally { state.releasePullLock(); }
}

function fileInDesk(state, deskId, fileId) {
  const desk = (state.fileTree || []).find((n) => n.type === "desk" && n.id === deskId);
  if (!desk) return false;
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.fileId === fileId) return true;
      if (n.children && walk(n.children)) return true;
    }
    return false;
  };
  return walk(desk.children);
}

/** iOS boot: resolve every bookmarked root, which re-acquires
 *  security-scoped access (so plain Rust std::fs works on the folder for
 *  the rest of the run) and can surface a different container path than
 *  the one stored — repoint roots.json when it does. */
async function resolveBookmarkedRoots() {
  let entries = {};
  try {
    entries = await invoke("desk_list_root_entries") || {};
  } catch (e) {
    console.warn("desk_list_root_entries failed:", e);
    return;
  }
  for (const [deskId, entry] of Object.entries(entries)) {
    if (!entry?.bookmark) continue;
    try {
      const res = await plugin("resolve_bookmark", { bookmark: entry.bookmark });
      if (res?.stale) console.warn("desk root bookmark is stale:", deskId);
      if (res?.path && res.path !== entry.path) {
        await invoke("desk_update_root_path", { deskId, path: res.path });
      }
    } catch (e) {
      console.warn(`couldn't re-open local desk folder for ${deskId}:`, e);
    }
  }
}

/** Re-grant this process access to every local desk folder, and cache the
 *  roots map. **Must run before anything reads the file tree.**
 *
 *  On iOS a folder outside the app container is only reachable through a
 *  security-scoped bookmark; until `resolve_bookmark` has run, plain
 *  `std::fs` calls against that folder fail. `load_forest` skips a desk
 *  whose `.hush/tree.json` it can't read, so a boot that got ahead of
 *  this saw a forest with every local desk missing — and the boot repair
 *  downstream took that at face value: it pruned the desk registry,
 *  folded loose nodes into whichever desk was left, and saved the short
 *  forest back. Idempotent and cheap on desktop (no bookmarks to
 *  resolve), so callers don't have to branch on platform. */
export async function acquireLocalDeskAccess(state) {
  if (!IS_TAURI) return;
  if (isIOSTauri()) await resolveBookmarkedRoots();
  await refreshDeskRoots(state);
}

/** Reconcile every local desk — the iOS baseline in place of the
 *  desktop filesystem watcher, run at boot and on each return to
 *  foreground. */
async function reconcileAllLocalDesks(state) {
  for (const deskId of Object.keys(state.deskRoots || {})) {
    await reconcileDesk(state, deskId).catch((e) => console.warn("desk reconcile failed:", e));
  }
}

/** iOS live updates: an NSMetadataQuery per local desk root makes
 *  iCloud-synced changes land while the app is frontmost, instead of
 *  waiting for the next foreground reconcile. Non-iCloud provider
 *  folders emit nothing — the foreground reconcile stays the fallback
 *  for those. Errors are quietly ignored for the same reason. */
async function armIOSLiveUpdates(state) {
  const timers = new Map();
  try {
    const { addPluginListener } = await import("@tauri-apps/api/core");
    await addPluginListener("icloud-folder", "watch-changed", (payload) => {
      const path = payload?.path;
      if (!path) return;
      const deskId = Object.keys(state.deskRoots || {})
        .find((id) => state.deskRoots[id] === path);
      if (!deskId) return;
      clearTimeout(timers.get(deskId));
      timers.set(deskId, setTimeout(() => {
        timers.delete(deskId);
        reconcileDesk(state, deskId).catch(() => {});
      }, 400));
    });
  } catch (e) {
    // Without the listener there are no live updates at all on iPad —
    // only the foreground reconcile — so this is worth more than a
    // console line. (It went unnoticed for a while as exactly that: the
    // plugin's `registerListener` command wasn't in its permission set,
    // so every launch logged "not allowed" and quietly fell back.)
    console.warn("desk live-update listener failed:", e);
    logActivity("desks", "error", "iCloud live updates unavailable — falling back to foreground reconcile", { error: String(e) });
    try {
      const { appendSyncLog } = await import("./sync-feedback.js");
      appendSyncLog("[!] Live iCloud updates unavailable — desks refresh when the app returns to the foreground");
    } catch (_) {}
    return;
  }
  for (const path of Object.values(state.deskRoots || {})) {
    try {
      await plugin("start_watch", { path });
    } catch (_) { /* non-iCloud folder or older plugin — fallback covers it */ }
  }
}

/** Boot wiring: load the roots cache and subscribe to change signals —
 *  the per-root filesystem watcher on desktop (bursts coalesce behind a
 *  short debounce per desk), foreground reconcile on iOS. */
export async function installDeskRootsLifecycle(state) {
  if (!IS_TAURI) return;
  const { pullAllDeskMeta } = await import("./desk-meta.js");
  if (isIOSTauri()) {
    // main.js already ran this before `state.init()` so the boot tree
    // load could see the local desks; repeating it is a cheap no-op and
    // keeps this entry point self-sufficient.
    await acquireLocalDeskAccess(state);
    // Nudge every local desk's identity sidecars onto the device.
    // Detached on purpose: a coordinated read blocks until iCloud
    // delivers, and boot must not wait on the network. The watcher and
    // the foreground pass below are what act on the result.
    for (const path of Object.values(state.deskRoots || {})) void materialiseDeskSidecars(path);
    await pullAllDeskMeta(state);
    await reconcileAllLocalDesks(state);
    await armIOSLiveUpdates(state);
    let last = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < 2000) return; // fold rapid app-switch bounces
      last = now;
      reconcileAllLocalDesks(state).catch(() => {});
    });
    return;
  }
  await refreshDeskRoots(state);
  await pullAllDeskMeta(state);
  // Boot reconcile: the watcher below only covers the running session,
  // so files that landed (or vanished) while Hush was closed would
  // otherwise stay invisible until some unrelated folder event fired.
  // Safe now that removals sit out a grace window — a folder the
  // provider hasn't fully delivered can't shed files on first sight.
  await reconcileAllLocalDesks(state);
  const { listen } = await import("@tauri-apps/api/event");
  const timers = new Map();
  await listen("desk-changed", (event) => {
    const deskId = event.payload?.id;
    if (!deskId) return;
    clearTimeout(timers.get(deskId));
    timers.set(deskId, setTimeout(() => {
      timers.delete(deskId);
      reconcileDesk(state, deskId).catch((e) => console.warn("desk reconcile failed:", e));
    }, 400));
  });
}
