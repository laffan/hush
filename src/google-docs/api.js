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
const DOCS_BASE = "https://docs.googleapis.com/v1";

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
 * Export a Google Doc as HTML. Returns the HTML string; the caller
 * runs it through `htmlToMarkdown` (extending if needed for export-
 * format quirks like CSS classes in `<style>` blocks).
 *
 * Drive's `files.export` doesn't actually support per-tab filtering
 * (the `tabIds` parameter is documented for `files.get` only) — for
 * multi-tab pulls go through the Docs API path in `tabs-sync.js`
 * instead, which walks each tab's `documentTab` via `docs-walker.js`.
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

/**
 * List a document's comments via the Drive Comments API. Each comment
 * carries its note `content`, `author`, the `quotedFileContent.value`
 * (the exact text the comment is anchored to — what we match against the
 * pulled markdown to place the anchor), `resolved` state, and any
 * `replies`. The `fields` parameter is mandatory for this endpoint.
 *
 * Comment sync is pull-only, so this is the only comment call we make —
 * Hush never writes comments back, which means Google's own anchor (and
 * therefore the selection range) is never disturbed by a push.
 */
export async function listComments(docId) {
  const params = new URLSearchParams({
    fields:
      "comments(id,content,resolved,author/displayName," +
      "quotedFileContent/value,replies(content,author/displayName))",
    pageSize: "100",
  });
  const resp = await gFetch(
    `${DRIVE_BASE}/files/${encodeURIComponent(docId)}/comments?${params}`
  );
  const data = await asJson(resp);
  return data.comments || [];
}

/** Build a `https://docs.google.com/document/d/{id}/edit` URL for the link bar's title chip. */
export function viewUrl(docId) {
  return `https://docs.google.com/document/d/${encodeURIComponent(docId)}/edit`;
}

/* ===== Docs API (tabs) =====
 *
 * The Docs API exposes the tab structure that the Drive HTML export
 * flattens. We use it for two jobs:
 *   1. Pull: enumerate every tab (id + title), then call Drive's
 *      `export` with `tabIds=<id>` so each tab's HTML can be converted
 *      independently and re-joined with `---Tab name---` markers.
 *   2. Push: rebuild the tab list to match the markdown's section
 *      structure — delete tabs that no longer exist, create new ones,
 *      rename mismatched titles. Content for the root tab is pushed
 *      via Drive's media upload (preserves HTML formatting); content
 *      for non-root tabs is pushed via batchUpdate insertText (plain
 *      text only — formatting in non-root tabs would require building
 *      out the full structured-insertion pipeline).
 */

/** Fetch the full document with all tab content via the Docs API.
 *  The pull path uses this to extract per-tab content directly —
 *  Drive's `files.export` doesn't filter by tab (`tabIds` is a
 *  `files.get` parameter, not an export one), so a multi-tab pull
 *  has to walk the Docs API's structured response instead. */
export async function getDocumentWithTabs(docId) {
  const params = new URLSearchParams({ includeTabsContent: "true" });
  const resp = await gFetch(
    `${DOCS_BASE}/documents/${encodeURIComponent(docId)}?${params}`
  );
  return asJson(resp);
}

/** Fetch the tab list for a document. Returns `[{ id, title, index }]`
 *  for each top-level tab in document order. Child tabs are flattened
 *  alongside their parents in the order Drive returns them. Thin
 *  wrapper over `getDocumentWithTabs` for the push path, which only
 *  needs the metadata, not each tab's body. */
export async function listTabs(docId) {
  const data = await getDocumentWithTabs(docId);
  const out = [];
  function walk(tabs) {
    if (!Array.isArray(tabs)) return;
    for (const t of tabs) {
      const p = t.tabProperties || {};
      out.push({
        id: p.tabId,
        title: p.title || "",
        index: typeof p.index === "number" ? p.index : out.length,
        nestingLevel: p.nestingLevel || 0,
      });
      if (Array.isArray(t.childTabs)) walk(t.childTabs);
    }
  }
  walk(data.tabs || []);
  return out;
}

/** Rename a tab. Used by the push pipeline when the markdown's tab
 *  title differs from the Doc's current tab title for the same slot.
 *  The Docs API request type is `updateDocumentTabProperties`; the
 *  target tab is specified by setting `tabId` inside `tabProperties`
 *  alongside the new field values. */
export async function renameTab(docId, tabId, title) {
  return batchUpdate(docId, [
    {
      updateDocumentTabProperties: {
        tabProperties: { tabId, title },
        fields: "title",
      },
    },
  ]);
}

/** Create a new tab at the given index with the given title. Returns
 *  the new tab's id from the batchUpdate response. The Docs API
 *  request type is `addDocumentTab`; the title, desired position, and
 *  optional `parentTabId` (for nested tabs) all live inside
 *  `tabProperties`. Pass `parentTabId: null` (or omit) for top-level
 *  tabs; pass a parent's tabId to nest. */
export async function createTab(docId, index, title, parentTabId = null) {
  const tabProperties = { title, index };
  if (parentTabId) tabProperties.parentTabId = parentTabId;
  const result = await batchUpdate(docId, [
    { addDocumentTab: { tabProperties } },
  ]);
  // The reply key matches the request key: `addDocumentTab` ->
  // `{ tabProperties: { tabId } }`. Older code called this
  // `createTab` so the JS wrapper keeps that name; only the wire
  // request and response are renamed.
  const reply = result.replies?.[0]?.addDocumentTab;
  return reply?.tabProperties?.tabId || null;
}

/** Delete the given tab. */
export async function deleteTab(docId, tabId) {
  return batchUpdate(docId, [{ deleteTab: { tabId } }]);
}

/** Replace a non-root tab's content with plain text. Walks the tab to
 *  find its current content range, deletes that range, then inserts the
 *  new text at the start. Formatting is not preserved — that's a
 *  tradeoff documented at the top of this section.
 *
 *  No field mask on the GET — see `listTabs` for the same reason. */
export async function replaceTabPlainText(docId, tabId, text) {
  const params = new URLSearchParams({ includeTabsContent: "true" });
  const resp = await gFetch(
    `${DOCS_BASE}/documents/${encodeURIComponent(docId)}?${params}`
  );
  const data = await asJson(resp);
  const tab = findTabById(data.tabs || [], tabId);
  const body = tab?.documentTab?.body;
  // The body always carries at least a sectionBreak at index 0, so the
  // safe content range starts at 1. End is the last child's endIndex
  // minus one (Docs requires the trailing newline to remain).
  let end = 1;
  if (body?.content?.length) {
    const last = body.content[body.content.length - 1];
    if (typeof last.endIndex === "number") end = last.endIndex - 1;
  }
  const requests = [];
  if (end > 1) {
    requests.push({
      deleteContentRange: {
        range: { tabId, startIndex: 1, endIndex: end },
      },
    });
  }
  const trimmed = (text || "").replace(/ /g, "");
  if (trimmed) {
    requests.push({
      insertText: {
        location: { tabId, index: 1 },
        text: trimmed,
      },
    });
  }
  if (!requests.length) return null;
  return batchUpdate(docId, requests);
}

function findTabById(tabs, tabId) {
  for (const t of tabs) {
    if (t.tabProperties?.tabId === tabId) return t;
    if (Array.isArray(t.childTabs)) {
      const found = findTabById(t.childTabs, tabId);
      if (found) return found;
    }
  }
  return null;
}

/** Generic Docs API batchUpdate caller — used by all the tab management
 *  helpers above. Throws on non-2xx with a readable message. */
export async function batchUpdate(docId, requests) {
  const resp = await gFetch(
    `${DOCS_BASE}/documents/${encodeURIComponent(docId)}:batchUpdate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    }
  );
  return asJson(resp);
}
