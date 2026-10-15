/**
 * The PDF shelf's Notes tab — the reading notes kept beside the PDF in
 * its Zotero entry (zotero/zotero-notes.js finds and fetches them).
 *
 * The shelf's "Annotations" title becomes a pair of tabs the first time
 * notes arrive; until then nothing changes. The Notes tab shows the
 * markdown rendered (editor/google-docs/markdown-to-html.js, the
 * paste-friendly subset Hush writes), read-only — the notes are written
 * in Zotero's copy, and a later open fetches them again. Everything
 * under the annotations header (search, colour filter, list, Extract)
 * hides while Notes is showing, by one class on the shelf's content.
 *
 * Zotero page links — `[p. 22](zotero://open-pdf/library/items/KEY?page=22)`,
 * what zotero-helper's notes write — are drawn as small page pills,
 * tinted with the highlight's colour when the link names one of this
 * PDF's annotations. A press on a pill for this PDF moves the viewer to
 * the page (to the highlight, when it names one) instead of leaving for
 * Zotero; a link to another PDF still opens Zotero.
 *
 * Other links open in the system browser, never in the webview: every
 * click on one is cancelled, and only an http(s) or zotero: target is
 * handed on.
 */

const PAGE_ICON = `<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M9.5 1.5V5H13"/></svg>`;

/** A `zotero://open-pdf/…` link's parts, or null. */
export function parseZoteroPdfLink(href) {
  const m = /^zotero:\/\/open-pdf\/(?:library|groups\/\d+)\/items\/([A-Z0-9]+)(?:\?(.*))?$/i.exec(href || "");
  if (!m) return null;
  const params = new URLSearchParams(m[2] || "");
  const page = Number(params.get("page"));
  return {
    attKey: m[1],
    page: Number.isFinite(page) && page > 0 ? page : undefined,
    annotation: params.get("annotation") || undefined,
  };
}

/**
 * @param {object} o
 * @param {HTMLElement} o.content  The shelf's content column
 * @param {HTMLElement} o.title    Its "Annotations" title (becomes the tabs)
 * @param {function} [o.annotationColor] (key) => colour of this PDF's annotation, if any
 * @param {function} [o.followPdfLink]   (parsed link) => true when the viewer handled it
 */
export function attachNotesTab({ content, title, annotationColor, followPdfLink }) {
  let notesText = null;
  let active = "annotations";

  const tabs = document.createElement("div");
  tabs.className = "pdf-shelf-tabs";
  const tab = (label, key) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pdf-shelf-tab";
    b.dataset.tab = key;
    b.textContent = label;
    b.addEventListener("click", () => show(key));
    return b;
  };
  const annotTab = tab("Annotations", "annotations");
  const notesTab = tab("Notes", "notes");
  tabs.append(annotTab, notesTab);

  const body = document.createElement("div");
  body.className = "pdf-notes-body";
  body.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") || "";
    const pdfLink = parseZoteroPdfLink(href);
    if (pdfLink && followPdfLink?.(pdfLink)) return;
    if (!/^(https?|zotero):/i.test(href)) return;
    import("@tauri-apps/plugin-opener")
      .then((m) => m.openUrl(href))
      .catch(() => window.open(href, "_blank"));
  });
  content.appendChild(body);

  function show(key) {
    active = key === "notes" && notesText != null ? "notes" : "annotations";
    content.classList.toggle("notes-active", active === "notes");
    annotTab.classList.toggle("active", active === "annotations");
    notesTab.classList.toggle("active", active === "notes");
  }

  async function render() {
    const { markdownToHtml } = await import("../editor/google-docs/markdown-to-html.js");
    const text = notesText || "";
    body.innerHTML = text.trim() ? markdownToHtml(text) : '<div class="pdf-annot-shelf-empty">NOTES.md is empty</div>';
    pillify();
  }

  /** Zotero page links become pills, tinted with their highlight. */
  function pillify() {
    for (const a of body.querySelectorAll('a[href^="zotero://open-pdf/"]')) {
      const link = parseZoteroPdfLink(a.getAttribute("href"));
      if (!link) continue;
      a.classList.add("pdf-notes-pill");
      a.removeAttribute("style"); // the renderer's inline link colour
      a.title = link.page ? `Page ${link.page}` : "Open in Zotero";
      const color = link.annotation ? annotationColor?.(link.annotation) : undefined;
      if (color) a.style.setProperty("--pill-color", color);
      a.insertAdjacentHTML("afterbegin", `<span class="pdf-notes-pill-icon">${PAGE_ICON}</span>`);
    }
  }

  return {
    /** The notes' markdown, or null for none (the tabs go away). */
    setNotes(text) {
      notesText = typeof text === "string" ? text : null;
      if (notesText == null) {
        if (tabs.isConnected) tabs.replaceWith(title);
        body.innerHTML = "";
        show("annotations");
        return;
      }
      if (!tabs.isConnected) title.replaceWith(tabs);
      show(active);
      void render();
    },
    hasNotes: () => notesText != null,
    /** The annotations changed: re-tint the pills. */
    refresh: () => { if (notesText != null) void render(); },
  };
}
