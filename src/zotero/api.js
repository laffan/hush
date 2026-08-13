/**
 * Zotero Web API client — the network half of the integration.
 *
 * Pure fetching: nothing here touches the local caches (see the storage
 * section of `../zotero.js`), so the download flow stays testable and
 * this module has no dependency on where the results end up.
 */

const ZOTERO_API = "https://api.zotero.org";

export async function testZoteroConnection(userId, apiKey) {
  const url = `${ZOTERO_API}/users/${userId}/items?key=${apiKey}&format=json&limit=1`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return true;
}

/** Fetch a Zotero API page, retrying transient failures (the API rate-
 *  limits with 429/503 and can hiccup on large libraries). Returns the
 *  Response so callers can read headers; throws only after exhausting
 *  retries so an incomplete fetch surfaces instead of silently dropping
 *  data. */
async function zoteroFetch(url, tries = 4) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return resp;
      // 429 / 5xx are transient; 4xx (bad key etc.) won't improve.
      if (resp.status !== 429 && resp.status < 500) throw new Error(`HTTP ${resp.status}`);
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 400 * Math.pow(2, i))); // 0.4s, 0.8s, 1.6s
  }
  throw lastErr || new Error("Zotero fetch failed");
}

/** Whether a Zotero attachment's data describes a PDF. Prefers the
 *  content type but falls back to the filename / title extension, since
 *  older imports and linked files sometimes carry an empty or unexpected
 *  `contentType`. */
function isPdfAttachment(d) {
  const ct = (d?.contentType || "").toLowerCase();
  if (ct.includes("pdf")) return true;
  const name = (d?.filename || d?.title || "").toLowerCase();
  return name.endsWith(".pdf");
}

/** Every collection (Zotero's word for a folder) in the library, as
 *  `{ key, name, parentKey }`. Nesting is by `parentKey`; a top-level
 *  collection has `null`. Paginated like everything else in this API. */
export async function fetchCollections(userId, apiKey) {
  const pageSize = 100;
  const out = [];
  for (let start = 0; ; start += pageSize) {
    const url = `${ZOTERO_API}/users/${userId}/collections?key=${apiKey}&format=json&limit=${pageSize}&start=${start}`;
    const resp = await zoteroFetch(url);
    const batch = await resp.json();
    for (const c of batch) {
      if (!c?.key) continue;
      out.push({
        key: c.key,
        name: c.data?.name || "Untitled",
        parentKey: c.data?.parentCollection || null,
      });
    }
    if (batch.length < pageSize) break;
  }
  return out;
}

export async function fetchReferences(userId, apiKey, onProgress) {
  // Step 1: Get total count of top-level items
  onProgress("Checking library size...", 0);
  const countUrl = `${ZOTERO_API}/users/${userId}/items/top?key=${apiKey}&format=json&limit=1`;
  const countResp = await fetch(countUrl);
  if (!countResp.ok) throw new Error(`HTTP ${countResp.status}`);
  const totalItems = parseInt(countResp.headers.get("Total-Results") || "0", 10);

  // Step 2: Fetch all top-level items (paginated, 100 per page)
  const items = [];
  const pageSize = 100;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  for (let page = 0; page < totalPages; page++) {
    const start = page * pageSize;
    onProgress(`Fetching items (${start + 1}–${Math.min(start + pageSize, totalItems)} of ${totalItems})...`, (page / totalPages) * 0.6);
    const url = `${ZOTERO_API}/users/${userId}/items/top?key=${apiKey}&format=json&limit=${pageSize}&start=${start}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} at page ${page}`);
    const batch = await resp.json();
    items.push(...batch);
  }

  // Step 3: Fetch all attachment items
  onProgress("Fetching attachments...", 0.6);
  const attachments = [];
  const attUrl = `${ZOTERO_API}/users/${userId}/items?key=${apiKey}&format=json&itemType=attachment&limit=1`;
  const attCountResp = await zoteroFetch(attUrl);
  const totalAtt = parseInt(attCountResp.headers.get("Total-Results") || "0", 10);
  const attPages = Math.ceil(totalAtt / pageSize) || 1;
  for (let page = 0; page < attPages; page++) {
    const start = page * pageSize;
    onProgress(`Fetching attachments (${start + 1}–${Math.min(start + pageSize, totalAtt)} of ${totalAtt})...`, 0.6 + (page / attPages) * 0.2);
    const url = `${ZOTERO_API}/users/${userId}/items?key=${apiKey}&format=json&itemType=attachment&limit=${pageSize}&start=${start}`;
    // Retry rather than `break` — a single transient page failure used to
    // silently drop every attachment after it, so items further down the
    // library lost their PDFs and the menu couldn't offer "Download to Hush".
    const resp = await zoteroFetch(url);
    attachments.push(...(await resp.json()));
  }

  // Step 4: Build reference objects
  onProgress("Processing references...", 0.85);
  const attByParent = {};
  for (const att of attachments) {
    const parent = att.data?.parentItem;
    if (!parent) continue;
    if (!attByParent[parent]) attByParent[parent] = [];
    attByParent[parent].push({
      key: att.key,
      title: att.data.title || "Attachment",
      filename: att.data.filename || "",
      contentType: att.data.contentType || "",
      isPdf: isPdfAttachment(att.data),
    });
  }

  const references = items
    .filter(item => item.data && item.data.itemType !== "attachment" && item.data.itemType !== "note")
    .map(item => {
      const d = item.data;
      const creators = (d.creators || [])
        .map(c => c.lastName ? `${c.lastName}, ${(c.firstName || "")[0] || ""}`.trim() : c.name || "")
        .filter(Boolean)
        .join("; ");
      const year = (d.date || "").match(/\d{4}/)?.[0] || "";
      // First author's last name powers the `title (author)` format and the
      // citekey fallback when Better BibTeX hasn't supplied one.
      const firstCreator = (d.creators || []).find(c => c.lastName || c.name);
      const firstAuthor = firstCreator
        ? (firstCreator.lastName || firstCreator.name || "")
        : "";
      // Better BibTeX surfaces the citation key either as a top-level
      // `citationKey` field on newer Zotero APIs or stuffed into `extra`
      // as `Citation Key: foo2020`. Fall back to a slug otherwise.
      let citekey = item.data.citationKey || d.citationKey || "";
      if (!citekey && d.extra) {
        const m = /(?:^|\n)\s*Citation Key\s*:\s*(\S+)/i.exec(d.extra);
        if (m) citekey = m[1];
      }
      if (!citekey) {
        const slug = (firstAuthor || "ref").toLowerCase().replace(/[^a-z0-9]+/g, "");
        citekey = slug + (year || "");
      }
      return {
        key: item.key,
        title: d.title || "Untitled",
        shortTitle: d.shortTitle || "",
        authors: creators,
        firstAuthor,
        citekey,
        year,
        itemType: d.itemType,
        // Collection keys this item belongs to — what the library
        // browser filters on. Zotero items can sit in several folders
        // at once, hence an array.
        collections: Array.isArray(d.collections) ? d.collections : [],
        attachments: attByParent[item.key] || [],
      };
    });

  // Deliberately not "Done!" — the caller has the collections fetch
  // and the local save still to run.
  onProgress("Processing references...", 0.9);
  return references;
}
