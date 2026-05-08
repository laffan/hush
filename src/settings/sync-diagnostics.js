/**
 * Settings > Sync — Diagnostics gather. Produces a single text blob the
 * user can copy out of the app (esp. iPad, where there's no console)
 * to inspect what the local sync map / op queue / file tree look like
 * right now, and how recent sync events played out.
 *
 * The blob has six sections:
 *   1. Settings.desks list
 *   2. File tree (ASCII outline; types + ids)
 *   3. synced_files DB rows (relativePath, internalId, remoteId, rev, hash)
 *   4. pending_ops queue
 *   5. Sync trace (in-memory ring populated by sync-trace.js probes)
 *   6. Live Dropbox listing × find_by_remote_id cross-check (when connected)
 */

const SYNC_FOLDER_ID = "__dropbox_sync__";
const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

function shortId(s, n = 8) {
  if (!s || typeof s !== "string") return String(s || "∅");
  return s.length <= n + 2 ? s : s.slice(0, n) + "…";
}

function fmtTreeNode(node, depth) {
  const indent = "  ".repeat(depth);
  const pad = `${node.type}`;
  const id = shortId(node.id, 10);
  const fid = node.fileId ? `  fileId=${shortId(node.fileId, 10)}` : "";
  const flag = node.flagged ? "  ⚑" : "";
  return `${indent}${node.name || "(unnamed)"}  [${pad}]  id=${id}${fid}${flag}`;
}

function dumpTree(tree) {
  const lines = [];
  function walk(nodes, depth) {
    for (const n of nodes || []) {
      lines.push(fmtTreeNode(n, depth));
      if (Array.isArray(n.children) && n.children.length > 0) walk(n.children, depth + 1);
    }
  }
  walk(tree, 0);
  return lines.length ? lines.join("\n") : "(empty)";
}

export async function gatherSyncDiagnostics(settings) {
  const lines = [];
  const ts = new Date().toISOString();
  lines.push(`Hush sync diagnostics  —  ${ts}`);
  lines.push(`Platform: ${navigator.userAgent}`);
  lines.push(`dropboxEnabled=${!!settings?.dropboxEnabled}  syncPath="${settings?.dropboxSyncPath || ""}"`);
  lines.push("");

  // 1. Settings.desks
  lines.push("=== settings.desks ===");
  const desks = settings?.desks || [];
  if (desks.length === 0) lines.push("(none)");
  for (const d of desks) {
    lines.push(`  ${d.name}  id=${d.id}  createdAt=${d.createdAt || "?"}`);
  }
  lines.push(`activeDeskId=${settings?.activeDeskId || "∅"}`);
  lines.push("");

  // 2. File tree (read fresh from disk via Tauri so this works the
  // same in the main window and in the desktop settings WebviewWindow).
  lines.push("=== file tree (from disk) ===");
  let fileTree = [];
  if (IS_TAURI) {
    try { fileTree = await tauriInvoke("get_file_tree") || []; }
    catch (e) { lines.push(`  get_file_tree failed: ${e?.message || e}`); }
  }
  lines.push(dumpTree(fileTree));
  lines.push("");

  if (!IS_TAURI) {
    lines.push("(not running under Tauri — sync DB / ops / Dropbox sections skipped)");
    return lines.join("\n");
  }

  // 3. synced_files
  lines.push("=== synced_files (DB) ===");
  let synced = [];
  try { synced = await tauriInvoke("get_synced_files", { syncFolderId: SYNC_FOLDER_ID }) || []; }
  catch (e) { lines.push(`  get_synced_files failed: ${e?.message || e}`); }
  if (synced.length === 0) lines.push("  (none)");
  for (const f of synced) {
    lines.push(
      `  ${f.relativePath}\n` +
      `      internalId=${shortId(f.internalId, 10)}  remoteId=${shortId(f.remoteId, 16)}\n` +
      `      rev=${shortId(f.lastKnownRev, 14)}  hash=${shortId(f.lastSyncedHash, 10)}  syncedAt=${f.lastSyncedAt}`
    );
  }
  lines.push(`(${synced.length} total)`);
  lines.push("");

  // 4. pending_ops
  lines.push("=== pending_ops (oldest first, top 50) ===");
  let ops = [];
  try { ops = await tauriInvoke("peek_pending_ops", { limit: 50 }) || []; }
  catch (e) { lines.push(`  peek_pending_ops failed: ${e?.message || e}`); }
  if (ops.length === 0) lines.push("  (empty)");
  for (const op of ops) {
    const np = op.newPath ? ` → "${op.newPath}"` : "";
    const err = op.lastError ? `  err="${op.lastError}"` : "";
    lines.push(`  #${op.id}  ${op.kind}  "${op.path}"${np}  attempts=${op.attempts}${err}`);
  }
  lines.push("");

  // 5. Sync trace
  let trace = [];
  try { trace = (await import("../sync/sync-trace.js")).getTrace(); }
  catch (_) {}
  lines.push(`=== sync-trace (last ${trace.length} entries; cleared on app restart) ===`);
  if (trace.length === 0) lines.push("  (empty — no probes have fired this session)");
  for (const t of trace) lines.push(`  ${t}`);
  lines.push("");

  // 6. Live Dropbox listing × DB cross-check
  if (settings?.dropboxAccessToken && settings?.dropboxSyncPath) {
    lines.push("=== Live Dropbox listing × find_by_remote_id ===");
    try {
      const dbx = await import("../sync/dropbox.js");
      if (settings.dropboxAccessToken) {
        dbx.setTokens(settings.dropboxAccessToken, settings.dropboxRefreshToken);
      }
      const base = (settings.dropboxSyncPath || "").replace(/\/+$/, "");
      const root = base === "/" ? "" : base;
      const remote = await dbx.listFolderRecursive(root || "");
      const directories = remote.filter((e) => e.isDirectory).map((e) => e.relativePath).sort();
      const files = remote.filter((e) => !e.isDirectory).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      lines.push(`Directories on Dropbox (${directories.length}):`);
      for (const d of directories) lines.push(`  /${d}`);
      lines.push("");
      lines.push(`Files on Dropbox (${files.length}):`);
      for (const e of files) {
        if (!e.id) { lines.push(`  ⚠ ${e.relativePath}  (no id)`); continue; }
        let hit = null, byPath = null;
        try { hit = await tauriInvoke("find_synced_file_by_remote_id", { remoteId: e.id }); } catch (_) {}
        try { byPath = await tauriInvoke("find_synced_file_by_path", { syncFolderId: SYNC_FOLDER_ID, relativePath: e.relativePath }); } catch (_) {}
        const flag = hit ? "" : (byPath ? "  ← byRemote MISS, byPath HIT" : "  ← BOTH MISS");
        const localPath = hit?.relativePath ? ` localPath="${hit.relativePath}"` : "";
        const drift = hit && hit.relativePath !== e.relativePath ? "  ⚠ DB-PATH-DRIFT" : "";
        lines.push(`  ${e.relativePath}  id=…${e.id.slice(-12)}  rev=${shortId(e.rev, 12)}  byRemote=${hit ? shortId(hit.internalId, 8) : "null"}${localPath}${flag}${drift}`);
      }
    } catch (e) {
      lines.push(`(live listing failed: ${e?.message || e})`);
    }
  }

  return lines.join("\n");
}
