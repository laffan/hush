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
 * Desk/project resolution is by id first, then case-insensitive name, so
 * senders that can't read our data dir (e.g. iPadOS sandboxing) can pass
 * plain names. Unknown desk → active desk; unknown project → desk only.
 */

import { findNode, insertNode, isRealProjectNode, uniqueChildName } from "../state/tree-helpers.js";
import { addPdfAliasToProject, ensureDeskPdfsFolder } from "../state/state-pdf-aliases.js";
import { getActiveDesk } from "../state/state-desks.js";
import { showImportToast } from "../editor/import-toast.js";

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

function resolveDesk(state, deskParam) {
  const desks = (state.fileTree || []).filter((n) => n?.type === "desk");
  if (deskParam) {
    const byId = desks.find((d) => d.id === deskParam);
    if (byId) return byId;
    const lower = deskParam.toLowerCase();
    const byName = desks.find((d) => (d.name || "").toLowerCase() === lower);
    if (byName) return byName;
  }
  // Fall back to the active desk; null on a pre-migration flat tree,
  // which ensureDeskPdfsFolder handles (legacy root __pdfs__).
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

/** Register one placeholder PDF node in `desk`'s PDFs folder — the
 *  desk-targeted twin of state.registerPdfPlaceholder (which always
 *  writes to the *active* desk). Pure tree/registry work; the caller
 *  batches saveFileTree + downloads. */
async function registerPlaceholderInDesk(state, desk, item) {
  const { addPdfEntry } = await import("../sync/pdf-sync.js");
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
  const pdfsFolder = ensureDeskPdfsFolder(state.fileTree, desk);
  const finalName = uniqueChildName(pdfsFolder, item.title || "Untitled", "pdf");
  const treeNode = {
    id: crypto.randomUUID(), type: "pdf", name: finalName, fileId,
    children: [], flagged: false, zoteroAttKey: item.attKey,
  };
  insertNode(state.fileTree, treeNode, pdfsFolder.id, findNode);
  return { fileId, treeNode };
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

  const desk = resolveDesk(state, payload.desk);
  const project = resolveProject(desk, state, payload.project);
  if (payload.project && !project) {
    showImportToast(`Project “${payload.project}” not found — importing to desk only`, "error");
  }

  const fileIds = [];
  try {
    for (const item of payload.items) {
      const { fileId, treeNode } = await registerPlaceholderInDesk(state, desk, item);
      fileIds.push(fileId);
      if (project) addPdfAliasToProject(project, treeNode);
    }
    await state.saveFileTree();
    state.emit("files-changed");
  } catch (e) {
    console.error("Send to Hush import failed:", e);
    showImportToast(`Send to Hush failed: ${e?.message || e}`, "error");
    return true;
  }

  const pdfSync = await import("../sync/pdf-sync.js");
  pdfSync.startBatchDownload(fileIds, state);

  const where = [
    desk?.name || "this desk",
    project ? `→ ${project.name}` : "",
  ].filter(Boolean).join(" ");
  showImportToast(
    `Downloading ${fileIds.length} PDF${fileIds.length === 1 ? "" : "s"} from Zotero into ${where}`,
    "success",
  );
  return true;
}
