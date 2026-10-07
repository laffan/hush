/**
 * Reading notes kept in Zotero beside a PDF — a `NOTES.md` attached to
 * the same Zotero entry as the PDF. When one exists the PDF viewer's
 * right-hand shelf gains a Notes tab beside Annotations.
 *
 * Finding it: the reference cache already lists each item's attachments
 * by filename (zotero/api.js#fetchReferences), so the PDF's parent item
 * — the registry's `zoteroItemKey`, else the reference whose attachments
 * include the PDF — is searched there first. A NOTES.md attached after
 * the last reference download isn't in the cache, so with credentials
 * the parent's attachment list is also asked of Zotero once per session.
 *
 * Reading it: the file is fetched server-side (Zotero's `/file` 302s to
 * S3, whose CORS rejects the webview) by `fetch_zotero_note_text`, which
 * keeps a copy on this device. The copy is shown at once and the fresh
 * text replaces it when it differs — the notes are written while
 * reading, so they are fetched again on every open.
 */

import { loadReferences } from "../zotero.js";
import { getPdfMeta } from "../sync/pdf-sync.js";

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
const ZOTERO_API = "https://api.zotero.org";
const NOTES_NAME_RE = /^notes\.md$/i;

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

const isNotesAttachment = (a) => NOTES_NAME_RE.test(a?.filename || "") || NOTES_NAME_RE.test(a?.title || "");

// parentKey → the NOTES.md attachment key Zotero listed (null: none), so
// a session asks Zotero about a given item at most once.
const askedZotero = new Map();

async function notesFromZotero(parentKey, settings) {
  if (askedZotero.has(parentKey)) return askedZotero.get(parentKey);
  const userId = settings?.zoteroUserId;
  const apiKey = settings?.zoteroApiKey;
  if (!userId || !apiKey) return null;
  let key = null;
  try {
    const url = `${ZOTERO_API}/users/${userId}/items/${parentKey}/children?key=${apiKey}&format=json&itemType=attachment`;
    const resp = await fetch(url);
    if (!resp.ok) return null; // not remembered: a later open may get through
    const items = await resp.json();
    const hit = (items || []).find((it) => isNotesAttachment(it?.data));
    key = hit?.key || null;
  } catch (_) {
    return null;
  }
  askedZotero.set(parentKey, key);
  return key;
}

/** The attachment key of the NOTES.md beside the PDF `fileId` (linked
 *  to attachment `attKey`), or null. */
export async function findNotesAttachmentKey(fileId, attKey, settings) {
  let parentKey = getPdfMeta(fileId)?.zoteroItemKey || "";
  try {
    const refs = await loadReferences();
    const ref = (parentKey && refs.find((r) => r.key === parentKey))
      || (attKey && refs.find((r) => (r.attachments || []).some((a) => a.key === attKey)))
      || null;
    if (ref) {
      parentKey = ref.key;
      const att = (ref.attachments || []).find(isNotesAttachment);
      if (att) return att.key;
    }
  } catch (_) { /* no reference cache — Zotero may still know */ }
  return parentKey ? notesFromZotero(parentKey, settings) : null;
}

/**
 * Show the PDF's reading notes in `viewer` (its `setNotes`), if it has
 * any: the copy on this device first, then Zotero's when it differs.
 * `isLive()` says whether the viewer is still the one to paint.
 */
export async function showPdfNotes(viewer, fileId, attKey, settings, isLive = () => true) {
  if (!IS_TAURI || !viewer?.setNotes) return;
  const noteKey = await findNotesAttachmentKey(fileId, attKey, settings);
  if (!noteKey || !isLive()) return;
  let shown = null;
  try {
    shown = await tauriInvoke("load_zotero_note_text", { itemKey: noteKey });
    if (shown != null && isLive()) viewer.setNotes(shown);
  } catch (_) {}
  const userId = settings?.zoteroUserId;
  const apiKey = settings?.zoteroApiKey;
  if (!userId || !apiKey) return;
  try {
    const fresh = await tauriInvoke("fetch_zotero_note_text", { itemKey: noteKey, userId, apiKey });
    if (fresh !== shown && isLive()) viewer.setNotes(fresh);
  } catch (e) {
    console.warn("Couldn't fetch the PDF's NOTES.md from Zotero:", e);
  }
}
