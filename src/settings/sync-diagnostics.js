/**
 * Snapshot the local sync state into a plain-text report. Temporary
 * debug surface — bug-hunt for the iPad-first-sync duplication where
 * we suspect either (a) downloads aren't registering with full
 * `remote_id`/`rev` (so the cursor seed re-imports them) or (b)
 * `.hush/desks.json` lands mid-seed and reshapes the tree under a
 * different parent path. Both cases show up here as either a
 * `remote_id` group with >1 row, a `relative_path` group with >1 row,
 * or two tree nodes pointing at the same `fileId`.
 *
 * Pulled out of `settings-sync-tab.js` to keep that file under the
 * 700-line cap. Strip once the cause is identified.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
const SYNC_FOLDER_ID = "__dropbox_sync__";

export async function gatherSyncDiagnostics() {
  if (!IS_TAURI) return "Diagnostics only available in the Tauri app.";
  const { invoke } = await import("@tauri-apps/api/core");
  const lines = [];

  const settings = await invoke("get_settings").catch(() => ({}));
  lines.push("=== HUSH SYNC DIAGNOSTICS ===");
  lines.push(`Time: ${new Date().toISOString()}`);
  lines.push(`Sync folder: ${settings?.dropboxSyncPath || "(none)"}`);
  lines.push(`Sync enabled: ${!!settings?.dropboxEnabled}`);

  let cursor = null;
  try { cursor = await invoke("get_dropbox_cursor", { syncFolderId: SYNC_FOLDER_ID }); } catch (_) {}
  if (cursor) {
    const c = cursor.cursor || "";
    lines.push(`Cursor present: ${c.length} chars (head=${c.slice(0, 24)}…)`);
    lines.push(`Cursor root: ${cursor.rootPath || "(empty)"}`);
  } else {
    lines.push("Cursor present: NO (next poll will seed)");
  }

  let files = [];
  try { files = await invoke("get_synced_files", { syncFolderId: SYNC_FOLDER_ID }) || []; } catch (_) {}
  lines.push("");
  lines.push(`=== synced_files (${files.length} rows) ===`);
  lines.push("internal_id  remote_id              rev          relative_path");
  for (const f of files) {
    const iid = (f.internalId || "").slice(0, 12);
    const rid = (f.remoteId || "").slice(0, 22) || "(empty)";
    const rev = (f.lastKnownRev || "").slice(0, 12) || "(empty)";
    lines.push(`${iid.padEnd(12)} ${rid.padEnd(22)} ${rev.padEnd(12)} ${f.relativePath || ""}`);
  }

  const byRemote = new Map();
  for (const f of files) {
    const k = f.remoteId || "(empty)";
    if (!byRemote.has(k)) byRemote.set(k, []);
    byRemote.get(k).push(f);
  }
  const dupRemote = [...byRemote.entries()].filter(([k, arr]) => k !== "(empty)" && arr.length > 1);
  const emptyRemoteCount = (byRemote.get("(empty)") || []).length;
  lines.push("");
  lines.push(`=== Duplicates by remote_id (${dupRemote.length} groups; ${emptyRemoteCount} rows have empty remote_id) ===`);
  if (dupRemote.length === 0) lines.push("(none)");
  for (const [rid, arr] of dupRemote) {
    lines.push(`  ${rid} → ${arr.length} rows:`);
    for (const f of arr) lines.push(`    internal=${(f.internalId || "").slice(0, 12)} path=${f.relativePath || ""}`);
  }

  const byPath = new Map();
  for (const f of files) {
    const k = (f.relativePath || "").toLowerCase();
    if (!byPath.has(k)) byPath.set(k, []);
    byPath.get(k).push(f);
  }
  const dupPath = [...byPath.entries()].filter(([_, arr]) => arr.length > 1);
  lines.push("");
  lines.push(`=== Duplicates by relative_path (${dupPath.length} groups) ===`);
  if (dupPath.length === 0) lines.push("(none)");
  for (const [p, arr] of dupPath) {
    lines.push(`  ${p} → ${arr.length} rows:`);
    for (const f of arr) lines.push(`    internal=${(f.internalId || "").slice(0, 12)} remote=${(f.remoteId || "").slice(0, 22)}`);
  }

  let tree = [];
  try { tree = await invoke("get_file_tree") || []; } catch (_) {}
  lines.push("");
  lines.push("=== Tree (files / folders / desks; first 200 lines) ===");
  const treeLines = [];
  function walk(nodes, depth) {
    for (const n of nodes || []) {
      const indent = "  ".repeat(depth);
      const tag = n.type || "?";
      const fid = n.fileId ? ` fileId=${n.fileId.slice(0, 12)}` : "";
      const id = ` id=${(n.id || "").slice(0, 12)}`;
      treeLines.push(`${indent}- [${tag}] ${n.name || "(unnamed)"}${id}${fid}`);
      if (Array.isArray(n.children)) walk(n.children, depth + 1);
    }
  }
  walk(tree, 0);
  for (const ln of treeLines.slice(0, 200)) lines.push(ln);
  if (treeLines.length > 200) lines.push(`(... ${treeLines.length - 200} more lines truncated)`);

  const fileIdNodes = new Map();
  function collectFileIds(nodes, path) {
    for (const n of nodes || []) {
      const here = path ? `${path}/${n.name}` : n.name;
      if (n.fileId) {
        if (!fileIdNodes.has(n.fileId)) fileIdNodes.set(n.fileId, []);
        fileIdNodes.get(n.fileId).push({ path: here, type: n.type, nodeId: n.id });
      }
      if (Array.isArray(n.children)) collectFileIds(n.children, here);
    }
  }
  collectFileIds(tree, "");
  const dupFileId = [...fileIdNodes.entries()].filter(([_, arr]) => arr.length > 1);
  lines.push("");
  lines.push(`=== Duplicates by tree fileId (${dupFileId.length} groups) ===`);
  if (dupFileId.length === 0) lines.push("(none)");
  for (const [fid, arr] of dupFileId) {
    lines.push(`  fileId=${fid.slice(0, 12)} → ${arr.length} nodes:`);
    for (const x of arr) lines.push(`    ${x.type} @ ${x.path} (node=${x.nodeId.slice(0, 12)})`);
  }

  const syncedFileIds = new Set(files.map(f => f.internalId));
  const orphanNodes = [...fileIdNodes.entries()].filter(([fid, _]) => !syncedFileIds.has(fid));
  lines.push("");
  lines.push(`=== Tree nodes with no synced_files row (${orphanNodes.length}) ===`);
  if (orphanNodes.length === 0) lines.push("(none)");
  for (const [fid, arr] of orphanNodes) {
    for (const x of arr) lines.push(`  ${x.type} @ ${x.path} (fileId=${fid.slice(0, 12)})`);
  }

  let ops = [];
  try { ops = await invoke("peek_pending_ops", { limit: 50 }) || []; } catch (_) {}
  lines.push("");
  lines.push(`=== pending_ops (${ops.length} rows; up to 50 shown) ===`);
  for (const op of ops) {
    const internal = op.internalId || "";
    const newPath = op.newPath || "";
    const attempts = op.attempts ?? 0;
    const lastErr = op.lastError || "";
    lines.push(`  #${op.id} ${op.kind.padEnd(14)} internal=${internal.slice(0, 12).padEnd(12)} ${op.path}${newPath ? ` → ${newPath}` : ""}${attempts ? ` attempts=${attempts}` : ""}${lastErr ? ` err=${lastErr}` : ""}`);
  }

  const syncLog = settings?.dropboxSyncLog || [];
  lines.push("");
  lines.push(`=== Recent sync log (last 20 of ${syncLog.length}) ===`);
  for (const entry of syncLog.slice(-20)) lines.push(`  ${entry}`);

  let trace = [];
  try {
    const m = await import("../sync/sync-trace.js");
    trace = m.getTrace();
  } catch (_) {}
  lines.push("");
  lines.push(`=== Sync trace (last ${trace.length} entries; live since app start) ===`);
  if (trace.length === 0) lines.push("(empty)");
  for (const t of trace) lines.push(`  ${t}`);

  if (settings?.dropboxAccessToken && settings?.dropboxSyncPath) {
    lines.push("");
    lines.push("=== Live Dropbox listing × find_by_remote_id ===");
    try {
      const dbx = await import("../sync/dropbox.js");
      if (settings.dropboxAccessToken) {
        dbx.setTokens(settings.dropboxAccessToken, settings.dropboxRefreshToken);
      }
      const base = (settings.dropboxSyncPath || "").replace(/\/+$/, "");
      const root = base === "/" ? "" : base;
      const remote = await dbx.listFolderRecursive(root || "");
      lines.push(`(${remote.length} entries)`);
      for (const e of remote) {
        if (e.isDirectory) continue;
        if (!e.id) { lines.push(`  ⚠ ${e.relativePath} has no Dropbox id`); continue; }
        const hit = await invoke("find_synced_file_by_remote_id", { remoteId: e.id }).catch(() => null);
        const byPath = await invoke("find_synced_file_by_path", { syncFolderId: SYNC_FOLDER_ID, relativePath: e.relativePath }).catch(() => null);
        const flag = hit ? "" : (byPath ? "  ← byRemote MISS, byPath HIT" : "  ← BOTH MISS");
        lines.push(`  ${e.relativePath}  id=${e.id.slice(-12)}  rev=${(e.rev || "").slice(0, 12)}  → byRemote=${hit?.internalId?.slice(0, 8) || "null"} byPath=${byPath?.internalId?.slice(0, 8) || "null"}${flag}`);
      }
    } catch (e) {
      lines.push(`(live listing failed: ${e?.message || e})`);
    }
  }

  return lines.join("\n");
}
