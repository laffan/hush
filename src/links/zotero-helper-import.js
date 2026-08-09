/**
 * "Send to Hush" — handles `hushwriter://zotero-import` deep links fired
 * by the zotero-helper companion app.
 *
 * The payload names Zotero item/attachment keys plus a target desk (and
 * optional project). Import rides the same pipeline as the link-menu's
 * "Download to Hush": a placeholder registers in the target desk's PDFs
 * folder, the background downloader fetches the binary through this
 * app's own Zotero credentials (`download_zotero_pdf`), and — when a
 * project was named — an alias lands in that project's PDFs folder.
 *
 * URL contract (kept in sync with zotero-helper's src/lib/hush.ts):
 *   hushwriter://zotero-import
 *     ?desk=<desk id or name>          optional — active desk when absent
 *     &project=<project id or name>    optional; "__active__" targets the
 *                                      project open in the main window
 *     &nonce=<unique per request>      optional but recommended — dedupes
 *                                      the multiple deliveries deep links
 *                                      get on multi-window/iPad setups
 *     &items=<encodeURIComponent(JSON.stringify([{
 *        itemKey, attKey, title, authors, firstAuthor, year, citekey }]))>
 *
 * Desk resolution is by id first, then case-insensitive name. A desk
 * that doesn't resolve is *waited for* (a local desk's folder can load
 * seconds after a cold launch) and, failing that, the import errors out
 * — importing into whichever desk happened to be active is how PDFs
 * ended up in the wrong desk. Only a request that names no desk at all
 * targets the active desk.
 *
 * Ordering note: every awaited call here is a seam where another window
 * can replace `state.fileTree` (the cross-window "files" reload). All
 * registry writes happen first; the tree is then resolved fresh and
 * mutated in one synchronous pass, so a swap can never strand half the
 * placeholders in a detached tree.
 */

import { findNode, isRealProjectNode, uniqueChildName } from "../state/tree-helpers.js";
import { addPdfAliasToProject, ensureDeskPdfsFolder } from "../state/state-pdf-aliases.js";
import { getActiveDesk } from "../state/state-desks.js";
import { showImportToast } from "../editor/import-toast.js";
import { logActivity } from "../activity-log.js";

/** Same-request dedupe: deep links are delivered more than once (every
 *  open window gets the event, getCurrent() replays on webview reload).
 *  Keyed by the sender's per-request nonce; falls back to the full URL
 *  for senders that predate the nonce. */
const DEDUPE_KEY = "hushwriter-handled-requests";
function alreadyHandled(requestKey) {
  if (!requestKey) return false;
  try {
    const seen = JSON.parse(localStorage.getItem(DEDUPE_KEY) || "[]");
    if (seen.includes(requestKey)) return true;
    localStorage.setItem(
      DEDUPE_KEY,
      JSON.stringify([...seen, requestKey].slice(-40)),
    );
  } catch (_) { /* storage unavailable — proceed unguarded */ }
  return false;
}

export function isHushwriterUrl(url) {
  return typeof url === "string" && url.startsWith("hushwriter://");
}

function parsePayload(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  const action = (u.host || u.pathname.replace(/^\/+/, "")).toLowerCase();
  if (action !== "zotero-import") return { action };
  let items = [];
  try {
    const parsed = JSON.parse(u.searchParams.get("items") || "[]");
    if (Array.isArray(parsed)) items = parsed.filter((i) => i && i.attKey);
  } catch { /* malformed items → empty; reported below */ }
  return {
    action,
    desk: (u.searchParams.get("desk") || "").trim(),
    project: (u.searchParams.get("project") || "").trim(),
    nonce: (u.searchParams.get("nonce") || "").trim(),
    items,
  };
}

/** The desk `deskParam` names, or null. No active-desk fallback here —
 *  the caller decides what an unresolved desk means. */
function resolveNamedDesk(state, deskParam) {
  const desks = (state.fileTree || []).filter((n) => n?.type === "desk");
  const byId = desks.find((d) => d.id === deskParam);
  if (byId) return byId;
  const lower = deskParam.toLowerCase();
  return desks.find((d) => (d.name || "").toLowerCase() === lower) || null;
}

/** Target desk for this request: the named desk when one was given, the
 *  active desk otherwise (null only on a pre-migration flat tree, which
 *  ensureDeskPdfsFolder handles via the legacy root __pdfs__). */
function resolveDesk(state, deskParam) {
  if (deskParam) return resolveNamedDesk(state, deskParam);
  return getActiveDesk(state) || null;
}

function resolveProject(desk, state, projectParam) {
  if (!projectParam) return null;
  // "__active__" — the project currently open in this (main) window, so
  // senders that can't read our data dir (iPadOS) can still target it.
  if (projectParam === "__active__") {
    const id = state.currentProjectId;
    if (!id) return null;
    const node = findNode(desk ? [desk] : state.fileTree || [], id);
    return node && isRealProjectNode(node) ? node : null;
  }
  const roots = desk ? desk.children || [] : state.fileTree || [];
  const lower = projectParam.toLowerCase();
  let byId = null;
  let byName = null;
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (!n) continue;
      if (isRealProjectNode(n)) {
        if (n.id === projectParam) byId = byId || n;
        if ((n.name || "").toLowerCase() === lower) byName = byName || n;
      }
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(roots);
  return byId || byName;
}

/** The deep link can arrive before boot finishes populating the tree. */
async function waitForTree(state, timeoutMs = 6000) {
  const start = Date.now();
  while (!Array.isArray(state.fileTree) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return Array.isArray(state.fileTree);
}

/** Wait for the *named* desk to appear. A local (folder-backed) desk is
 *  routinely missing from the forest just after a cold launch —
 *  `load_forest` skips a desk whose `.hush/tree.json` isn't readable
 *  yet, and the desk-roots lifecycle folds it back in seconds later.
 *  Returns the desk node, or null after the timeout. */
async function waitForNamedDesk(state, deskParam, timeoutMs = 15000) {
  const start = Date.now();
  let desk = resolveNamedDesk(state, deskParam);
  while (!desk && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300));
    desk = resolveNamedDesk(state, deskParam);
  }
  return desk;
}

/** Phase 1 — registry writes, no tree access: mint a fileId + registry
 *  entry per item so the metadata and downloader have something to key
 *  on. Async is fine here; the tree isn't touched. */
async function registerRegistryEntries(items) {
  const { addPdfEntry, removePdfEntry } = await import("../sync/pdf-sync.js");
  const entries = [];
  for (const item of items) {
    const fileId = crypto.randomUUID();
    await addPdfEntry(fileId, {
      title: item.title || "Untitled",
      authors: item.authors || "",
      firstAuthor: item.firstAuthor || "",
      year: item.year || "",
      citekey: item.citekey || "",
      zoteroItemKey: item.itemKey || "",
      zoteroAttKey: item.attKey,
    });
    entries.push({ fileId, item });
  }
  const rollback = async () => {
    for (const { fileId } of entries) {
      try { await removePdfEntry(fileId); } catch (_) { /* best effort */ }
    }
  };
  return { entries, rollback };
}

/** Phase 2 — tree writes, one synchronous pass: resolve the desk and
 *  project fresh from the *current* tree and insert every placeholder
 *  node. No awaits in here, so a cross-window tree reload can't swap
 *  `state.fileTree` between resolution and insertion. Returns the
 *  resolved `{ desk, project }`, or null when a named desk is gone. */
function insertPlaceholderNodes(state, payload, entries) {
  const desk = resolveDesk(state, payload.desk);
  if (payload.desk && !desk) return null;
  const project = resolveProject(desk, state, payload.project);
  const pdfsFolder = ensureDeskPdfsFolder(state.fileTree, desk);
  for (const { fileId, item } of entries) {
    const treeNode = {
      id: crypto.randomUUID(), type: "pdf",
      name: uniqueChildName(pdfsFolder, item.title || "Untitled", "pdf"),
      fileId, children: [], flagged: false, zoteroAttKey: item.attKey,
    };
    pdfsFolder.children.push(treeNode);
    if (project) addPdfAliasToProject(project, treeNode);
  }
  return { desk, project };
}

/** Entry point — called from main.js's deep-link handler for any
 *  hushwriter:// URL. Returns true when the URL was recognized. */
export async function handleHushwriterUrl(state, rawUrl) {
  const payload = parsePayload(rawUrl);
  if (!payload) return false;
  if (payload.action !== "zotero-import") {
    console.warn("Unknown hushwriter:// action:", payload.action);
    return false;
  }
  if (alreadyHandled(payload.nonce || rawUrl)) return true;

  // Surface the (tray-hidden) window so the import is visible.
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    await w.show();
    await w.setFocus();
  } catch { /* headless contexts */ }

  if (!payload.items.length) {
    showImportToast("Send to Hush: no importable items in the request", "error");
    return true;
  }
  if (!state.settings?.zoteroUserId || !state.settings?.zoteroApiKey) {
    showImportToast("Send to Hush needs Zotero set up in Hush's settings first", "error");
    return true;
  }
  if (!(await waitForTree(state))) {
    showImportToast("Send to Hush: app not ready yet — try again", "error");
    return true;
  }
  // A named desk must actually resolve before anything is written. The
  // old behaviour — quietly falling back to the active desk — is how a
  // cold-launch import (local desk folder not re-mounted yet) or a sender
  // holding a renamed desk's old name filed PDFs into the wrong desk.
  if (payload.desk && !(await waitForNamedDesk(state, payload.desk))) {
    logActivity("zotero", "error", "Send to Hush: target desk not found — import refused", {
      desk: payload.desk, items: payload.items.length,
    });
    showImportToast(`Send to Hush: desk “${payload.desk}” not found — nothing imported`, "error");
    return true;
  }

  let where;
  let fileIds;
  try {
    const { entries, rollback } = await registerRegistryEntries(payload.items);
    // Resolve + insert against the tree as it stands *now* (the awaits
    // above may have replaced it). Synchronous, so it can't be swapped
    // out from under the insertion itself.
    const resolved = insertPlaceholderNodes(state, payload, entries);
    if (!resolved) {
      await rollback();
      showImportToast(`Send to Hush: desk “${payload.desk}” disappeared — nothing imported`, "error");
      return true;
    }
    if (payload.project && !resolved.project) {
      showImportToast(`Project “${payload.project}” not found — importing to desk only`, "error");
    }
    fileIds = entries.map((e) => e.fileId);
    where = [
      resolved.desk?.name || "this desk",
      resolved.project ? `→ ${resolved.project.name}` : "",
    ].filter(Boolean).join(" ");
    logActivity("zotero", "info", "Send to Hush import", {
      desk: resolved.desk?.name || null, deskId: resolved.desk?.id || null,
      project: resolved.project?.name || null, items: fileIds.length,
    });
    await state.saveFileTree();
    state.emit("files-changed");
  } catch (e) {
    console.error("Send to Hush import failed:", e);
    showImportToast(`Send to Hush failed: ${e?.message || e}`, "error");
    return true;
  }

  const pdfSync = await import("../sync/pdf-sync.js");
  pdfSync.startBatchDownload(fileIds, state);

  showImportToast(
    `Downloading ${fileIds.length} PDF${fileIds.length === 1 ? "" : "s"} from Zotero into ${where}`,
    "success",
  );
  return true;
}
