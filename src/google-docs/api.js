/**
 * Drive + Docs API client. Thin wrappers around `gFetch` from auth.js —
 * each function is a single endpoint call, error-mapped to readable
 * exceptions so callers can surface them in toasts / status text.
 *
 * Supported operations (the minimum Phase 2 needs):
 *   - listDocuments(query?, pageSize?)        Drive: list user's GDocs (optionally filtered)
 *   - getDocumentMeta(docId)                  Drive: title, modifiedTime, headRevisionId
 *   - exportAsHtml(docId)                     Drive: export GDoc to HTML
 *   - createDocumentFromHtml(title, html)     Drive: new GDoc seeded from HTML
 *   - replaceDocumentContent(docId, html)     Drive media-upload: overwrite a GDoc's body
 *
 * Push/pull both ride the same HTML-roundtrip route Phase 1 used for the
 * paste/copy commands. Drive does the HTML → GDoc structural conversion
 * server-side (via `convert: true` on create, or via the `mimeType` of
 * the existing file on media-upload).
 */
import { gFetch } from "./auth.js";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

function err(prefix, resp, body) {
  const detail = body?.error?.message || body?.error || `HTTP ${resp.status}`;
  return new Error(`${prefix}: ${detail}`);
}

async function asJson(resp) {
  if (!resp.ok) {
    let body = null;
    try { body = await resp.json(); } catch (_) {}
    throw err(`Google API ${resp.status}`, resp, body);
  }
  return resp.json();
}

async function asText(resp) {
  if (!resp.ok) {
    let body = null;
    try { body = await resp.json(); } catch (_) {}
    throw err(`Google API ${resp.status}`, resp, body);
  }
  return resp.text();
}

/**
 * List the user's Google Docs. Optional `query` is matched against the
 * file name via Drive's `q` parameter `fullText contains` operator —
 * partial substring search like the picker uses.
 */
export async function listDocuments({ query = "", pageSize = 50 } = {}) {
  const q = ["mimeType='application/vnd.google-apps.document'", "trashed=false"];
  if (query && query.trim()) {
    // Drive's name 'contains' behaves like prefix-token match; users
    // expect substring, so use fullText for free-form queries.
    const safe = query.replace(/'/g, "\\'");
    q.push(`(name contains '${safe}' or fullText contains '${safe}')`);
  }
  const params = new URLSearchParams({
    q: q.join(" and "),
    pageSize: String(pageSize),
    fields: "files(id,name,modifiedTime,owners(displayName,emailAddress))",
    orderBy: "modifiedTime desc",
  });
  const resp = await gFetch(`${DRIVE_BASE}/files?${params}`);
  const data = await asJson(resp);
  return data.files || [];
}

export async function getDocumentMeta(docId) {
  const params = new URLSearchParams({
    fields: "id,name,modifiedTime,headRevisionId,webViewLink,trashed",
  });
  const resp = await gFetch(`${DRIVE_BASE}/files/${encodeURIComponent(docId)}?${params}`);
  return asJson(resp);
}

/**
 * Export a Google Doc as HTML. Returns the HTML string; the caller runs
 * it through `htmlToMarkdown` (extending if needed for export-format
 * quirks like CSS classes in `<style>` blocks).
 */
export async function exportAsHtml(docId) {
  const params = new URLSearchParams({ mimeType: "text/html" });
  const resp = await gFetch(
    `${DRIVE_BASE}/files/${encodeURIComponent(docId)}/export?${params}`
  );
  return asText(resp);
}

/**
 * Create a new Google Doc by uploading HTML and converting it
 * server-side. Single-call multipart upload — body part is JSON metadata
 * (name + mimeType: document → triggers conversion), second part is the
 * HTML content with text/html.
 */
export async function createDocumentFromHtml(title, html) {
  const boundary = `hush_${crypto.randomUUID().replace(/-/g, "")}`;
  const meta = JSON.stringify({
    name: title || "Untitled",
    mimeType: "application/vnd.google-apps.document",
  });
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    meta,
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const resp = await gFetch(
    `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,webViewLink,modifiedTime,headRevisionId`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  return asJson(resp);
}

/**
 * Overwrite an existing Google Doc's content with new HTML. Drive's
 * media upload converts HTML → GDoc structural format because the
 * file's mimeType is already `application/vnd.google-apps.document`.
 */
export async function replaceDocumentContent(docId, html) {
  const params = new URLSearchParams({
    uploadType: "media",
    fields: "id,name,modifiedTime,headRevisionId",
  });
  const resp = await gFetch(
    `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(docId)}?${params}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "text/html; charset=UTF-8" },
      body: html,
    }
  );
  return asJson(resp);
}

/** Build a `https://docs.google.com/document/d/{id}/edit` URL for the link bar's title chip. */
export function viewUrl(docId) {
  return `https://docs.google.com/document/d/${encodeURIComponent(docId)}/edit`;
}
