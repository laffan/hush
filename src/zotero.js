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

async function saveReferences(refs) {
  cachedReferences = refs;
  if (IS_TAURI) {
    await tauriInvoke("save_zotero_references", { data: JSON.stringify(refs) });
  } else {
    localStorage.setItem("hush_zotero_refs", JSON.stringify(refs));
  }
}

async function loadReferences() {
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

function fuzzySearch(refs, query) {
  if (!query.trim()) return refs.slice(0, 50);
  const q = query.toLowerCase();
  const scored = [];
  for (const ref of refs) {
    const fields = [ref.title, ref.shortTitle, ref.authors, ref.year, ref.key];
    let bestScore = 0;
    for (const field of fields) {
      if (!field) continue;
      const text = field.toLowerCase();
      // Exact substring match
      const idx = text.indexOf(q);
      if (idx !== -1) {
        bestScore = Math.max(bestScore, 100 + (q.length / text.length) * 50);
        continue;
      }
      // Fuzzy match
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
  // If the user is editing a notebook text shape, the modal would blur the
  // inline textarea and commit the shape before a citation could be
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
    // No references — prompt user to set up in Settings
    if (notebookTextHandle) notebookTextHandle.resumeCommitOnBlur();
    showNoRefsMessage();
    return;
  }
  zoteroModal = document.createElement("div");
  zoteroModal.className = "zotero-modal";
  zoteroModal.innerHTML = `
    <div class="zotero-search-row">
      <input type="text" class="zotero-search-input" placeholder="Search Zotero library..." autofocus />
      <button class="zotero-close-btn" title="Close">\u00d7</button>
    </div>
    <div class="zotero-results"></div>
    <div class="zotero-detail hidden"></div>
  `;
  document.body.appendChild(zoteroModal);

  const input = zoteroModal.querySelector(".zotero-search-input");
  const resultsEl = zoteroModal.querySelector(".zotero-results");
  const detailEl = zoteroModal.querySelector(".zotero-detail");
  let selectedRef = null;

  function renderResults(query) {
    const results = fuzzySearch(refs, query);
    resultsEl.innerHTML = results.map(r => `
      <div class="zotero-result" data-key="${r.key}">
        <span class="zotero-result-title">${escHtml(r.shortTitle || r.title)}</span>
        <span class="zotero-result-meta">${escHtml(r.year)}${r.authors ? " \u2014 " + escHtml(r.authors) : ""}</span>
      </div>
    `).join("") || '<div class="zotero-empty">No results found.</div>';
    resultsEl.classList.remove("hidden");
    detailEl.classList.add("hidden");
    selectedRef = null;
  }

  function showDetail(ref) {
    selectedRef = ref;
    resultsEl.classList.add("hidden");
    const hasAttachments = ref.attachments && ref.attachments.length > 0;
    detailEl.innerHTML = `
      <div class="zotero-detail-header">
        <div class="zotero-detail-title">${escHtml(ref.title)}</div>
        <div class="zotero-detail-meta">${escHtml(ref.year)}${ref.authors ? " \u2014 " + escHtml(ref.authors) : ""}</div>
      </div>
      <div class="zotero-link-options">
        <label class="zotero-option">
          <input type="radio" name="zotero-target" value="item" checked />
          <span>Item</span>
          <a class="zotero-preview-link" href="zotero://select/library/items/${ref.key}" title="Open in Zotero">\u2197</a>
        </label>
        ${hasAttachments ? ref.attachments.map(att => `
          <label class="zotero-option">
            <input type="radio" name="zotero-target" value="att-${att.key}" data-is-pdf="${att.isPdf}" />
            <span>${escHtml(att.title)}</span>
            <a class="zotero-preview-link" href="zotero://${att.isPdf ? "open-pdf" : "select"}/library/items/${att.key}" title="Open in Zotero">\u2197</a>
          </label>
        `).join("") : ""}
      </div>
      <div class="zotero-page-row hidden">
        <label>Page: <input type="number" class="zotero-page-input" min="1" placeholder="#" /></label>
      </div>
      <div class="zotero-actions">
        <button class="zotero-back-btn">Back</button>
        <button class="zotero-insert-btn">Insert link</button>
      </div>
    `;
    detailEl.classList.remove("hidden");

    // Show page input when a PDF attachment is selected
    detailEl.querySelectorAll('input[name="zotero-target"]').forEach(radio => {
      radio.addEventListener("change", () => {
        const pageRow = detailEl.querySelector(".zotero-page-row");
        const isPdf = radio.dataset.isPdf === "true";
        pageRow.classList.toggle("hidden", !isPdf);
      });
    });

    detailEl.querySelector(".zotero-back-btn").addEventListener("click", () => {
      renderResults(input.value);
    });

    detailEl.querySelector(".zotero-insert-btn").addEventListener("click", () => {
      insertLink(view, ref, detailEl);
    });
  }

  function insertLink(view, ref, detailEl) {
    const selected = detailEl.querySelector('input[name="zotero-target"]:checked');
    if (!selected) return;
    const val = selected.value;
    let url, title = ref.title;
    if (val === "item") {
      url = `zotero://select/library/items/${ref.key}`;
    } else {
      const attKey = val.replace("att-", "");
      const isPdf = selected.dataset.isPdf === "true";
      const pageInput = detailEl.querySelector(".zotero-page-input");
      const page = pageInput ? parseInt(pageInput.value, 10) : NaN;
      if (isPdf) {
        url = `zotero://open-pdf/library/items/${attKey}`;
        if (!isNaN(page) && page > 0) url += `?page=${page}`;
      } else {
        url = `zotero://select/library/items/${attKey}`;
      }
    }
    const linkText = `[${title}](${url})`;
    if (notebookTextHandle) {
      // Notebook text shape — insert into the textarea, then refocus it
      // and drop the commit-suspend so a later blur commits normally.
      notebookTextHandle.insertAtSelection(linkText);
      closeZoteroModal();
      notebookTextHandle.resumeCommitOnBlur();
      notebookTextHandle.focus();
    } else {
      const cursor = view.state.selection.main.head;
      view.dispatch({ changes: { from: cursor, insert: linkText } });
      closeZoteroModal();
      view.focus();
    }
  }

  function restoreFocusToSource() {
    if (notebookTextHandle) {
      notebookTextHandle.resumeCommitOnBlur();
      notebookTextHandle.focus();
    } else {
      view.focus();
    }
  }

  // Event listeners
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

  // Close on outside click
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
