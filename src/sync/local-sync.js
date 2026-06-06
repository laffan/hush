/**
 * Local Sync — desktop-only direct-filesystem folder mounts.
 *
 * Thin JS wrapper over the Rust `local_sync_*` commands plus helpers for
 * rendering a Local Sync section under the files panel and opening +
 * saving the currently-edited Local Sync file.
 *
 * The currently-open file is tracked on `AppState` via two extra fields:
 *   - `state.currentLocalSync = { folderId, relPath }`
 *   - `state.runtime.localSyncWriteFlag` — guards against watcher-echo reloads
 *     when we just wrote the file ourselves.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

// iOS reaches arbitrary (iCloud) folders through the icloud-folder
// plugin rather than std::fs: the path isn't directly reachable across
// launches, so each mount carries a security-scoped *bookmark* that we
// resolve (re-acquiring access) into a live absolute path. Everything
// else — settings storage, the sidebar, autosave — is shared with
// desktop. `isIOS()` is the single platform fork.
function isIOS() {
  if (typeof navigator === "undefined") return false;
  const p = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(p) || (p === "MacIntel" && (navigator.maxTouchPoints || 0) > 1);
}
const IOS = IS_TAURI && isIOS();

// File extensions surfaced in the tree on iOS — mirrors the
// SUPPORTED_EXTENSIONS list in local_sync.rs so iOS and desktop agree on
// what shows up (the desktop Rust filters server-side; the plugin's
// listDir doesn't, so we filter here).
const SUPPORTED_EXTS = new Set([
  "md", "markdown", "txt",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp",
  "heic", "heif", "avif", "tif", "tiff",
]);
const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp",
  "heic", "heif", "avif", "tif", "tiff",
]);
function extOf(name) {
  const m = (name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}
async function plugin(cmd, args) {
  return invoke(`plugin:icloud-folder|${cmd}`, args);
}

// folderId → resolved absolute base path (access held by the plugin).
const iosBasePaths = new Map();
// In-flight resolutions so concurrent callers share one resolve call.
const iosResolving = new Map();

/** Resolve (and cache) the absolute base path for an iOS mount by
 *  re-acquiring its security-scoped bookmark. Throws if unresolved. */
async function iosBasePath(folderId) {
  if (iosBasePaths.has(folderId)) return iosBasePaths.get(folderId);
  if (iosResolving.has(folderId)) return iosResolving.get(folderId);
  const p = (async () => {
    const folders = await listLocalSyncFolders();
    const folder = folders.find((f) => f.id === folderId);
    if (!folder || !folder.bookmark) {
      throw new Error(`No bookmark for local-sync mount ${folderId}`);
    }
    const res = await plugin("resolve_bookmark", { bookmark: folder.bookmark });
    if (res?.stale) console.warn("local-sync bookmark is stale:", folderId);
    iosBasePaths.set(folderId, res.path);
    return res.path;
  })();
  iosResolving.set(folderId, p);
  try { return await p; }
  finally { iosResolving.delete(folderId); }
}

/** Join an iOS mount's base path with a relative path. */
function joinPath(base, relPath) {
  if (!relPath) return base;
  const b = base.replace(/\/+$/, "");
  const r = String(relPath).replace(/^\/+/, "");
  return `${b}/${r}`;
}

export async function listLocalSyncFolders() {
  if (!IS_TAURI) return [];
  try { return await invoke("local_sync_list"); }
  catch (e) { console.error("local_sync_list failed:", e); return []; }
}

export async function addLocalSyncFolder(deskId = null) {
  if (!IS_TAURI) return null;
  try {
    if (IOS) {
      // iOS: present the folder picker via the plugin, persist the
      // bookmark so the mount survives relaunches.
      const picked = await plugin("pick_folder");
      if (!picked) return null;
      iosBasePaths.set("__pending__", picked.path); // not keyed yet
      const folder = await invoke("local_sync_add", {
        path: picked.path,
        name: picked.name || null,
        deskId,
        bookmark: picked.bookmark,
      });
      iosBasePaths.delete("__pending__");
      if (folder) iosBasePaths.set(folder.id, picked.path); // access already held
      return folder;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false });
    if (!picked) return null;
    return await invoke("local_sync_add", { path: picked, deskId });
  } catch (e) {
    if (String(e).includes("cancelled")) return null;
    console.error("local_sync_add failed:", e);
    return null;
  }
}

export async function removeLocalSyncFolder(id) {
  if (!IS_TAURI) return;
  try {
    if (IOS && iosBasePaths.has(id)) {
      try { await plugin("stop_access", { path: iosBasePaths.get(id) }); } catch (_) {}
      iosBasePaths.delete(id);
    }
    await invoke("local_sync_remove", { id });
  } catch (e) { console.error("local_sync_remove failed:", e); }
}

export async function readDir(id, relPath = "") {
  if (!IS_TAURI) return [];
  try {
    if (IOS) {
      const base = await iosBasePath(id);
      const res = await plugin("list_dir", { path: joinPath(base, relPath) });
      const out = [];
      for (const e of res?.entries || []) {
        const ext = extOf(e.name);
        if (!e.isDir && !SUPPORTED_EXTS.has(ext)) continue;
        const rel = relPath ? `${relPath.replace(/\/+$/, "")}/${e.name}` : e.name;
        out.push({
          name: e.name,
          relPath: rel,
          isDir: !!e.isDir,
          isImage: !e.isDir && IMAGE_EXTS.has(ext),
        });
      }
      out.sort((a, b) =>
        a.isDir === b.isDir
          ? a.name.toLowerCase().localeCompare(b.name.toLowerCase())
          : a.isDir ? -1 : 1);
      return out;
    }
    return await invoke("local_sync_read_dir", { id, relPath });
  } catch (e) { console.error("local_sync_read_dir failed:", e); return []; }
}

export async function readFile(id, relPath) {
  if (!IS_TAURI) return "";
  if (IOS) {
    const base = await iosBasePath(id);
    const res = await plugin("read_file", { path: joinPath(base, relPath) });
    return res?.contents ?? "";
  }
  return invoke("local_sync_read_file", { id, relPath });
}

export async function writeFile(id, relPath, content) {
  if (!IS_TAURI) return;
  if (IOS) {
    const base = await iosBasePath(id);
    return plugin("write_file", { path: joinPath(base, relPath), contents: content });
  }
  return invoke("local_sync_write_file", { id, relPath, content });
}

export async function readFileBytes(id, relPath) {
  if (!IS_TAURI) return null;
  if (IOS) {
    const base = await iosBasePath(id);
    const res = await plugin("read_file_bytes", { path: joinPath(base, relPath) });
    if (!res?.base64) return null;
    // Match the desktop command's shape (an array of byte values) so
    // readSiblingImageDataUrl re-encodes identically on both platforms.
    const bin = atob(res.base64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  return invoke("local_sync_read_file_bytes", { id, relPath });
}

/** Write a binary blob into a Local Sync folder with collision auto-suffix.
 *  Returns the actual relative path written so the caller can build a
 *  matching markdown ref. */
export async function writeFileBytes(id, relPath, bytes, overwrite = false) {
  if (!IS_TAURI) return null;
  if (IOS) {
    const base = await iosBasePath(id);
    const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    const res = await plugin("write_file_bytes", {
      path: joinPath(base, relPath),
      base64: bytesToBase64(arr),
      overwrite,
    });
    // The plugin returns the actual filename written (collision-suffixed
    // unless overwrite); rebuild the relative path against the parent dir.
    const slash = String(relPath).lastIndexOf("/");
    const dir = slash >= 0 ? relPath.slice(0, slash) : "";
    const finalName = res?.name || String(relPath).split("/").pop();
    return dir ? `${dir}/${finalName}` : finalName;
  }
  return invoke("local_sync_write_file_bytes", { id, relPath, bytes, overwrite });
}

/** Strip an iOS mount's absolute base path off `abs`, yielding a
 *  mount-relative path (forward slashes, no leading slash). */
function relFromAbs(base, abs) {
  const b = String(base).replace(/\/+$/, "");
  let rel = String(abs);
  if (rel.startsWith(b)) rel = rel.slice(b.length);
  return rel.replace(/^\/+/, "").replace(/\\/g, "/");
}

/** Create a new text file (doc body or `.hushstack` JSON) inside a mount.
 *  Returns the actual relative path written (collision auto-suffixed). */
export async function createLocalFile(id, relPath, content = "") {
  if (!IS_TAURI) return null;
  if (IOS) {
    const base = await iosBasePath(id);
    const res = await plugin("create_file", { path: joinPath(base, relPath), contents: content });
    return res?.path ? relFromAbs(base, res.path) : relPath;
  }
  return invoke("local_sync_create_file", { id, relPath, content });
}

/** Create a new directory inside a mount. Returns its relative path. */
export async function createLocalDir(id, relPath) {
  if (!IS_TAURI) return null;
  if (IOS) {
    const base = await iosBasePath(id);
    const res = await plugin("create_dir", { path: joinPath(base, relPath) });
    return res?.path ? relFromAbs(base, res.path) : relPath;
  }
  return invoke("local_sync_create_dir", { id, relPath });
}

/** Rename a file/dir in place. `newName` is a bare filename. Returns the
 *  new relative path. */
export async function renameLocalEntry(id, relPath, newName) {
  if (!IS_TAURI) return null;
  if (IOS) {
    const base = await iosBasePath(id);
    const res = await plugin("rename_entry", { path: joinPath(base, relPath), newName });
    return res?.path ? relFromAbs(base, res.path) : relPath;
  }
  return invoke("local_sync_rename", { id, relPath, newName });
}

/** Permanently delete a file or directory (recursive). */
export async function deleteLocalEntry(id, relPath) {
  if (!IS_TAURI) return;
  if (IOS) {
    const base = await iosBasePath(id);
    await plugin("delete_entry", { path: joinPath(base, relPath) });
    return;
  }
  return invoke("local_sync_delete", { id, relPath });
}

/** Move a file/dir into another directory in the same mount (`dstDirRel`
 *  is "" for the mount root). Returns the new relative path. */
export async function moveLocalEntry(id, srcRel, dstDirRel) {
  if (!IS_TAURI) return null;
  if (IOS) {
    const base = await iosBasePath(id);
    const res = await plugin("move_entry", {
      srcPath: joinPath(base, srcRel),
      dstDir: joinPath(base, dstDirRel),
    });
    return res?.path ? relFromAbs(base, res.path) : srcRel;
  }
  return invoke("local_sync_move", { id, srcRel, dstDirRel });
}

/** Duplicate a file/dir (same parent, "-Copy" suffix). Returns new rel. */
export async function copyLocalEntry(id, relPath) {
  if (!IS_TAURI) return null;
  if (IOS) {
    const base = await iosBasePath(id);
    const res = await plugin("copy_entry", { path: joinPath(base, relPath) });
    return res?.path ? relFromAbs(base, res.path) : relPath;
  }
  return invoke("local_sync_copy", { id, relPath });
}

/** MIME type for an image filename's extension. */
function mimeForFilename(name) {
  const m = (name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return "application/octet-stream";
  switch (m[1]) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "bmp": return "image/bmp";
    case "heic": return "image/heic";
    case "heif": return "image/heif";
    case "avif": return "image/avif";
    case "tif": case "tiff": return "image/tiff";
    default: return "application/octet-stream";
  }
}

function bytesToBase64(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Read a sibling image and return a data URL. `baseDir` is the dirname
 *  of the .md that owns the ref ("" for files at the mount root). */
export async function readSiblingImageDataUrl(folderId, baseDir, filename) {
  if (!IS_TAURI || !folderId || !filename) return null;
  const relPath = baseDir ? `${baseDir}/${filename}` : filename;
  try {
    const bytes = await readFileBytes(folderId, relPath);
    if (!bytes) return null;
    const mime = mimeForFilename(filename);
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
  } catch (e) {
    return null;
  }
}

/** Classify a Local Sync filename by extension into the surface that
 *  should open it. */
export function localKindForName(name) {
  const ext = extOf(name);
  if (ext === "hushnote") return "notebook";
  if (ext === "hushstack") return "stack";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "doc";
}

/** Sentinel fileId used to thread a Local Sync notebook / stack through
 *  the existing fileId-keyed notebook / stack bridges. The bridges parse
 *  the `ls:` prefix to load / save from disk instead of the VC store. */
export function localSentinelId(folderId, relPath) {
  return `ls:${folderId}:${relPath}`;
}

/** Parse a sentinel id back into `{ folderId, relPath }`, or null. */
export function parseLocalSentinel(fileId) {
  const m = typeof fileId === "string" && fileId.match(/^ls:([^:]+):(.*)$/);
  return m ? { folderId: m[1], relPath: m[2] } : null;
}

/** Tear down whatever surface is currently active before opening a new
 *  Local Sync entry. Mirrors the teardown in openNotebook / openStack. */
async function teardownForLocalOpen(state) {
  if (state.dirty) await state.saveCurrentFile();
  if (state.currentNotebookFileId) {
    state.emit("notebook-unmount");
    state.currentNotebookFileId = null;
  }
  if (state.currentPdfFileId) {
    state.emit("pdf-unmount");
    state.currentPdfFileId = null;
  }
  if (state.currentStackFileId) {
    state.emit("stack-unmount");
    state.currentStackFileId = null;
  }
  state.currentFileId = null;
  state.currentProjectId = null;
  state.projectDocIds = [];
}

/** Open any Local Sync entry on the right surface (doc editor, notebook
 *  canvas, stack, or image preview) based on its extension. */
export async function openLocalEntry(state, folderId, relPath, name) {
  const kind = localKindForName(name || relPath);
  if (kind === "notebook") return openLocalNotebook(state, folderId, relPath);
  if (kind === "stack") return openLocalStack(state, folderId, relPath);
  return openLocalSyncFile(state, folderId, relPath);
}

/** Open a Local Sync `.hushnote` on the notebook canvas. Routes through
 *  the existing notebook bridge via an `ls:` sentinel fileId. */
export async function openLocalNotebook(state, folderId, relPath) {
  if (state.ratchetMode) return;
  await teardownForLocalOpen(state);
  const sentinel = localSentinelId(folderId, relPath);
  state.currentNotebookFileId = sentinel;
  state.currentLocalSync = { folderId, relPath, kind: "notebook" };
  state.emit("notebook-open", sentinel);
}

/** Open a Local Sync `.hushstack` on the stack surface. */
export async function openLocalStack(state, folderId, relPath) {
  if (state.ratchetMode) return;
  await teardownForLocalOpen(state);
  const sentinel = localSentinelId(folderId, relPath);
  state.currentStackFileId = sentinel;
  state.currentLocalSync = { folderId, relPath, kind: "stack" };
  state.emit("stack-open", sentinel);
}

/** Open a Local Sync file into the main editor. */
export async function openLocalSyncFile(state, folderId, relPath) {
  if (state.dirty) await state.saveCurrentFile();
  if (state.currentNotebookFileId) {
    state.emit("notebook-unmount");
    state.currentNotebookFileId = null;
  }
  if (state.currentStackFileId) {
    state.emit("stack-unmount");
    state.currentStackFileId = null;
  }
  state.currentFileId = null;
  state.currentProjectId = null;
  state.projectDocIds = [];
  state.currentLocalSync = { folderId, relPath, kind: "doc" };
  try {
    const content = await readFile(folderId, relPath);
    // setContent dispatches a doc change, which the editor's
    // updateListener treats as an edit and marks the buffer dirty.
    // Loading a file is not a user edit — clear the flag on the same
    // tick so the next autosave doesn't write the just-loaded content
    // straight back (bumping the file's mtime with no real change and
    // clobbering a concurrent edit from another device). Mirrors every
    // other reload path (sync-state, conflict-handler, the watcher
    // reload below).
    if (state.editor) { state.editor.setContent(content); state.dirty = false; }
  } catch (e) {
    console.error("Failed to load local-sync file:", e);
    if (state.editor) { state.editor.setContent(""); state.dirty = false; }
  }
  state.emit("file-opened");
}

/** Save the currently-open Local Sync doc (called from the autosave hook). */
export async function saveCurrentLocalSync(state) {
  if (!state.currentLocalSync || !state.editor) return;
  // Notebook / stack Local Sync surfaces autosave through their own
  // bridges (keyed off the `ls:` sentinel id); only docs write the
  // editor buffer back here.
  if (state.currentLocalSync.kind && state.currentLocalSync.kind !== "doc") return;
  const { folderId, relPath } = state.currentLocalSync;
  const content = state.editor.getContent();
  state.runtime.localSyncWriteFlag = Date.now();
  state.dirty = false;
  try { await writeFile(folderId, relPath, content); }
  catch (e) { console.error("Local Sync save failed:", e); }
}

/** Reveal a Local Sync mount on disk. macOS: Finder via the opener
 *  plugin. iOS: the Files app via the icloud-folder plugin's
 *  shareddocuments:// route (opener.revealItemInDir is a no-op on iOS).
 *  `folderId` is needed on iOS to resolve the bookmark to a live path. */
export async function revealLocalSyncFolder(folderId, path, relPath = "") {
  if (!IS_TAURI || !path) return;
  if (IOS) {
    try {
      const base = folderId ? await iosBasePath(folderId) : path;
      await plugin("reveal_in_files", { path: relPath ? joinPath(base, relPath) : base });
    } catch (e) {
      console.error("reveal_in_files failed:", e);
    }
    return;
  }
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    const target = relPath ? `${path.replace(/\/+$/, "")}/${relPath}` : path;
    await opener.revealItemInDir(target);
  } catch (e) {
    console.error("revealItemInDir failed:", e);
  }
}

/** Re-read the open Local Sync file from disk if it changed underneath
 *  us. iOS has no filesystem watcher (the notify crate is macOS-only),
 *  so this is wired to the app-foreground (visibilitychange) event as
 *  the iPad stand-in for the desktop watcher: when you switch back to
 *  Hush, a file edited on another device shows its latest content.
 *
 *  Conservative by design — it bails when the buffer is dirty so an
 *  in-progress edit is never clobbered by a stale-looking reload, and
 *  skips when the on-disk content already matches the editor. */
export async function refreshOpenLocalSyncFile(state) {
  if (!IS_TAURI || !state.currentLocalSync || !state.editor) return;
  if (state.currentLocalSync.kind && state.currentLocalSync.kind !== "doc") return;
  if (state.dirty) return; // never overwrite unsaved edits
  const { folderId, relPath } = state.currentLocalSync;
  try {
    const content = await readFile(folderId, relPath);
    // Still on the same file, still clean, and the disk actually differs.
    if (!state.currentLocalSync || state.currentLocalSync.relPath !== relPath) return;
    if (state.dirty) return;
    if (state.editor.getContent() === content) return;
    state.editor.setContent(content);
    state.dirty = false;
  } catch (e) {
    console.error("Local Sync foreground refresh failed:", e);
  }
}

/** Listen for watcher events. Reloads the open file on external change,
 *  and refreshes the sidebar on any structural change. */
export async function startLocalSyncWatcher(state, onChanged) {
  if (!IS_TAURI) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen("local-sync-changed", (event) => {
    const { id, paths } = event.payload || {};
    // Ignore events that echo our own write (within 500ms of last write)
    if (state.runtime.localSyncWriteFlag && Date.now() - state.runtime.localSyncWriteFlag < 500) {
      return;
    }
    // If the currently-open local-sync *doc* changed on disk, reload it.
    // Notebook / stack surfaces own their disk state via their bridges.
    if (state.currentLocalSync && state.currentLocalSync.folderId === id
        && (!state.currentLocalSync.kind || state.currentLocalSync.kind === "doc")) {
      const editedPath = state.currentLocalSync.relPath;
      // Match by suffix-with-separator, not bare endsWith — `a/foo.md`
      // shouldn't match `b/a/foo.md`'s ancestor walk.
      const matches = Array.isArray(paths) && paths.some(p => {
        if (p === editedPath) return true;
        return p.endsWith("/" + editedPath) || p.endsWith("\\" + editedPath);
      });
      if (matches) {
        readFile(id, editedPath).then((content) => {
          if (!state.editor || !state.currentLocalSync || state.currentLocalSync.relPath !== editedPath) return;
          // Skip identical-content events. notify can emit duplicate events
          // (e.g. metadata-only changes, atomic-write races) and reapplying
          // identical content would jump the cursor without any user-visible
          // benefit.
          if (state.editor.getContent() === content) return;
          // Local-sync paths don't have a Hush fileId; use a synthetic
          // lock key. _isPullLockedForCurrent matches it against
          // state.currentLocalSync so saves are correctly blocked.
          state.acquirePullLock(`localsync:${id}:${editedPath}`);
          try { state.editor.setContent(content); state.dirty = false; }
          finally { state.releasePullLock(); }
        }).catch(() => {});
      }
    }
    onChanged && onChanged(id);
  });
}
