/**
 * Initial-sync flows — preview + bulk push/pull when the user first
 * connects Dropbox. Once `performInitialSync` has run, ongoing sync
 * goes through the cursor delta + op-log paths in sync-state.js /
 * sync-polling.js / op-log.js. Extracted from sync-state.js to keep
 * that file under the line-limit cap.
 *
 * **Desk handling.** Every top-level folder under the sync root is a
 * desk (per the `.hushdesk` model). On first sync, we pre-create
 * matching desk nodes locally for every top-level folder Dropbox has
 * so that the recursive insert below routes content into the right
 * desk. After the download loop, `finalizeDesks` populates
 * `settings.desks` and picks an active desk; on the receiving side
 * `.hushdesk` files arrive via the cursor seed (after this returns)
 * and reassign temp desk ids to their canonical ones.
 */

import { uploadImage, downloadImage, insertImageIntoTree } from "./sync-images.js";
import { findNodeByFileId } from "../state/tree-helpers.js";
import { buildSyncManifest } from "./sync-state.js";
import { insertDocumentNode, ensureSeedDeskSpecials } from "./sync-tree-insert.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
const SYNC_FOLDER_ID = "__dropbox_sync__";

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

function isNotebookPath(p) { return p.endsWith(".hushnote"); }
function isPdfPath(p) { return p.endsWith(".pdf"); }

async function uploadContent(dbx, fullPath, content, relativePath) {
  if (isPdfPath(relativePath)) {
    const bytes = typeof content === "string" ? null : content;
    if (bytes) return dbx.uploadBinary(fullPath, bytes);
    return;
  }
  if (isNotebookPath(relativePath)) {
    const { packNotebook } = await import("./notebook-sync.js");
    const zipData = await packNotebook(content);
    return dbx.uploadBinary(fullPath, zipData);
  }
  return dbx.uploadFile(fullPath, content);
}

async function downloadContent(dbx, dropboxPath, relativePath) {
  if (isPdfPath(relativePath)) {
    return dbx.downloadBinary(dropboxPath);
  }
  if (isNotebookPath(relativePath)) {
    const { unpackNotebook } = await import("./notebook-sync.js");
    const zipData = await dbx.downloadBinary(dropboxPath);
    return unpackNotebook(zipData);
  }
  return dbx.downloadFile(dropboxPath);
}

function serverModifiedSecs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/**
 * Generate a sync preview: what will be uploaded and what will be
 * downloaded. Used by the inline preview panel; the modal flow uses
 * `generateClearLocalPreview` from `sync-state.js` instead (richer
 * per-desk breakdown).
 */
export async function generateSyncPreview(state, dropboxPath) {
  if (!IS_TAURI) return { toUpload: [], toDownload: [], unchanged: 0 };

  const dbx = await import("./dropbox.js");
  const manifest = buildSyncManifest(state.fileTree);

  let remoteEntries = [];
  try {
    remoteEntries = await dbx.listFolderRecursive(dropboxPath === "/" ? "" : dropboxPath);
  } catch (e) {
    if (!String(e).includes("not_found")) throw e;
  }

  const remotePaths = new Set(remoteEntries.filter(e => !e.isDirectory).map(e => e.relativePath));
  const localPaths = new Set(manifest.files.map(f => f.relativePath));

  const toUpload = manifest.files
    .filter(f => !remotePaths.has(f.relativePath))
    .map(f => ({ relativePath: f.relativePath, type: f.type }));

  const toDownload = remoteEntries
    .filter(e => !e.isDirectory && !localPaths.has(e.relativePath) && e.tag !== "hushproject")
    .map(e => ({ relativePath: e.relativePath, tag: e.tag || "md" }));

  const unchanged = manifest.files.filter(f => remotePaths.has(f.relativePath)).length;

  return { toUpload, toDownload, unchanged };
}

/** Pre-create a desk node for every top-level Dropbox folder that
 *  doesn't already exist as a desk locally. With the default seed
 *  this means: existing "Personal" desk stays, plus any extra
 *  top-level folders on Dropbox become new desks. Without this step
 *  the recursive insert would create plain folders that the sidebar
 *  doesn't render (it only shows the active desk's children). */
function ensureDeskSkeletonsForDropbox(state, remoteEntries) {
  const tree = state.fileTree || [];
  const topLevelFolders = new Set();
  for (const e of remoteEntries) {
    if (!e.isDirectory) continue;
    const parts = (e.relativePath || "").split("/");
    if (parts.length !== 1) continue;
    const name = parts[0];
    if (!name || name.startsWith(".")) continue;
    topLevelFolders.add(name);
  }
  let created = 0;
  for (const name of topLevelFolders) {
    const existsAsDesk = tree.some((n) => n.type === "desk" && n.name === name);
    if (existsAsDesk) continue;
    // If a non-desk node with the same name exists at root (rare —
    // could happen from a prior aborted sync), promote it.
    const existingFolder = tree.find((n) => n.name === name && n.type === "folder");
    if (existingFolder) {
      existingFolder.type = "desk";
      if (!existingFolder.createdAt) existingFolder.createdAt = Math.floor(Date.now() / 1000);
      if (!Array.isArray(existingFolder.children)) existingFolder.children = [];
      ensureSeedDeskSpecials(existingFolder, existingFolder.id);
      created++;
      continue;
    }
    const desk = {
      id: crypto.randomUUID(), type: "desk", name,
      children: [], flagged: false,
      createdAt: Math.floor(Date.now() / 1000),
    };
    ensureSeedDeskSpecials(desk, desk.id);
    tree.push(desk);
    created++;
  }
  return created;
}

/**
 * Perform initial full sync — push local to Dropbox, pull new Dropbox
 * files. Returns `{ uploaded: string[], downloaded: string[], desksCreated }`.
 *
 * The cursor seed runs immediately after this returns; for that to
 * recognize our just-uploaded / just-downloaded entries (and skip them
 * via echo suppression instead of re-creating duplicates), we register
 * every file with `register_synced_file_full` carrying the Dropbox
 * `id` + `rev`.
 *
 * Progress is emitted via `sync-polling.js#progressBegin/Phase/_emitProgress/End`
 * so the modal's progress bar driver can listen to `clear-reseed-progress`.
 */
export async function performInitialSync(state, dropboxPath) {
  if (!IS_TAURI) return { uploaded: [], downloaded: [], desksCreated: 0 };
  const dbx = await import("./dropbox.js");
  const sp = await import("./sync-polling.js");

  const basePath = dropboxPath === "/" ? "" : dropboxPath;
  const uploaded = [];
  const downloaded = [];

  if (basePath) await dbx.createFolder(basePath).catch(() => {});

  sp.progressBegin(state, 0, "Scanning Dropbox…");

  // List Dropbox first so the upload phase can detect collisions and
  // suffix the local name; the recursive entries also drive the
  // desk-skeleton step below.
  let remoteEntries = [];
  try { remoteEntries = await dbx.listFolderRecursive(basePath || ""); } catch (_) {}
  const remoteByPath = new Map();
  for (const e of remoteEntries) {
    if (!e.isDirectory && e.relativePath) remoteByPath.set(e.relativePath, e);
  }

  // Promote / create desk nodes BEFORE buildSyncManifest reads the
  // tree, so any local content already under a folder that's actually
  // a desk on Dropbox uploads under the right desk path.
  const desksCreated = ensureDeskSkeletonsForDropbox(state, remoteEntries);
  const manifest = buildSyncManifest(state.fileTree);

  for (const dir of manifest.directories) {
    const fullDir = basePath ? `${basePath}/${dir}` : `/${dir}`;
    await dbx.createFolder(fullDir).catch(() => {});
  }

  // Determinate progress for the rest of the run: uploads + downloads.
  const downloadCandidates = remoteEntries.filter((e) =>
    !e.isDirectory && e.tag !== "hushproject"
  ).length;
  const uploadCandidates = manifest.files.length;
  const totalSteps = uploadCandidates + downloadCandidates;
  sp.progressBegin(state, totalSteps, totalSteps > 0
    ? `Syncing ${totalSteps} item${totalSteps === 1 ? "" : "s"}…`
    : "No items to sync.");

  // Upload local files. If a remote entry already lives at the same
  // path, suffix the local name so we don't overwrite Dropbox's copy.
  await uploadLocalFiles(state, dbx, manifest, basePath, remoteByPath, uploaded, sp);

  // Pull remotes that aren't in our manifest. Register with full
  // payload so the cursor seed echo-suppresses these on its first pass.
  const manifestPaths = new Set(manifest.files.map(f => f.relativePath));
  await downloadRemoteFiles(state, dbx, remoteEntries, basePath, manifestPaths, downloaded, sp);

  // Now that the tree has desks + content, populate the desks
  // registry and pick an active desk. Without this the sidebar's
  // desk switcher would show empty even though the tree has desks.
  try {
    const { finalizeDesks } = await import("./desk-sync.js");
    await finalizeDesks(state);
  } catch (e) { console.warn("initial sync: finalizeDesks failed:", e); }

  // Push the local Google Doc link map (if any) AND fetch the remote
  // one. The local push translates local fileId → remoteId so other
  // devices can resolve back to their own ids; the remote fetch
  // applies any links other devices already published for files that
  // just landed here.
  try {
    const gdocs = await import("./gdocs-sync.js");
    await gdocs.pushGoogleLinksToDropbox(state);
    try {
      const remoteGdocs = await dbx.downloadFile(`${basePath}/.hush/gdocs.json`);
      if (remoteGdocs) await gdocs.applyGoogleLinks(state, remoteGdocs);
    } catch (_) { /* not present yet */ }
  } catch (e) { console.warn("initial sync: gdocs sync failed:", e); }

  await state.saveFileTree();
  state.files = await tauriInvoke("list_files");
  state.emit("desks-changed");
  state.emit("files-changed");

  sp.progressEnd(state, "Initial sync complete.");
  return { uploaded, downloaded, desksCreated };
}

async function uploadLocalFiles(state, dbx, manifest, basePath, remoteByPath, uploaded, sp) {
  for (const file of manifest.files) {
    if (file.type === "image" && file.fileId) {
      const fullPath = basePath ? `${basePath}/${file.relativePath}` : `/${file.relativePath}`;
      try {
        await uploadImage(dbx, fullPath, file.fileId);
        uploaded.push(file.relativePath);
        await tauriInvoke("register_synced_image", {
          filename: file.fileId, syncFolderId: SYNC_FOLDER_ID,
          relativePath: file.relativePath,
        });
      } catch (e) { console.error(`Image upload failed for ${file.relativePath}:`, e); }
      sp.progressTick(state);
      continue;
    }
    let content = file.content || "";
    if ((file.type === "md" || file.type === "hushnote") && file.fileId) {
      try {
        const fileData = await tauriInvoke("load_file", { id: file.fileId });
        content = fileData.content || "";
      } catch (_) { sp.progressTick(state); continue; }
    }
    let path = file.relativePath;
    if (remoteByPath.has(path)) {
      path = uniqueRemotePath(path, remoteByPath);
      if (file.fileId) {
        const baseName = path.split("/").pop().replace(/\.(md|hushnote)$/, "");
        const node = findNodeByFileId(state.fileTree, file.fileId);
        if (node) node.name = baseName;
        try { await tauriInvoke("rename_file", { id: file.fileId, name: baseName }); } catch (_) {}
      }
    }
    const fullPath = basePath ? `${basePath}/${path}` : `/${path}`;
    try {
      const resp = await uploadContent(dbx, fullPath, content, path);
      uploaded.push(path);
      if (file.fileId) {
        await tauriInvoke("register_synced_file_full", {
          internalId: file.fileId, syncFolderId: SYNC_FOLDER_ID,
          relativePath: path, content,
          remoteId: resp?.id || "",
          rev: resp?.rev || "",
          syncedAt: serverModifiedSecs(resp?.server_modified) || Math.floor(Date.now() / 1000),
        });
      }
      remoteByPath.set(path, { relativePath: path });
    } catch (e) { console.error(`Upload failed for ${path}:`, e); }
    sp.progressTick(state);
  }
}

async function downloadRemoteFiles(state, dbx, remoteEntries, basePath, manifestPaths, downloaded, sp) {
  for (const entry of remoteEntries) {
    if (entry.isDirectory || !entry.dropboxPath) continue;
    if (entry.tag === "hushproject") continue;
    if (manifestPaths.has(entry.relativePath)) { sp.progressTick(state); continue; }

    if (entry.tag === "image") {
      try {
        const finalName = await downloadImage(dbx, entry.dropboxPath, entry.name);
        await tauriInvoke("register_synced_image", {
          filename: finalName, syncFolderId: SYNC_FOLDER_ID,
          relativePath: entry.relativePath,
        });
        const parts = entry.relativePath.split("/");
        let preferDeskId = null;
        if (parts.length >= 2) {
          const deskNode = (state.fileTree || []).find(
            (n) => n.type === "desk" && n.name === parts[0]
          );
          if (deskNode) preferDeskId = deskNode.id;
        }
        insertImageIntoTree(state.fileTree, finalName, preferDeskId);
        downloaded.push(entry.relativePath);
      } catch (e) { console.error(`Image download failed for ${entry.relativePath}:`, e); }
      sp.progressTick(state);
      continue;
    }

    try {
      const content = await downloadContent(dbx, entry.dropboxPath, entry.relativePath);
      const file = await tauriInvoke("create_file");
      await tauriInvoke("save_file", { id: file.id, content });
      await tauriInvoke("register_synced_file_full", {
        internalId: file.id, syncFolderId: SYNC_FOLDER_ID,
        relativePath: entry.relativePath, content,
        remoteId: entry.id || "",
        rev: entry.rev || "",
        syncedAt: serverModifiedSecs(entry.modified) || Math.floor(Date.now() / 1000),
      });
      // Use the desk-aware insertion helper from sync-tree-insert.js so
      // top-level path segments become desk nodes (not plain folders),
      // matching what the cursor consumer does for `Created` events.
      const isNotebook = entry.relativePath.endsWith(".hushnote");
      insertDocumentNode(state, entry.relativePath, file.id, isNotebook, entry.name);
      downloaded.push(entry.relativePath);
    } catch (e) { console.error(`Download failed for ${entry.relativePath}:`, e); }
    sp.progressTick(state);
  }
}

/** Pick a "Foo (2).md"-style suffix that doesn't collide with anything
 *  in `remoteByPath`. Increments the integer until free. */
function uniqueRemotePath(relativePath, remoteByPath) {
  const m = relativePath.match(/^(.*?)(\.(?:md|hushnote))$/);
  const stem = m ? m[1] : relativePath;
  const ext = m ? m[2] : "";
  for (let i = 2; i < 100; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!remoteByPath.has(candidate)) return candidate;
  }
  return relativePath;
}
