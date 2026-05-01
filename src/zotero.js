/**
 * Zotero integration — search modal, API client, reference management.
 * Fetches references via Zotero Web API and stores them locally for offline use.
 * Triggered by Cmd+Shift+L or the sidebar book icon.
 */

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
const ZOTERO_API = "https://api.zotero.org";

let cachedReferences = null;
let zoteroModal = null;

// ===== API Client =====

export async function testZoteroConnection(userId, apiKey) {
  const url = `${ZOTERO_API}/users/${userId}/items?key=${apiKey}&format=json&limit=1`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return true;
}

export async function downloadZoteroReferences(userId, apiKey, onProgress) {
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
  const attCountResp = await fetch(attUrl);
  const totalAtt = parseInt(attCountResp.headers.get("Total-Results") || "0", 10);
  const attPages = Math.ceil(totalAtt / pageSize) || 1;
  for (let page = 0; page < attPages; page++) {
    const start = page * pageSize;
    onProgress(`Fetching attachments (${start + 1}–${Math.min(start + pageSize, totalAtt)} of ${totalAtt})...`, 0.6 + (page / attPages) * 0.2);
    const url = `${ZOTERO_API}/users/${userId}/items?key=${apiKey}&format=json&itemType=attachment&limit=${pageSize}&start=${start}`;
    const resp = await fetch(url);
    if (!resp.ok) break;
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
      isPdf: (att.data.contentType || "").includes("pdf"),
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
      return {
        key: item.key,
        title: d.title || "Untitled",
        shortTitle: d.shortTitle || "",
        authors: creators,
        year,
        itemType: d.itemType,
        attachments: attByParent[item.key] || [],
      };
    });

  onProgress("Done!", 1);
  return references;
}

// ===== Storage =====

async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export async function loadReferences() {
  if (cachedReferences) return cachedReferences;
  if (IS_TAURI) {
    const data = await tauriInvoke("load_zotero_references");
    cachedReferences = JSON.parse(data);
  } else {
    const stored = localStorage.getItem("hush_zotero_refs");
    cachedReferences = stored ? JSON.parse(stored) : [];
  }
  return cachedReferences;
}

export function clearCache() {
  cachedReferences = null;
}

// ===== Fuzzy Search =====

export function fuzzySearch(refs, query) {
  if (!query.trim()) return refs.slice(0, 50);
  const q = query.toLowerCase();
  const scored = [];
  for (const ref of refs) {
    const fields = [ref.title, ref.shortTitle, ref.authors, ref.year, ref.key];
    let bestScore = 0;
    for (const field of fields) {
      if (!field) continue;
      const text = field.toLowerCase();
      const idx = text.indexOf(q);
      if (idx !== -1) {
        bestScore = Math.max(bestScore, 100 + (q.length / text.length) * 50);
        continue;
      }
      let qi = 0, consecutive = 0, score = 0;
      for (let i = 0; i < text.length && qi < q.length; i++) {
        if (text[i] === q[qi]) {
          qi++;
          consecutive++;
          score += consecutive * 2;
        } else {
          consecutive = 0;
        }
      }
      if (qi === q.length) bestScore = Math.max(bestScore, score);
    }
    if (bestScore > 0) scored.push({ ref, score: bestScore });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 50).map(s => s.ref);
}

// ===== Modal =====

export async function openZoteroModal(view, state) {
  if (zoteroModal) { closeZoteroModal(); return; }
  // If the user is editing a notebook text shape, the modal would blur
  // the inline textarea and commit the shape before a citation could be
  // inserted. Capture a handle to that editor (and suspend its
  // commit-on-blur) so the insert flow can route back into it.
  let notebookTextHandle = null;
  try {
    const { getActiveNotebookTextEditor } = await import("./notebook/ui/text-editor.ts");
    notebookTextHandle = getActiveNotebookTextEditor();
    if (notebookTextHandle) notebookTextHandle.suspendCommitOnBlur();
  } catch (_) { /* notebook module not loaded — doc-only context */ }

  // Always reload from disk — references may have been updated in the settings window
  cachedReferences = null;
  const refs = await loadReferences();
  if (!refs || refs.length === 0) {
    if (notebookTextHandle) notebookTextHandle.resumeCommitOnBlur();
    showNoRefsMessage();
    return;
  }
  zoteroModal = document.createElement("div");
  zoteroModal.className = "zotero-modal";
  zoteroModal.innerHTML = `
    <div class="zotero-search-row">
      <input type="text" class="zotero-search-input" placeholder="Search Zotero library..." autofocus />
      <button class="zotero-close-btn" title="Close">×</button>
    </div>
    <div class="zotero-results"></div>
    <div class="zotero-detail hidden"></div>
  `;
  document.body.appendChild(zoteroModal);

  const input = zoteroModal.querySelector(".zotero-search-input");
  const resultsEl = zoteroModal.querySelector(".zotero-results");
  const detailEl = zoteroModal.querySelector(".zotero-detail");

  function renderResults(query) {
    const results = fuzzySearch(refs, query);
    resultsEl.innerHTML = results.map(r => `
      <div class="zotero-result" data-key="${r.key}">
        <span class="zotero-result-title">${escHtml(r.shortTitle || r.title)}</span>
        <span class="zotero-result-meta">${escHtml(r.year)}${r.authors ? " — " + escHtml(r.authors) : ""}</span>
      </div>
    `).join("") || '<div class="zotero-empty">No results found.</div>';
    resultsEl.classList.remove("hidden");
    detailEl.classList.add("hidden");
  }

  function showDetail(ref) {
    resultsEl.classList.add("hidden");
    const hasAttachments = ref.attachments && ref.attachments.length > 0;
    detailEl.innerHTML = `
      <div class="zotero-detail-header">
        <div class="zotero-detail-title">${escHtml(ref.title)}</div>
        <div class="zotero-detail-meta">${escHtml(ref.year)}${ref.authors ? " — " + escHtml(ref.authors) : ""}</div>
      </div>
      <div class="zotero-link-options">
        <label class="zotero-option">
          <input type="radio" name="zotero-target" value="item" checked />
          <span>Item</span>
          <a class="zotero-preview-link" href="zotero://select/library/items/${ref.key}" title="Open in Zotero">↗</a>
        </label>
        ${hasAttachments ? ref.attachments.map(att => `
          <label class="zotero-option">
            <input type="radio" name="zotero-target" value="att-${att.key}" data-is-pdf="${att.isPdf}" />
            <span>${escHtml(att.title)}</span>
            <a class="zotero-preview-link" href="zotero://${att.isPdf ? "open-pdf" : "select"}/library/items/${att.key}" title="Open in Zotero">↗</a>
          </label>
        `).join("") : ""}
      </div>
      <div class="zotero-page-row hidden">
        <label>Page: <input type="number" class="zotero-page-input" min="1" placeholder="1" value="1" /></label>
      </div>
      <div class="zotero-snapshot-row hidden">
        <label><input type="checkbox" class="zotero-snapshot-check" /> Insert snapshot</label>
      </div>
      <div class="zotero-actions">
        <button class="zotero-back-btn">Back</button>
        <button class="zotero-insert-btn">Insert link</button>
      </div>
      <div class="zotero-status zotero-insert-status"></div>
    `;
    detailEl.classList.remove("hidden");

    detailEl.querySelectorAll('input[name="zotero-target"]').forEach(radio => {
      radio.addEventListener("change", () => {
        const isPdf = radio.dataset.isPdf === "true";
        detailEl.querySelector(".zotero-page-row").classList.toggle("hidden", !isPdf);
        detailEl.querySelector(".zotero-snapshot-row").classList.toggle("hidden", !isPdf);
      });
    });

    detailEl.querySelector(".zotero-back-btn").addEventListener("click", () => {
      renderResults(input.value);
    });

    detailEl.querySelector(".zotero-insert-btn").addEventListener("click", () => {
      handleInsert(view, ref, detailEl, state, notebookTextHandle).catch((e) => {
        const status = detailEl.querySelector(".zotero-insert-status");
        if (status) {
          status.textContent = "Insert failed: " + (e?.message || e);
          status.className = "zotero-status zotero-insert-status error";
        }
      });
    });
  }

  function restoreFocusToSource() {
    if (notebookTextHandle) {
      notebookTextHandle.resumeCommitOnBlur();
      notebookTextHandle.focus();
    } else if (view) {
      view.focus();
    }
  }

  input.addEventListener("input", () => renderResults(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeZoteroModal(); restoreFocusToSource(); }
  });

  resultsEl.addEventListener("click", (e) => {
    const row = e.target.closest(".zotero-result");
    if (!row) return;
    const key = row.dataset.key;
    const ref = refs.find(r => r.key === key);
    if (ref) showDetail(ref);
  });

  zoteroModal.querySelector(".zotero-close-btn").addEventListener("click", () => {
    closeZoteroModal();
    restoreFocusToSource();
  });

  setTimeout(() => {
    document.addEventListener("mousedown", function handler(e) {
      if (zoteroModal && !zoteroModal.contains(e.target)) {
        closeZoteroModal();
        document.removeEventListener("mousedown", handler);
        restoreFocusToSource();
      }
    });
  }, 0);

  renderResults("");
  input.focus();
}

// ===== Insert flow =====

/** Build the citation link from the user's choice in the detail panel. */
function buildLink(ref, detailEl) {
  const selected = detailEl.querySelector('input[name="zotero-target"]:checked');
  if (!selected) return null;
  const val = selected.value;
  let url;
  let attKey = null;
  let isPdf = false;
  let page = NaN;
  if (val === "item") {
    url = `zotero://select/library/items/${ref.key}`;
  } else {
    attKey = val.replace("att-", "");
    isPdf = selected.dataset.isPdf === "true";
    const pageInput = detailEl.querySelector(".zotero-page-input");
    page = pageInput ? parseInt(pageInput.value, 10) : NaN;
    if (isPdf) {
      url = `zotero://open-pdf/library/items/${attKey}`;
      if (!isNaN(page) && page > 0) url += `?page=${page}`;
    } else {
      url = `zotero://select/library/items/${attKey}`;
    }
  }
  return {
    text: `[${ref.title}](${url})`,
    isPdf,
    attKey,
    page: isNaN(page) || page <= 0 ? 1 : page,
  };
}

async function handleInsert(view, ref, detailEl, state, notebookTextHandle) {
  const link = buildLink(ref, detailEl);
  if (!link) return;
  const snapshotCheck = detailEl.querySelector(".zotero-snapshot-check");
  const wantSnapshot = !!(link.isPdf && snapshotCheck && snapshotCheck.checked);
  const status = detailEl.querySelector(".zotero-insert-status");

  let snapshot = null;
  if (wantSnapshot) {
    if (status) {
      status.textContent = "Downloading and rendering PDF...";
      status.className = "zotero-status zotero-insert-status";
    }
    snapshot = await renderSnapshot(state, ref, link.attKey, link.page);
  }

  const ctx = await resolveInsertContext(view, notebookTextHandle, state);
  if (ctx.kind === "notebook-edit") {
    // Notebook: image lives only as the embedded dataUrl on the shape.
    // It rides along inside the notebook's JSON envelope and only ends
    // up in the global Images folder if the user Cmd-drags it into a
    // doc later.
    insertIntoNotebookEdit(notebookTextHandle, link.text, snapshot);
  } else if (ctx.kind === "notebook-canvas") {
    insertIntoNotebookCanvas(ctx.canvas, link.text, snapshot);
  } else if (ctx.kind === "doc") {
    // Doc: persist to the global Images store so the markdown ref
    // resolves and the binary syncs with Dropbox.
    let docSnapshot = snapshot;
    if (snapshot) {
      const saved = await state.createImageFromDataUrl(snapshot.dataUrl, snapshot.filename);
      if (saved) docSnapshot = { ...snapshot, filename: saved.filename, alt: saved.alt };
    }
    insertIntoDoc(view, link.text, docSnapshot);
  }
  closeZoteroModal();
  if (ctx.kind === "notebook-edit") {
    notebookTextHandle.resumeCommitOnBlur();
    notebookTextHandle.focus();
  } else if (ctx.kind === "doc" && view) {
    view.focus();
  }
}

/** Decide which surface this insert is targeting.
 *
 * Priority: an active inline text-shape edit always wins. After that,
 * an open notebook (`state.currentNotebookFileId`) takes precedence
 * over the CodeMirror editor — the doc editor stays mounted while a
 * notebook is open, so a non-null `view` doesn't mean we're looking
 * at a doc. */
async function resolveInsertContext(view, notebookTextHandle, state) {
  if (notebookTextHandle) return { kind: "notebook-edit" };
  if (state && state.currentNotebookFileId) {
    try {
      const { getCanvasInstance } = await import("./notebook/notebook-bridge.js");
      const canvas = getCanvasInstance();
      if (canvas) return { kind: "notebook-canvas", canvas };
    } catch (_) { /* notebook bridge unavailable */ }
  }
  if (view) return { kind: "doc" };
  return { kind: "none" };
}

function insertIntoDoc(view, text, snapshot) {
  if (!view) return;
  const cursor = view.state.selection.main.head;
  let payload = text;
  if (snapshot) {
    // Filenames auto-suffixed on collision contain spaces (e.g.
    // "Lethe-p1 2.png"). The doc image decorator requires URLs with
    // spaces or parens to be wrapped in double quotes — keep parity
    // with the convention documented in IMAGE_MD_RE.
    const url = /[\s()"]/.test(snapshot.filename)
      ? `"${snapshot.filename}"`
      : snapshot.filename;
    payload += `\n\n![${snapshot.alt}](${url})\n`;
  }
  view.dispatch({ changes: { from: cursor, insert: payload } });
}

function insertIntoNotebookEdit(handle, text, snapshot) {
  handle.insertAtSelection(text);
  if (!snapshot) return;
  // Place the image to the right of the text shape currently being
  // edited. We use the editing position + the textarea's current
  // measured width so the image sits flush with the text shape.
  const state = handle.state;
  const editing = state.editingText;
  if (!editing) return;
  const taWidth = handle.textarea.offsetWidth || 0;
  const zoom = state.camera?.zoom || 1;
  const widthInCanvas = taWidth / zoom;
  const gap = 24;
  const pos = {
    x: editing.position.x + widthInCanvas + gap,
    y: editing.position.y,
  };
  state.addImageShape(snapshot.dataUrl, snapshot.filename, snapshot.width, snapshot.height, {
    x: pos.x + (snapshot.displayWidth || snapshot.width) / 2,
    y: pos.y + (snapshot.displayHeight || snapshot.height) / 2,
  });
  scaleLastImageShape(state, snapshot);
}

function insertIntoNotebookCanvas(canvas, text, snapshot) {
  const state = canvas.state;
  if (!snapshot) {
    state.addTextShapeAtCenter(text);
    return;
  }
  // Drop a text shape and an image side-by-side, both centered as a
  // group in the viewport.
  const center = screenCenterToCanvas(state);
  const gap = 24;
  // Text shape — left of center.
  state.addTextShapeAtPosition(text, {
    x: center.x - (snapshot.displayWidth || snapshot.width) / 2 - gap - 200,
    y: center.y,
  });
  // Image shape — right of center.
  state.addImageShape(snapshot.dataUrl, snapshot.filename, snapshot.width, snapshot.height, {
    x: center.x + gap + (snapshot.displayWidth || snapshot.width) / 2,
    y: center.y,
  });
  scaleLastImageShape(state, snapshot);
}

function screenCenterToCanvas(state) {
  const cam = state.camera || { x: 0, y: 0, zoom: 1 };
  const w = window.innerWidth || 800;
  const h = window.innerHeight || 600;
  return {
    x: (w / 2 - cam.x) / cam.zoom,
    y: (h / 2 - cam.y) / cam.zoom,
  };
}

/** addImageShape sizes the shape to fit a 400px max bounding box at
 *  source resolution — for snapshots we want a specific display height
 *  (300px by default). Walk back the most recent image and rescale. */
function scaleLastImageShape(state, snapshot) {
  if (!snapshot.displayHeight) return;
  const shapes = state.shapes;
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.type !== "image" || s.dataUrl !== snapshot.dataUrl) continue;
    const aspect = s.width / Math.max(s.height, 1);
    const newH = snapshot.displayHeight;
    const newW = newH * aspect;
    const cx = s.position.x + s.width / 2;
    const cy = s.position.y + s.height / 2;
    state.shapes = shapes.map((sh, j) => j === i
      ? { ...sh, width: newW, height: newH, position: { x: cx - newW / 2, y: cy - newH / 2 } }
      : sh);
    state.notify("shapes");
    return;
  }
}

async function renderSnapshot(state, ref, attKey, page) {
  const userId = state.settings?.zoteroUserId;
  const apiKey = state.settings?.zoteroApiKey;
  if (!userId || !apiKey) throw new Error("Zotero credentials missing");
  const renderHeight = state.settings?.zoteroSnapshotRenderHeight || 1500;
  const displayHeight = state.settings?.zoteroSnapshotDisplayHeight || 300;
  // Stored 1–100; toDataURL takes 0–1.
  const rawQuality = state.settings?.zoteroSnapshotQuality ?? 90;
  const quality = Math.min(100, Math.max(1, rawQuality)) / 100;
  const { renderPdfPage } = await import("./zotero-snapshot.js");
  const rendered = await renderPdfPage(attKey, userId, apiKey, page, renderHeight, quality);

  const baseName = sanitizeFilename(ref.shortTitle || ref.title || "snapshot");
  const filename = `${baseName}-p${page}.webp`;
  const aspect = rendered.width / Math.max(rendered.height, 1);
  return {
    filename,
    alt: baseName,
    dataUrl: rendered.dataUrl,
    width: rendered.width,
    height: rendered.height,
    displayHeight,
    displayWidth: displayHeight * aspect,
  };
}

function sanitizeFilename(s) {
  return (s || "snapshot")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60) || "snapshot";
}

function closeZoteroModal() {
  if (zoteroModal) {
    zoteroModal.remove();
    zoteroModal = null;
  }
}

function showNoRefsMessage() {
  const msg = document.createElement("div");
  msg.className = "zotero-modal zotero-no-refs";
  msg.innerHTML = `
    <div class="zotero-no-refs-content">
      <p>No Zotero references found.</p>
      <p>Set up your Zotero API credentials and download references in Settings > Zotero.</p>
      <button class="zotero-dismiss-btn">OK</button>
    </div>
  `;
  document.body.appendChild(msg);
  msg.querySelector(".zotero-dismiss-btn").addEventListener("click", () => msg.remove());
  setTimeout(() => {
    document.addEventListener("mousedown", function handler(e) {
      if (!msg.contains(e.target)) { msg.remove(); document.removeEventListener("mousedown", handler); }
    });
  }, 0);
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}
