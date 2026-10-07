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
 * Links open in the system browser, never in the webview: every click
 * on one is cancelled, and only an http(s) or zotero: target is handed
 * on.
 */

export function attachNotesTab({ content, title }) {
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
  };
}
